// playbook.ts — Evidence-gated learning from verified runs.
//
// Derives reusable playbooks from completed tasks, merges repeated evidence
// into existing entries (confidence rises), decays contradicted ones, and
// retrieves via cosine similarity over the local embedding model.
//
// Trust model: entries only come from verified/completed runs (typecheck
// lane passed). The user can inspect, pin, edit, and delete via /api/playbook.

import { createHash } from "crypto";
import { prisma } from "./prisma";
import { embedText, cosineSimilarity } from "./embeddings";

// The generated Prisma client may predate the confidence/verified/useCount/
// pinned/kind columns on Learning (run `prisma db push` after pulling this
// change to add them). This typed delegate keeps the module compiling
// against a stale client; at runtime the columns exist after the push.
interface LearningRow {
  id: string;
  projectId: string;
  pattern: string;
  content: string;
  tags: string[];
  sourceRunId: string | null;
  confidence: number;
  verified: boolean;
  useCount: number;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const learningDb = () => prisma.learning as unknown as {
  findFirst(args: unknown): Promise<LearningRow | null>;
  findMany(args: unknown): Promise<LearningRow[]>;
  create(args: unknown): Promise<LearningRow>;
  update(args: unknown): Promise<LearningRow>;
  deleteMany(args: unknown): Promise<{ count: number }>;
};


export interface PlaybookEntry {
  id: string;
  pattern: string;
  content: string;
  tags: string[];
  confidence: number;
  verified: boolean;
  useCount: number;
  pinned: boolean;
  sourceRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeriveInput {
  task: string;
  files: Record<string, string>;
  lanes: { typecheck?: string; browser?: string; swarm?: string };
  finalStatus: string;
  sourceRunId?: string;
  mode?: string;
}

export interface SearchResult {
  id: string;
  pattern: string;
  content: string;
  tags: string[];
  confidence: number;
  score: number;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

function sanitizeText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

const MAX_CONTENT_CHARS = 500;
/** User-authored skills carry full procedures — they get a larger budget
 * than auto-derived one-liners (the skill_create path accepts up to 2000). */
const MAX_SKILL_CHARS = 1500;
const MAX_ENTRIES_PER_PROJECT = 250;
/** Rows re-scored with the semantic term per search (latency cap). */
const SEMANTIC_CANDIDATES = 25;
const STALE_MS = 90 * 24 * 60 * 60 * 1000;
const CONFIDENCE_DECAY = 0.85;
const CONFIDENCE_BOOST = 0.1;
const MAX_CONFIDENCE = 1.0;
const MIN_CONFIDENCE = 0.1;

/**
 * Derive playbook entries from a completed run. Returns empty array when
 * the run is not verified (typecheck lane must pass) — this is the gate
 * that prevents confident garbage from filling the memory.
 */
export function deriveFromRun(input: DeriveInput): Array<{
  pattern: string;
  content: string;
  tags: string[];
  evidence: Record<string, unknown>;
}> {
  const verified = input.lanes.typecheck === "pass" || input.lanes.browser === "pass";
  if (!verified) return [];
  if (input.finalStatus !== "done") return [];

  const entries: Array<{
    pattern: string;
    content: string;
    tags: string[];
    evidence: Record<string, unknown>;
  }> = [];

  const written = Object.keys(input.files || {}).slice(0, 8);
  if (written.length === 0) return entries;

  const task = sanitizeText(input.task).slice(0, 120);

  // Pattern: file-layout facts about verified work
  const dirs = new Map<string, number>();
  for (const p of written) {
    const d = p.split("/").slice(0, -1).join("/") || "(root)";
    dirs.set(d, (dirs.get(d) || 0) + 1);
  }
  const topDir = [...dirs.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topDir && topDir[1] >= 2) {
    entries.push({
      pattern: "file-layout",
      content: `Recent verified work writes ${topDir[0]}/ files (${topDir[1]} files in recent tasks).`,
      tags: ["layout", "verified"],
      evidence: { task, lanes: input.lanes },
    });
  }

  // Pattern: typecheck passed — the fix worked
  if (input.lanes.typecheck === "pass") {
    entries.push({
      pattern: "typecheck-fix",
      content: `Typecheck lane passed on the most recent verified run in this workspace.`,
      tags: ["typecheck", "verified"],
      evidence: { task, lanes: input.lanes, verified: true },
    });
  }

  // Stack: frameworks/libraries this workspace actually uses
  const stackSignals = new Map<string, string[]>();
  for (const [path, content] of Object.entries(input.files || {})) {
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
    entries.push({
      pattern: "stack",
      content: `This workspace uses ${sig}.`,
      tags: ["stack", sig.toLowerCase()],
      evidence: { task, lanes: input.lanes },
    });
  }

  return entries.slice(0, 8);
}

/**
 * Merge a derived entry into the playbook store. If a matching entry exists
 * (same pattern + content hash), confidence rises and useCount increments.
 * If a contradicting entry exists (same pattern, different content), the
 * old one decays. Otherwise creates a new entry.
 */
export async function mergeOrCreate(
  projectId: string,
  entry: { pattern: string; content: string; tags: string[]; evidence: Record<string, unknown> },
  sourceRunId?: string
): Promise<PlaybookEntry | null> {
  const cap = entry.pattern === "skill" ? MAX_SKILL_CHARS : MAX_CONTENT_CHARS;
  const content = sanitizeText(entry.content).slice(0, cap);
  if (!content) return null;

  const contentHash = hashContent(content);

  // Match against EVERY row with this pattern (newest first), not just the
  // first: flip-flopping evidence must boost the matching row when one
  // exists instead of decaying an arbitrary sibling and growing a new row.
  // (?? fallbacks below: a DB that hasn't had `prisma db push` run yet
  // returns undefined for new columns — degrade to defaults, never NaN.)
  const siblings = await learningDb().findMany({
    where: { projectId, pattern: entry.pattern },
    orderBy: { updatedAt: "desc" },
  });

  const match = siblings.find((r) => hashContent(r.content) === contentHash);
  if (match) {
    // Same evidence — boost confidence
    const newConfidence = Math.min(MAX_CONFIDENCE, (match.confidence ?? 0.5) + CONFIDENCE_BOOST);
    const updated = await learningDb().update({
      where: { id: match.id },
      data: {
        confidence: newConfidence,
        useCount: { increment: 1 },
        tags: entry.tags,
        sourceRunId: sourceRunId || match.sourceRunId,
      },
    });
    return {
      id: updated.id,
      pattern: updated.pattern,
      content: updated.content,
      tags: updated.tags,
      confidence: updated.confidence ?? newConfidence,
      verified: updated.verified ?? true,
      useCount: updated.useCount ?? 1,
      pinned: updated.pinned ?? false,
      sourceRunId: updated.sourceRunId,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  // No identical row: decay every contradicting sibling, then store the new
  // evidence as its own row below.
  for (const r of siblings) {
    const decayed = Math.max(MIN_CONFIDENCE, (r.confidence ?? 0.5) * CONFIDENCE_DECAY);
    await learningDb()
      .update({ where: { id: r.id }, data: { confidence: decayed } })
      .catch(() => null);
  }

  // Create new entry
  const created = await learningDb().create({
    data: {
      projectId,
      pattern: entry.pattern,
      content,
      tags: entry.tags,
      sourceRunId: sourceRunId || null,
      confidence: 0.5,
      verified: true,
      useCount: 1,
    },
  });

  // Cap per project: drop oldest non-pinned overflow. Pinned rows are
  // excluded from BOTH the overflow read and the delete — a user pin must
  // never be silently evicted.
  try {
    const all = await learningDb().findMany({
      where: { projectId, pinned: false },
      orderBy: { updatedAt: "desc" },
      skip: MAX_ENTRIES_PER_PROJECT,
      select: { id: true },
    });
    if (all.length > 0) {
      await learningDb().deleteMany({
        where: { id: { in: all.map((r) => r.id) }, pinned: false },
      });
    }
  } catch {}

  return {
    id: created.id,
    pattern: created.pattern,
    content: created.content,
    tags: created.tags,
    confidence: created.confidence ?? 0.5,
    verified: true,
    useCount: created.useCount ?? 1,
    pinned: false,
    sourceRunId: created.sourceRunId,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  };
}

/**
 * Search playbooks by cosine similarity over the local embedding model.
 * Falls back to lexical matching when embeddings are unavailable.
 */
export async function searchPlaybooks(
  projectId: string,
  task: string,
  k = 5
): Promise<SearchResult[]> {
  if (!(task || "").trim()) return [];
  const rows = await learningDb().findMany({
    where: { projectId },
    orderBy: { updatedAt: "desc" },
    take: MAX_ENTRIES_PER_PROJECT,
  });

  if (rows.length === 0) return [];

  const now = Date.now();
  const taskVec = await embedText(task);
  const taskLower = task.toLowerCase();
  const taskTokens = new Set(
    taskLower.split(/[^a-z0-9]+/).filter((t) => t.length > 3)
  );

  // Phase 1 (cheap): lexical score over all rows.
  const scored: SearchResult[] = [];
  for (const r of rows) {
    let score = 0;
    const ageDays = (now - r.updatedAt.getTime()) / 86_400_000;
    score += Math.max(0, 2 - ageDays / 7);
    score += Math.min(2, Math.log2(1 + (r.useCount ?? 1)));
    score += (r.confidence ?? 0.5);

    const contentLower = r.content.toLowerCase();
    for (const t of taskTokens) {
      if (contentLower.includes(t)) score += 0.5;
    }

    scored.push({
      id: r.id,
      pattern: r.pattern,
      content: r.content,
      tags: r.tags,
      confidence: r.confidence ?? 0.5,
      score,
    });
  }

  // Phase 2 (bounded): the semantic MiniLM term re-scores only the top
  // lexical candidates. Embedding every row per search would stall the
  // prompt path at scale (one model inference per row); the cap keeps
  // retrieval latency flat (same 25-row budget as workspace-memory).
  if (taskVec) {
    const candidates = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, SEMANTIC_CANDIDATES);
    for (const c of candidates) {
      try {
        const rowVec = await embedText(c.content);
        if (rowVec) {
          const sim = cosineSimilarity(taskVec, rowVec);
          if (sim > 0.25) c.score += sim * 0.7;
        }
      } catch {
        // A single bad row never breaks retrieval.
      }
    }
  }

  return scored
    .filter((r) => r.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * List all playbooks for a project (for the UI).
 */
export async function listPlaybooks(projectId: string): Promise<PlaybookEntry[]> {
  const rows = await learningDb().findMany({
    where: { projectId },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    content: r.content,
    tags: r.tags,
    confidence: r.confidence ?? 0.5,
    verified: r.verified ?? false,
    useCount: r.useCount ?? 1,
    pinned: r.pinned ?? false,
    sourceRunId: r.sourceRunId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Update a playbook entry (pin/edit).
 */
export async function updatePlaybook(
  id: string,
  projectId: string,
  data: { content?: string; pinned?: boolean; tags?: string[] }
): Promise<PlaybookEntry | null> {
  const existing = await learningDb().findFirst({
    where: { id, projectId },
  });
  if (!existing) return null;

  const updated = await learningDb().update({
    where: { id },
    data: {
      ...(data.content !== undefined && { content: data.content.slice(0, MAX_CONTENT_CHARS) }),
      ...(data.pinned !== undefined && { pinned: data.pinned }),
      ...(data.tags !== undefined && { tags: data.tags }),
    },
  });

  return {
    id: updated.id,
    pattern: updated.pattern,
    content: updated.content,
    tags: updated.tags,
    confidence: updated.confidence ?? 0.5,
    verified: updated.verified ?? false,
    useCount: updated.useCount ?? 1,
    pinned: updated.pinned ?? false,
    sourceRunId: updated.sourceRunId,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
}

/**
 * Delete a playbook entry.
 */
export async function deletePlaybook(id: string, projectId: string): Promise<boolean> {
  const res = await learningDb().deleteMany({
    where: { id, projectId },
  });
  return res.count > 0;
}

/**
 * Format playbooks for injection into the system prompt.
 */
export function formatPlaybooksForPrompt(results: SearchResult[]): string | null {
  if (results.length === 0) return null;
  const lines = results.map((r) => {
    const tag = r.pattern === "stack" ? "STACK" : r.pattern === "typecheck-fix" ? "VERIFIED" : "PATTERN";
    return `- [${tag}] ${r.content} (confidence: ${Math.round(r.confidence * 100)}%)`;
  });
  return [
    "## PLAYBOOK (from previous verified tasks)",
    ...lines,
    "",
    "These are evidence-backed observations from verified runs. Apply them when relevant; ignore them when a task clearly calls for something different.",
  ].join("\n");
}
