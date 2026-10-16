// agent-insights.ts — Durable, queryable record of what the agent actually did.
//
// Seven Prisma models shipped in the schema with zero code references. Rather
// than delete them, this module gives each one a real job:
//
//   Task                + ToolCall           per-task record + its tool-call tree
//   PipelineStep                               per-stage timing/state for a run
//   AgentTaskDependency                       the dependency edge between tasks
//   SonaTrajectory                            a full run trajectory
//   SonaPattern                               tool sequences that WORKED (learned)
//   VectorMemoryEntry                         semantic memory for similar-task recall
//
// Design constraints:
//   - NOTHING here is on the hot path. Every writer is best-effort: a failure
//     must never fail the run that produced the data, so all writes are
//     `.catch()`-swallowed and return a status instead of throwing.
//   - Vector writes are best-effort too. `embeddings.ts` loads an optional
//     ~25 MB ONNX model; when it is unavailable we store the row WITHOUT a
//     vector so recall degrades to recency rather than the write being lost.
//   - The pattern miner only promotes a sequence after MIN_SAMPLES real
//     trajectories, so "pattern" means something measured, not guessed.

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { embedText, cosineSimilarity, EMBED_DIM } from "./embeddings";

// --- Thresholds (tuned to be conservative: better no pattern than a wrong one)

/** A tool sequence needs this many trajectories before it is called a pattern. */
export const PATTERN_MIN_SAMPLES = 3;
/** Only sequences whose observed success rate clears this bar are promoted. */
export const PATTERN_MIN_SUCCESS = 0.6;
/** Cosine floor for a semantic hit (MiniLM sentence similarity; ~0.5 is related). */
export const SEMANTIC_MIN_SCORE = 0.45;
/** Cap on stored semantic entries — this is a recall aid, not a data lake. */
const SEMANTIC_MAX_ENTRIES = 2000;

export type InsightWriteStatus = "written" | "skipped" | "failed";

/**
 * Best-effort embedding. Returns null when the optional ONNX model is not
 * available — SonaTrajectory.embedding and SonaPattern.embedding are REQUIRED
 * columns, so those two get an explicit zero vector rather than being lost.
 * A zero vector never matches a semantic recall (cosine 0 < SEMANTIC_MIN_SCORE)
 * and never pollutes the ranking, which is exactly the right behaviour for
 * "I could not compute this".
 */
async function safeEmbed(text: string): Promise<number[] | null> {
  try {
    const vec = await embedText(text);
    return vec ? Array.from(vec) : null;
  } catch {
    return null;
  }
}

const ZERO_VEC = new Array<number>(EMBED_DIM).fill(0);

// ---------------------------------------------------------------------------
// Task + ToolCall — the per-task record
// ---------------------------------------------------------------------------

export interface RecordTaskInput {
  userId: string;
  prompt: string;
  mode?: string;
  /** Correlates Task.toolCalls and SonaTrajectory rows back to a run. */
  runId?: string;
}

/**
 * Create the durable task record. Returns the new id, or null when the write
 * failed (never throws — telemetry must not break a run).
 */
export async function recordTask(input: RecordTaskInput): Promise<string | null> {
  try {
    const row = await prisma.task.create({
      data: {
        userId: input.userId,
        prompt: input.prompt.slice(0, 10_000),
        mode: input.mode ?? "code",
        status: "running",
      },
      select: { id: true },
    });
    return row.id;
  } catch {
    return null;
  }
}

/** Terminal state for a task. Unknown ids are a no-op, not an error. */
export async function completeTask(taskId: string, result: string, ok: boolean): Promise<InsightWriteStatus> {
  try {
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: ok ? "completed" : "failed",
        result: result.slice(0, 20_000),
        completedAt: new Date(),
      },
    });
    return "written";
  } catch {
    return "failed";
  }
}

export interface RecordToolCallInput {
  taskId: string;
  tool: string;
  args: string;
  status?: string;
  duration?: number;
  result?: string;
}

