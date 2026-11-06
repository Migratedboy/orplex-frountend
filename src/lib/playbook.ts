// playbook.ts — Evidence-gated learning from verified runs.
//
// Derives reusable playbooks from completed tasks, merges repeated evidence
// into existing entries (confidence rises), decays contradicted ones, and
// retrieves via cosine similarity over the local embedding model.
//
// Trust model: entries only come from verified/completed runs (typecheck
// lane passed). The user can inspect, pin, edit, and delete via /api/playbook.
//
// Storage is a plain JSON file on the device — local-first, no database.
// (The DB kept this dead whenever Postgres was down, which also blanked the
// UI in dev.) One file, namespaced per project key:
//
//   <cwd>/.orplex/playbook.json     (or $ORPLEX_PLAYBOOK_FILE)
//   {
//     "version": 1,
//     "projects": {
//       "<projectId>": [ { id, pattern, content, tags, confidence, ... } ]
//     }
//   }
//
// Write contract mirrors .orplex/bundles.json: atomic write (tmp + rename),
// corrupt/unreadable file degrades to an empty store, and every mutation is
// serialized through a single in-process lock so route handlers can't interleave.

import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { embedText, cosineSimilarity } from "./embeddings";

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

interface PlaybookRow {
  id: string;
  pattern: string;
  content: string;
  tags: string[];
  confidence: number;
  verified: boolean;
  useCount: number;
  pinned: boolean;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PlaybookFile {
  version: 1;
  projects: Record<string, PlaybookRow[]>;
}

function playbookFilePath(): string {
  return process.env.ORPLEX_PLAYBOOK_FILE || join(process.cwd(), ".orplex", "playbook.json");
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
const CONFIDENCE_DECAY = 0.85;
const CONFIDENCE_BOOST = 0.1;
const MAX_CONFIDENCE = 1.0;
const MIN_CONFIDENCE = 0.1;

function rowToEntry(r: PlaybookRow): PlaybookEntry {
  const created = Date.parse(r.createdAt || "");
  const updated = Date.parse(r.updatedAt || "");
  return {
    id: r.id,
    pattern: r.pattern,
    content: r.content,
    tags: r.tags,
    confidence: r.confidence ?? 0.5,
    verified: r.verified ?? true,
    useCount: r.useCount ?? 1,
    pinned: r.pinned ?? false,
    sourceRunId: r.sourceRunId ?? null,
    createdAt: new Date(Number.isFinite(created) ? created : Date.now()),
    updatedAt: new Date(Number.isFinite(updated) ? updated : Date.now()),
  };
}

function updatedMs(r: PlaybookRow): number {
  const t = Date.parse(r.updatedAt || "");
  return Number.isFinite(t) ? t : 0;
}

// ── JSON file store ─────────────────────────────────────────────────────────

// In-process cache: the file is the only writer (single Node server process),
// so the cache stays authoritative between mutations. Dev HMR re-imports the
// module, which also resets the cache.
let cached: PlaybookFile | null = null;

function freshFile(): PlaybookFile {
  return { version: 1, projects: {} };
}

async function loadStore(): Promise<PlaybookFile> {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(await readFile(playbookFilePath(), "utf8")) as PlaybookFile;
    const projects: Record<string, PlaybookRow[]> = {};
    if (parsed && typeof parsed === "object" && parsed.projects && typeof parsed.projects === "object") {
      for (const [key, rows] of Object.entries(parsed.projects)) {
        if (Array.isArray(rows)) projects[key] = rows;
      }
    }
    cached = { version: 1, projects };
  } catch {
    cached = freshFile(); // missing OR corrupt → start empty, never throw
  }
  return cached;
}

// Write lock: every read-modify-write queues behind the previous one.
let writeChain: Promise<unknown> = Promise.resolve();

async function persist(file: PlaybookFile): Promise<void> {
  try {
    const filePath = playbookFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 1), "utf8");
    await rename(tmp, filePath);
  } catch {
    // A read-only disk or sandbox must never take the chat lane down —
    // the in-memory store keeps working; persistence just degrades.
  }
  // Cloud mirror (user decision 2026-11-06): every playbook entry also
  // upserts into the cloud DB (`learning`, id-stable upsert). Fire-and-forget
  // + bounded: the LOCAL file stays the working store; a dead cloud must
  // never block or fail the playbook lane. (Deletions do NOT propagate —
  // the mirror is a backup, stale rows are harmless.)
  void mirrorToCloud(file);
}

const CLOUD_MIRROR_ROWS_PER_PROJECT = 50;

async function mirrorToCloud(file: PlaybookFile): Promise<void> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const jobs: Promise<unknown>[] = [];
    for (const [projectId, rows] of Object.entries(file.projects)) {
      for (const r of rows.slice(-CLOUD_MIRROR_ROWS_PER_PROJECT)) {
        const data = {
          projectId,
          pattern: r.pattern,
          content: r.content,
          tags: r.tags || [],
          sourceRunId: r.sourceRunId || null,
          confidence: r.confidence ?? 0.5,
          verified: !!r.verified,
          useCount: r.useCount ?? 1,
          pinned: !!r.pinned,
        };
        jobs.push(
          prisma.learning.upsert({
            where: { id: r.id },
            update: { ...data, updatedAt: new Date(r.updatedAt || Date.now()) },
            create: { id: r.id, ...data },
          })
        );
      }
    }
    await Promise.allSettled(jobs.slice(0, 200));
  } catch {
    /* no cloud configured / unreachable — local .json is the source of truth */
  }
}

