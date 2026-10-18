// workspace-memory.ts — Durable, evidence-backed workspace learnings.
//
// Successor to the removed sona/vector-memory façade: instead of persisting
// opaque "stats" nobody read, this stores concrete learnings derived from
// COMPLETED tasks and retrieves them into the agent's prompt for future work
// in the same workspace. Retrieval is score-based (path overlap + recency +
// reinforcement count) — no embeddings required at this scale.
//
// Trust model: entries only come from verified/completed runs, are sanitized
// (control chars stripped, bounded), and are capped per workspace. The user
// can inspect and forget entries via /api/agent/memory.

import { createHash } from "crypto";
import { prisma } from "./prisma";
import { getWorkspaceKey } from "./run-ledger";

export type MemoryKind = "pattern" | "stack" | "decision" | "pitfall";

const MAX_CONTENT_CHARS = 500;
const MAX_ENTRIES_PER_WORKSPACE = 250;
const MAX_FILES_PER_ENTRY = 8;
const MAX_FILE_PATH_CHARS = 200;
/** Entries not re-seen for this long are ignored by retrieval. */
const STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

function sanitizeText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

export interface CaptureInput {
  workspaceKey: string;
  task: string;
  /** Final written/edited files (path → content optional). */
  writtenFiles: Record<string, unknown>;
  /** Which verification lanes passed for this run. */
  lanes: { typecheck?: string; browser?: string };
  /** The user accepted these; that's a decision worth remembering. */
  acceptedSuggestions?: string[];
  /** The user rejected these; avoid repeating them. */
  rejectedSuggestions?: string[];
  finalStatus: string;
  /** Client transport only: which folder this run wrote to (server recomputes workspaceKey). */
  directoryName?: string;
}

