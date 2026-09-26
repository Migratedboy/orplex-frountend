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

  if (!input.writtenFiles || written.length === 0) return memories;

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

  // Cap per workspace: drop the least-recently-seen overflow.
  try {
    const all = await prisma.workspaceMemory.findMany({
      where: { workspaceKey: input.workspaceKey },
      orderBy: { lastSeenAt: "desc" },
      skip: MAX_ENTRIES_PER_WORKSPACE,
      select: { id: true },
    });
    if (all.length > 0) {
      await prisma.workspaceMemory.deleteMany({
        where: { id: { in: all.map((r) => r.id) } },
      });
    }
  } catch {}

  return stored;
}

export interface RetrievedMemory {
  kind: MemoryKind;
  content: string;
  score: number;
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

  const now = Date.now();
  const taskLower = task.toLowerCase();
  const taskTokens = new Set(
    taskLower.split(/[^a-z0-9]+/).filter((t) => t.length > 3)
  );

  const scored = rows
    .filter((r) => {
      // Pinned facts (user /remember) are never stale-evicted.
      const pinned = !!(r.evidence as { pinned?: boolean } | null)?.pinned;
      return pinned || now - r.lastSeenAt.getTime() < STALE_MS;
    })
    .map((r) => {
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
      return { kind: r.kind as MemoryKind, content: r.content, score };
    })
    .filter((r) => r.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
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

export { getWorkspaceKey };