/** Append one tool call under a task (the audit trail of what it did). */
export async function recordToolCall(input: RecordToolCallInput): Promise<InsightWriteStatus> {
  try {
    await prisma.toolCall.create({
      data: {
        taskId: input.taskId,
        tool: input.tool.slice(0, 120),
        args: input.args.slice(0, 10_000),
        result: input.result ? input.result.slice(0, 10_000) : null,
        status: input.status ?? "pending",
        duration: input.duration ?? null,
      },
    });
    return "written";
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// PipelineStep — per-stage timing
// ---------------------------------------------------------------------------

/**
 * Record one stage of a run's pipeline.
 *
 * The owning AgentRun is required by the foreign key, so a step is only
 * recorded when the caller supplies a real runId — there is no safe way to
 * invent one, and a silently-orphaned row would be worse than none.
 */
export async function recordPipelineStep(input: {
  runId: string;
  state: string;
  input?: string;
  output?: string;
  duration?: number;
  success?: boolean;
}): Promise<InsightWriteStatus> {
  try {
    await prisma.pipelineStep.create({
      data: {
        runId: input.runId,
        state: input.state.slice(0, 120),
        input: (input.input ?? "").slice(0, 20_000),
        output: (input.output ?? "").slice(0, 20_000),
        duration: input.duration ?? 0,
        success: input.success ?? false,
      },
    });
    return "written";
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// AgentTaskDependency — the edge between tasks
// ---------------------------------------------------------------------------

/**
 * Declare that `taskId` cannot start before `dependsOnId` finishes.
 *
 * Deliberately idempotent: the composite primary key is (taskId, dependsOnId)
 * and scheduling re-announces edges on every retry, so a duplicate is the
 * normal case, not an error. A self-edge is rejected outright — it would make
 * the task permanently unschedulable.
 */
export async function recordTaskDependency(taskId: string, dependsOnId: string): Promise<InsightWriteStatus> {
  if (!taskId || !dependsOnId || taskId === dependsOnId) return "skipped";
  try {
    await prisma.agentTaskDependency.createMany({
      data: [{ taskId, dependsOnId }],
      skipDuplicates: true,
    });
    return "written";
  } catch {
    return "failed";
  }
}

/**
 * Tasks whose dependencies are all complete — i.e. ready to claim.
 *
 * `none(...)` is the whole point of storing edges: without them a scheduler
 * cannot tell "no prerequisites" from "prerequisites not finished yet", and
 * either starts work too early or deadlocks forever.
 */
export async function readyAgentTasks(runId: string, limit = 10): Promise<Array<{ id: string; role: string; title: string }>> {
  return prisma.agentTask
    .findMany({
      where: {
        runId,
        status: "pending",
        NOT: {
          dependencies: {
            some: { dependsOn: { status: { notIn: ["completed", "failed"] } } },
          },
        },
      },
      select: { id: true, role: true, title: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    })
    .catch(() => []);
}

// ---------------------------------------------------------------------------
// SonaTrajectory — the full run record
// ---------------------------------------------------------------------------

/**
 * Persist a completed trajectory: the tools used, files changed, token spend
 * and whether it worked. This is the raw material the pattern miner reads.
 */
export async function recordTrajectory(input: {
  task: string;
  outcome: "success" | "partial" | "failure";
  toolsUsed: string[];
  filesChanged?: string[];
  steps?: Array<{ tool: string; ok: boolean; durationMs?: number }>;
  totalTokens?: number;
  totalDuration?: number;
}): Promise<InsightWriteStatus> {
  try {
    await prisma.sonaTrajectory.create({
      data: {
        task: input.task.slice(0, 4_000),
        outcome: input.outcome,
        embedding: (await safeEmbed(input.task)) ?? ZERO_VEC,
        toolsUsed: input.toolsUsed.slice(0, 200),
        filesChanged: (input.filesChanged ?? []).slice(0, 500),
        steps: (input.steps ?? []).slice(0, 500),
        totalTokens: input.totalTokens ?? 0,
        totalDuration: input.totalDuration ?? 0,
      },
    });
    return "written";
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// SonaPattern — tool sequences that measurably work
// ---------------------------------------------------------------------------

export interface LearnedPattern {
  name: string;
  description: string;
  steps: string[];
  successRate: number;
  useCount: number;
  avgDuration: number;
}

/**
 * Mine trajectories for recurring tool sequences and promote the ones that
 * clear both thresholds.
 *
 * The "sequence" is the ordered tool list truncated to SEQUENCE_LEN — a real
 * workflow (read → grep → edit → test) rather than the full 40-call history,
 * which would never repeat and would therefore never be learned.
 */
const SEQUENCE_LEN = 5;

function sequenceOf(tools: string[]): string {
  return tools.slice(0, SEQUENCE_LEN).join(" → ");
}

export async function learnPatternsFromTrajectories(options: { limit?: number } = {}): Promise<LearnedPattern[]> {
  let trajectories: Array<{ toolsUsed: string[]; outcome: string; totalDuration: number }>;
  try {
    trajectories = await prisma.sonaTrajectory.findMany({
      orderBy: { createdAt: "desc" },
      take: options.limit ?? 200,
      select: { toolsUsed: true, outcome: true, totalDuration: true },
    });
  } catch {
    return [];
  }

  const groups = new Map<string, { steps: string[]; success: number; total: number; duration: number }>();
  for (const t of trajectories) {
    const tools = Array.isArray(t.toolsUsed) ? t.toolsUsed.filter((x) => typeof x === "string") : [];
    if (tools.length === 0) continue;
    const key = sequenceOf(tools);
    const g = groups.get(key) ?? { steps: tools.slice(0, SEQUENCE_LEN), success: 0, total: 0, duration: 0 };
    g.total++;
    if (t.outcome === "success") g.success++;
    g.duration += Number(t.totalDuration) || 0;
    groups.set(key, g);
  }

  const learned: LearnedPattern[] = [];
  for (const [key, g] of groups) {
    const rate = g.total > 0 ? g.success / g.total : 0;
    if (g.total < PATTERN_MIN_SAMPLES) continue;
    if (rate < PATTERN_MIN_SUCCESS) continue;
    const pattern = {
      name: key.split(" → ").slice(0, 2).join(" → ") || "unnamed",
      description: `Tool sequence "${key}" succeeded in ${(rate * 100).toFixed(0)}% of ${g.total} observed runs.`,
      steps: g.steps,
      successRate: rate,
      useCount: g.total,
      avgDuration: g.total > 0 ? Math.round(g.duration / g.total) : 0,
    };
    learned.push(pattern);
    await upsertPattern(key, pattern).catch(() => {});
  }
  return learned;
}

async function upsertPattern(key: string, p: LearnedPattern): Promise<void> {
  // embedding is a REQUIRED column on SonaPattern; see safeEmbed's note on why
  // a zero vector is the correct fallback.
  const embedding = (await safeEmbed(`${key} ${p.steps.join(" → ")}`)) ?? ZERO_VEC;
  const existing = await prisma.sonaPattern.findFirst({ where: { name: key }, select: { id: true } });
  if (existing) {
    await prisma.sonaPattern.update({
      where: { id: existing.id },
      data: {
        description: p.description,
        embedding,
        steps: p.steps,
        successRate: p.successRate,
        useCount: p.useCount,
        avgDuration: p.avgDuration,
      },
    });
  } else {
    await prisma.sonaPattern.create({
      data: {
        name: key,
        description: p.description,
        embedding,
        steps: p.steps,
        successRate: p.successRate,
        useCount: p.useCount,
        avgDuration: p.avgDuration,
      },
    });
  }
}

/** The best-performing patterns, for injection into an agent's prompt. */
export async function topPatterns(limit = 5): Promise<LearnedPattern[]> {
  return prisma.sonaPattern
    .findMany({
      orderBy: [{ successRate: "desc" }, { useCount: "desc" }],
      take: limit,
      select: { name: true, description: true, steps: true, successRate: true, useCount: true, avgDuration: true },
    })
    .catch(() => []);
}

// ---------------------------------------------------------------------------
// VectorMemoryEntry — semantic recall
// ---------------------------------------------------------------------------

/**
 * Store a semantic memory.
 *
 * The vector is OPTIONAL by design: `embedText` loads a ~25 MB ONNX model that
 * may not be installed, and refusing to record a memory because an optional
 * inference dependency is missing would be backwards. Without a vector the row
 * still records the text and is returned by recent/keyword reads.
 */
export async function rememberSemantic(input: {
  type: "code_change" | "conversation" | "pattern" | "error" | "convention";
  content: string;
  filePath?: string;
  tool?: string;
  success?: boolean;
  tags?: string[];
}): Promise<{ written: boolean; vectorised: boolean }> {
  const content = input.content.slice(0, 8_000);
  const embedding = await safeEmbed(content);

  try {
    await prisma.vectorMemoryEntry.create({
      data: {
        type: input.type,
        content,
        // REQUIRED Json column. A zero vector is the marker for "the embedder
        // was unavailable" — it scores 0 against every query, so it is inert
        // for ranking while still recording the memory itself.
        embedding: embedding ?? ZERO_VEC,
        filePath: input.filePath ?? null,
        tool: input.tool ?? null,
        success: input.success ?? null,
        tags: (input.tags ?? []).slice(0, 20),
      },
    });
    await pruneSemantic().catch(() => {});
    return { written: true, vectorised: embedding !== null };
  } catch {
    return { written: false, vectorised: false };
  }
}

/** Trim the store back to SEMANTIC_MAX_ENTRIES, oldest first. */
async function pruneSemantic(): Promise<void> {
  const count = await prisma.vectorMemoryEntry.count();
  if (count <= SEMANTIC_MAX_ENTRIES) return;
  const excess = count - SEMANTIC_MAX_ENTRIES;
  const stale = await prisma.vectorMemoryEntry.findMany({
    orderBy: { createdAt: "asc" },
    take: excess,
    select: { id: true },
  });
  if (stale.length > 0) {
    await prisma.vectorMemoryEntry.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }
}

export interface SemanticHit {
  id: string;
  type: string;
  content: string;
  filePath: string | null;
  score: number;
}

/**
 * Recall memories similar to `query`.
 *
 * Degrades honestly: with no embedding model available it falls back to a
 * keyword match and labels every hit `match: "keyword"`, because a caller
 * that thinks it got semantic ranking when it got LIKE matching will draw the
 * wrong conclusions from the results.
 */
export async function recallSimilar(query: string, limit = 5): Promise<Array<SemanticHit & { match: "semantic" | "keyword" }>> {
  const q = query.trim();
  if (!q) return [];

  let queryVec: Float32Array | null = null;
  try {
    queryVec = await embedText(q);
  } catch {
    queryVec = null;
  }

  if (queryVec) {
    const candidates = await prisma.vectorMemoryEntry
      .findMany({
        // Zero-vector rows are the "embedder unavailable" marker; skip them here.`n        where: { NOT: { embedding: { equals: ZERO_VEC } } },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { id: true, type: true, content: true, filePath: true, embedding: true },
      })
      .catch(() => [] as Array<{ id: string; type: string; content: string; filePath: string | null; embedding: unknown }>);

    const scored = candidates
      .map((c) => {
        const vec = Array.isArray(c.embedding) ? (c.embedding as number[]) : [];
        const score = vec.length === EMBED_DIM ? cosineSimilarity(queryVec as Float32Array, vec) : -1;
        return { id: c.id, type: c.type, content: c.content, filePath: c.filePath, score };
      })
      .filter((c) => c.score >= SEMANTIC_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((c) => ({ ...c, match: "semantic" as const }));

    if (scored.length > 0) return scored;
  }

  const keyword = await prisma.vectorMemoryEntry
    .findMany({
      where: { content: { contains: q.slice(0, 120), mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, type: true, content: true, filePath: true },
    })
    .catch(() => []);
  return keyword.map((k) => ({ ...k, score: 0, match: "keyword" as const }));
}

// ---------------------------------------------------------------------------
// Aggregate read (backs GET /api/agent/insights)
// ---------------------------------------------------------------------------

export async function insightsSummary(userId: string): Promise<{
  tasks: { total: number; completed: number; failed: number; running: number };
  toolCalls: number;
  /** Per-tool usage, most-used first - this is what the UI's "Used in this
   * session" list renders. calls is total invocations across the user's
   * tasks; distinct-task counts are NOT derivable from a groupBy, so this
   * reports the honest number rather than a fabricated one. */
  toolUsage: Array<{ tool: string; calls: number }>;
  /** Things the agent produced — the UI's "Outputs" list. */
  outputs: Array<{ id: string; kind: string; name: string; createdAt: Date }>;
  trajectories: { total: number; success: number; partial: number; failure: number };
  patterns: number;
  semantic: { total: number; vectorised: number };
  recentTasks: Array<{ id: string; prompt: string; mode: string; status: string; createdAt: Date }>;
}> {
  const [taskCounts, toolRows, outputs, trajCounts, patterns, semanticTotal, vectorised, recentTasks] = await Promise.all([
    prisma.task.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }).catch(() => []),
    // One join instead of N queries: the tool row already knows its task, so
    // counting per task AND totalling calls happens in a single round trip.
    prisma.toolCall
      .groupBy({
        by: ["tool"],
        where: { task: { userId } },
        _count: { _all: true },
        _sum: { duration: true },
      })
      .catch(() => []),
    prisma.agentArtifact
      .findMany({
        where: { run: { userId } },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, kind: true, name: true, createdAt: true },
      })
      .catch(() => []),
    prisma.sonaTrajectory.groupBy({ by: ["outcome"], _count: { _all: true } }).catch(() => []),
    prisma.sonaPattern.count().catch(() => 0),
    prisma.vectorMemoryEntry.count().catch(() => 0),
    prisma.vectorMemoryEntry.count({ where: { NOT: { embedding: { equals: ZERO_VEC } } } }).catch(() => 0),
    prisma.task
      .findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, prompt: true, mode: true, status: true, createdAt: true },
      })
      .catch(() => []),
  ]);

  const byStatus = (rows: Array<{ status?: string; outcome?: string; _count: { _all: number } }>, key: "status" | "outcome") => {
    const map: Record<string, number> = {};
    for (const r of rows) map[String(r[key] ?? "")] = r._count._all;
    return map;
  };

  const tasks = byStatus(taskCounts as never, "status");
  const traj = byStatus(trajCounts as never, "outcome");

  const toolUsage = (toolRows as Array<{ tool: string; _count: { _all: number } }>)
    .map((r) => ({ tool: r.tool, calls: r._count._all }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 20);

  return {
    tasks: {
      total: Object.values(tasks).reduce((a, b) => a + b, 0),
      completed: tasks.completed ?? 0,
      failed: tasks.failed ?? 0,
      running: tasks.running ?? 0,
    },
    toolCalls: toolUsage.reduce((sum, t) => sum + t.calls, 0),
    toolUsage,
    outputs: (outputs ?? []).map((a) => ({ id: a.id, kind: a.kind, name: a.name, createdAt: a.createdAt })),
    trajectories: {
      total: Object.values(traj).reduce((a, b) => a + b, 0),
      success: traj.success ?? 0,
      partial: traj.partial ?? 0,
      failure: traj.failure ?? 0,
    },
    patterns,
    semantic: { total: semanticTotal, vectorised },
    recentTasks,
  };
}