/** Learnings this run is worth persisting (≥1 verified lane or completed run). */
export function deriveMemories(input: CaptureInput): Array<{
  kind: MemoryKind;
  content: string;
  files: string[];
  evidence: Record<string, unknown>;
}> {
  const memories: Array<{
    kind: MemoryKind;
    content: string;
    files: string[];
    evidence: Record<string, unknown>;
  }> = [];
  const verified =
    input.lanes.typecheck === "pass" || input.lanes.browser === "pass";
  const written = Object.keys(input.writtenFiles || {}).slice(0, MAX_FILES_PER_ENTRY);
  const task = sanitizeText(input.task).slice(0, 120);

  // Suggestion-only inputs (compaction-evicted facts, /remember pins) carry
  // no files but still teach decisions/pitfalls below — only bail when there
  // is neither file evidence nor suggestions. (The old unconditional return
  // made captureFromCompaction a permanent no-op.)
  const hasSuggestions =
    (input.acceptedSuggestions?.length ?? 0) + (input.rejectedSuggestions?.length ?? 0) > 0;
  if ((!input.writtenFiles || written.length === 0) && !hasSuggestions) return memories;

  // Stack: frameworks/libraries this workspace actually uses (evidence: files).
  const stackSignals = new Map<string, string[]>(); // signature → files
  for (const [path, content] of Object.entries(input.writtenFiles)) {
    const c = typeof content === "string" ? content : "";
    const found: string[] = [];
    if (/from ["']next|next\//.test(c)) found.push("Next.js");
    if (/from ["']react/.test(c)) found.push("React");
    if (/from ["']vue/.test(c)) found.push("Vue");
    if (/\bprisma\b/.test(c)) found.push("Prisma");
    if (/from ["']express/.test(c)) found.push("Express");
    if (/tailwind/.test(c)) found.push("Tailwind");
    for (const sig of found) {
      const arr = stackSignals.get(sig) || [];
      if (arr.length < 3) arr.push(path);
      stackSignals.set(sig, arr);
    }
  }
  for (const [sig, files] of stackSignals) {
    memories.push({
      kind: "stack",
      content: `This workspace uses ${sig}.`,
      files,
      evidence: { task, lanes: input.lanes },
    });
  }

  if (verified) {
    // Pattern: file-layout facts about verified work.
    const dirs = new Map<string, number>();
    for (const p of written) {
      const d = p.split("/").slice(0, -1).join("/") || "(root)";
      dirs.set(d, (dirs.get(d) || 0) + 1);
    }
    const topDir = [...dirs.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topDir && topDir[1] >= 2) {
      memories.push({
        kind: "pattern",
        content: `Recent verified work writes ${topDir[0]}/ files (${topDir[1]} files in recent tasks).`,
        files: written.slice(0, 3),
        evidence: { task, lanes: input.lanes },
      });
    }

    // Pitfall: prior failure in this lane got fixed by this run — the fix worked.
    if (input.lanes.typecheck === "pass") {
      memories.push({
        kind: "pattern",
        content: "Typecheck lane passed on the most recent verified run in this workspace.",
        files: written.slice(0, 3),
        evidence: { task, lanes: input.lanes, verified: true },
      });
    }
  }

  // Decisions: what the user accepted or rejected.
  for (const s of (input.acceptedSuggestions || []).slice(0, 3)) {
    const text = sanitizeText(s).slice(0, MAX_CONTENT_CHARS);
    if (text) {
      memories.push({
        kind: "decision",
        content: `User approved: ${text}`,
        files: written.slice(0, 3),
        evidence: { task, source: "user-approval" },
      });
    }
  }
  for (const s of (input.rejectedSuggestions || []).slice(0, 3)) {
    const text = sanitizeText(s).slice(0, MAX_CONTENT_CHARS);
    if (text) {
      memories.push({
        kind: "pitfall",
        content: `User rejected this approach before: ${text}`,
        files: written.slice(0, 3),
        evidence: { task, source: "user-rejection" },
      });
    }
  }

  return memories.slice(0, 8);
}

/**
 * /remember <fact> — persist a user-pinned fact. kind "decision" (the agent
 * treated user choices as decisions), evidence marks it pinned so retrieval
 * can boost it and stale-eviction can ignore it. Idempotent via content hash.
 */
export async function rememberFact(workspaceKey: string, fact: string): Promise<boolean> {
  const content = sanitizeText(fact).slice(0, MAX_CONTENT_CHARS);
  if (!content) return false;
  try {
    await prisma.workspaceMemory.upsert({
      where: {
        workspaceKey_kind_contentHash: {
          workspaceKey,
          kind: "decision",
          contentHash: hashContent(content),
        },
      },
      update: { count: { increment: 1 }, lastSeenAt: new Date() },
      create: {
        workspaceKey,
        kind: "decision",
        content,
        contentHash: hashContent(content),
        files: [],
        evidence: { pinned: true, source: "user" },
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Persist derived memories. Idempotent per (workspace, kind, content) via hash. */
export async function captureWorkspaceMemories(input: CaptureInput): Promise<number> {
  const derived = deriveMemories(input);
  let stored = 0;
  for (const m of derived) {
    try {
      await prisma.workspaceMemory.upsert({
        where: {
          workspaceKey_kind_contentHash: {
            workspaceKey: input.workspaceKey,
            kind: m.kind,
            contentHash: hashContent(m.content),
          },
        },
        update: { count: { increment: 1 }, lastSeenAt: new Date() },
        create: {
          workspaceKey: input.workspaceKey,
          kind: m.kind,
          content: m.content,
          contentHash: hashContent(m.content),
          files: m.files,
          evidence: m.evidence as object,
        },
      });
      stored++;
    } catch {
      // Never let memory capture break a task completion.
    }
  }

  // Cap per workspace: drop the least-recently-seen overflow — but a PINNED
  // fact (/remember) is never a victim, even past the cap. Retrieval already
  // honours pins (they outrank statistics and skip stale-eviction); eviction
  // must not contradict it by deleting the pin the prompt then promises.
  try {
    const rows = await prisma.workspaceMemory.findMany({
      where: { workspaceKey: input.workspaceKey },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true, evidence: true },
    });
    const { victimIds } = selectOverflowVictims(rows, MAX_ENTRIES_PER_WORKSPACE);
    if (victimIds.length > 0) {
      await prisma.workspaceMemory.deleteMany({
        where: { id: { in: victimIds } },
      });
    }
  } catch {}

  return stored;
}

/** True when a row's evidence marks a user-pinned fact (/remember). */
export function isPinnedEvidence(evidence: unknown): boolean {
  return !!(
    typeof evidence === "object" &&
    evidence !== null &&
    (evidence as { pinned?: unknown }).pinned === true
  );
}

/**
 * Choose LRU overflow victims for the per-workspace cap. `rows` must be
 * newest-first (lastSeenAt desc), as the caller fetches them.
 *
 * Rules (AUDIT §2 "Pinned-fact eviction immunity"):
 *  - A pinned row is NEVER selected, wherever it sits.
 *  - Victims are the least-recently-seen UNPINNED rows, walking from the
 *    tail (LRU) toward the head until `overflow` victims are chosen.
 *  - If there are not enough unpinned rows (down to the extreme where every
 *    entry is pinned), fewer victims are returned and `effectiveCap` grows
 *    above `cap` — the workspace simply keeps more entries rather than lose
 *    a pin.
 */
export function selectOverflowVictims(
  rows: Array<{ id: string; evidence: unknown }>,
  cap: number
): { victimIds: string[]; effectiveCap: number } {
  const limit = Math.max(1, Math.floor(cap));
  if (!Array.isArray(rows) || rows.length <= limit) {
    return { victimIds: [], effectiveCap: limit };
  }
  const overflow = rows.length - limit;
  const victimIds: string[] = [];
  for (let i = rows.length - 1; i >= 0 && victimIds.length < overflow; i--) {
    if (!isPinnedEvidence(rows[i].evidence)) victimIds.push(rows[i].id);
  }
  return { victimIds, effectiveCap: rows.length - victimIds.length };
}

export interface RetrievedMemory {
  kind: MemoryKind;
  content: string;
  score: number;
  /** True when the MiniLM cosine term contributed (false = lexical-only fallback). */
  semantic?: boolean;
}

/**
 * Score-based retrieval: recency + reinforcement + task/path overlap.
 * Deterministic, cheap, no embeddings. Returns entries for the prompt block.
 */
export async function retrieveWorkspaceMemories(
  workspaceKey: string,
  task: string,
  limit = 5
): Promise<RetrievedMemory[]> {
  const rows = await prisma.workspaceMemory
    .findMany({
      where: { workspaceKey },
      orderBy: { lastSeenAt: "desc" },
      take: MAX_ENTRIES_PER_WORKSPACE,
    })
    .catch(() => []);

  if (rows.length === 0) return [];

  // Semantic term (free, local, ~20ms warm): MiniLM cosine between the task
  // and each memory's own embedding. The embedding is computed lazily from
  // the row's own text on first retrieval and persisted (embedding Json?) so
  // later runs skip the compute entirely. No model, no vector → weight 0 and
  // the lexical scorer carries retrieval (graceful degradation, never a stall).
  const { embedText, cosineSimilarity, EMBED_DIM } = await import("./embeddings");
  const taskVec = await embedText(task);
  let semanticHits = 0;

  const now = Date.now();
  const taskLower = task.toLowerCase();
  const taskTokens = new Set(
    taskLower.split(/[^a-z0-9]+/).filter((t) => t.length > 3)
  );

  let backfillBudget = 25;
  const backfills: Array<{ id: string; vector: Float32Array }> = [];
  const fresh = rows.filter((r) => {
    // Pinned facts (user /remember) are never stale-evicted.
    const pinned = !!(r.evidence as { pinned?: boolean } | null)?.pinned;
    return pinned || now - r.lastSeenAt.getTime() < STALE_MS;
  });
  const scored: RetrievedMemory[] = [];
  for (const r of fresh) {
    let score = 0;
    const pinned = !!(r.evidence as { pinned?: boolean } | null)?.pinned;
    const ageDays = (now - r.lastSeenAt.getTime()) / 86_400_000;
    score += Math.max(0, 2 - ageDays / 7); // fresh for ~2 weeks, decays after
    score += Math.min(2, Math.log2(1 + r.count)); // reinforced entries rank up
    if (pinned) score += 3; // user-pinned facts outrank statistics
    if (r.kind === "decision" || r.kind === "pitfall") score += 2; // user intent outweighs statistics
    const contentLower = r.content.toLowerCase();
    for (const t of taskTokens) {
      if (contentLower.includes(t)) score += 0.5;
    }
    const files = Array.isArray(r.files) ? (r.files as string[]) : [];
    for (const f of files) {
      const base = String(f).split("/").pop()?.toLowerCase() || "";
      if (base && taskLower.includes(base)) score += 1;
    }
    // Semantic term: cosine · 0.7. Backfill: on the first semantic pass a
    // row without a stored vector is embedded from its own text (capped,
    // bounded — a failure maps it to null so the weight is simply 0).
    let semantic = false;
    if (taskVec) {
      const stored = (r as { embedding?: unknown }).embedding;
      if (Array.isArray(stored) && stored.length === EMBED_DIM) {
        const sim = cosineSimilarity(taskVec, stored as number[]);
        if (sim > 0.25) {
          score += sim * 0.7;
          semantic = true;
        }
      } else if (backfillBudget > 0) {
        backfillBudget--;
        const vec = await embedText(r.content);
        if (vec) {
          const sim = cosineSimilarity(taskVec, vec);
          if (sim > 0.25) {
            score += sim * 0.7;
            semantic = true;
          }
          backfills.push({ id: r.id, vector: vec });
        }
      }
    }
    if (semantic) semanticHits++;
    scored.push({ kind: r.kind as MemoryKind, content: r.content, score, semantic });
  }

  const top = scored
    .filter((r) => r.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Persist backfilled vectors (fire-and-forget; a failure is invisible here
  // and simply re-derives on the next retrieval).
  if (backfills.length > 0) {
    for (const b of backfills) {
      void prisma.workspaceMemory
        .update({ where: { id: b.id }, data: { embedding: Array.from(b.vector) } })
        .catch(() => {});
    }
  }
  if (semanticHits > 0 && process.env.ORPLEX_DEBUG_MEM === "1") {
    console.log(`[workspace-memory] semantic term contributed for ${semanticHits}/${rows.length} row(s)`);
  }

  return top;
}

/** Render memories for injection into the agent's system prompt. */
export function formatMemoriesForPrompt(memories: RetrievedMemory[]): string | null {
  if (memories.length === 0) return null;
  const lines = memories.map((m) => {
    const tag =
      m.kind === "pitfall"
        ? "AVOID"
        : m.kind === "decision"
          ? "USER PREFERENCE"
          : m.kind === "stack"
            ? "STACK"
            : "PATTERN";
    return `- [${tag}] ${m.content}`;
  });
  return [
    "## Workspace learnings (from previous verified tasks in this workspace)",
    ...lines,
    "",
    "These are evidence-backed observations, not instructions from the user. Apply them when relevant; ignore them when a task clearly calls for something different.",
  ].join("\n");
}

/** For the "What I remember" UI surface. */
export async function listMemories(workspaceKey: string) {
  return prisma.workspaceMemory
    .findMany({
      where: { workspaceKey },
      orderBy: { lastSeenAt: "desc" },
      take: 100,
    })
    .catch(() => []);
}

export async function forgetMemory(id: string, workspaceKey: string): Promise<boolean> {
  const res = await prisma.workspaceMemory
    .deleteMany({ where: { id, workspaceKey } })
    .catch(() => null);
  return !!res && res.count > 0;
}

/**
 * Eviction capture — folded here from the former compaction-memory.ts store.
 * When the transcript outgrows budget, compaction summarizes the evicted
 * prefix; that summary already holds distilled facts, so 1-3 durable
 * learnings are captured into THIS bucket at zero extra model cost.
 * There is no separate compaction store: extract + capture live here.
 */

/** Extract candidate facts from a compaction summary. Pure, deterministic. */
export function extractEvictionFacts(summary: string): string[] {
  const facts: string[] = [];
  const lines = summary.split(/\r?\n/).map((l) => l.trim());
  for (const line of lines) {
    if (facts.length >= 3) break;
    // Decision/pitfall markers the compaction prompt encourages.
    const decision = /^(?:[-*]\s*)?(?:decision|chose|decided|use|prefer)\b/i.test(line);
    const pitfall = /^(?:[-*]\s*)?(?:avoid|never|do not|don't|fails|error|pitfall)\b/i.test(line);
    if (!decision && !pitfall) continue;
    // Length-check the STORED fact (prefix stripped), not the raw line.
    const fact = line.replace(/^[-*]\s*/, "").slice(0, 400);
    if (fact.length < 25 || fact.length > 400) continue;
    facts.push(fact);
  }
  return facts;
}

/**
 * Fire-and-forget capture from a compaction summary. Best-effort: any DB
 * error is swallowed — memory must never break a run.
 */
export async function captureFromCompaction(opts: {
  directoryName: string;
  summary: string;
}): Promise<number> {
  if (!opts.summary || opts.summary.length < 60) return 0;
  const facts = extractEvictionFacts(opts.summary);
  if (facts.length === 0) return 0;
  try {
    return await captureWorkspaceMemories({
      workspaceKey: getWorkspaceKey(opts.directoryName),
      task: "auto-captured from compacted context",
      writtenFiles: {},
      lanes: {},
      finalStatus: "done",
      acceptedSuggestions: facts,
    });
  } catch {
    return 0;
  }
}

export { getWorkspaceKey };