/**
 * Serialized read-modify-write. The mutator receives the cached file and
 * returns `{ out, changed }`; both the mutation result and the file write
 * happen strictly in chain, in order.
 */
function withStore<T>(
  mutator: (file: PlaybookFile) => Promise<{ out: T; changed: boolean }>
): Promise<{ out: T; changed: boolean }> {
  const run = writeChain.then(async () => {
    const file = await loadStore();
    const result = await mutator(file);
    if (result.changed) {
      cached = file; // keep the cache pointing at the persisted state
      await persist(file);
    }
    return result;
  });
  writeChain = run.catch(() => {});
  return run;
}

/** Newest-first rows of one project as hydrated entries. */
async function readProject(projectId: string): Promise<PlaybookEntry[]> {
  const file = await loadStore();
  return (file.projects[projectId] || [])
    .slice()
    .sort((a, b) => updatedMs(b) - updatedMs(a))
    .map(rowToEntry);
}

// ── Derivation (pure — unchanged) ───────────────────────────────────────────

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
 * old ones decay. Otherwise creates a new entry (capped per project, pins
 * never evicted).
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
  const nowIso = new Date().toISOString();

  const { out } = await withStore(async (file) => {
    const rows = file.projects[projectId] || [];
    file.projects[projectId] = rows;

    // Match against EVERY row with this pattern (newest first), not just the
    // first: flip-flopping evidence must boost the matching row when one
    // exists instead of decaying an arbitrary sibling and growing a new row.
    rows.sort((a, b) => updatedMs(b) - updatedMs(a));
    const siblings = rows.filter((r) => r.pattern === entry.pattern);
    const match = siblings.find((r) => hashContent(r.content) === contentHash);

    if (match) {
      // Same evidence — boost confidence
      match.confidence = Math.min(MAX_CONFIDENCE, (match.confidence ?? 0.5) + CONFIDENCE_BOOST);
      match.useCount = (match.useCount ?? 1) + 1;
      match.tags = entry.tags;
      match.sourceRunId = sourceRunId || match.sourceRunId;
      match.verified = true;
      match.updatedAt = nowIso;
      return { out: rowToEntry(match), changed: true };
    }

    // No identical row: decay every contradicting sibling, then store the new
    // evidence as its own row below.
    for (const r of siblings) {
      r.confidence = Math.max(MIN_CONFIDENCE, (r.confidence ?? 0.5) * CONFIDENCE_DECAY);
      r.updatedAt = nowIso;
    }

    rows.push({
      id: randomUUID(),
      pattern: entry.pattern,
      content,
      tags: entry.tags,
      confidence: 0.5,
      verified: true,
      useCount: 1,
      pinned: false,
      sourceRunId: sourceRunId || null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    // Cap per project: drop the oldest non-pinned overflow. Pinned rows are
    // excluded from BOTH the overflow read and the delete — a user pin must
    // never be silently evicted.
    const evictedIds = new Set(
      rows
        .filter((r) => !r.pinned)
        .sort((a, b) => updatedMs(b) - updatedMs(a))
        .slice(MAX_ENTRIES_PER_PROJECT)
        .map((r) => r.id)
    );
    if (evictedIds.size > 0) {
      file.projects[projectId] = rows.filter((r) => !evictedIds.has(r.id));
    }

    return { out: null as PlaybookEntry | null, changed: true };
  });

  if (out) return out;
  // Creation path: read back the just-created row (the cap may have even
  // evicted it immediately if it overflowed a full project — then it's gone).
  const newest = (await readProject(projectId)).find((e) => e.pattern === entry.pattern && hashContent(e.content) === contentHash);
  return newest ?? null;
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
  const rows = (await readProject(projectId)).slice(0, MAX_ENTRIES_PER_PROJECT);

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
    score += Math.min(2, Math.log2(1 + r.useCount));
    score += r.confidence;

    const contentLower = r.content.toLowerCase();
    for (const t of taskTokens) {
      if (contentLower.includes(t)) score += 0.5;
    }

    scored.push({
      id: r.id,
      pattern: r.pattern,
      content: r.content,
      tags: r.tags,
      confidence: r.confidence,
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
  return (await readProject(projectId)).slice(0, 200);
}

/**
 * Update a playbook entry (pin/edit).
 */
export async function updatePlaybook(
  id: string,
  projectId: string,
  data: { content?: string; pinned?: boolean; tags?: string[] }
): Promise<PlaybookEntry | null> {
  const { out } = await withStore(async (file) => {
    const rows = file.projects[projectId] || [];
    const existing = rows.find((r) => r.id === id);
    if (!existing) return { out: null, changed: false };
    if (data.content !== undefined) existing.content = data.content.slice(0, MAX_CONTENT_CHARS);
    if (data.pinned !== undefined) existing.pinned = data.pinned;
    if (data.tags !== undefined) existing.tags = data.tags;
    existing.updatedAt = new Date().toISOString();
    return { out: rowToEntry(existing), changed: true };
  });
  return out;
}

/**
 * Delete a playbook entry.
 */
export async function deletePlaybook(id: string, projectId: string): Promise<boolean> {
  const { out } = await withStore(async (file) => {
    const rows = file.projects[projectId] || [];
    const next = rows.filter((r) => r.id !== id);
    const changed = next.length < rows.length;
    file.projects[projectId] = next;
    return { out: changed, changed };
  });
  return out;
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

/** Test hook: drop the in-memory cache so each test starts from its file. */
export function resetPlaybookCacheForTests(): void {
  cached = null;
  writeChain = Promise.resolve();
}
