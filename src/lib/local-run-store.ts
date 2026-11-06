// local-run-store.ts — Device-local .json mirror for verification runs.
//
// PURPOSE (LIVE failure 2026-11-06): the desktop/dev box's Postgres is often
// DOWN entirely (`Can't reach database server at localhost:5433` floods), and
// /api/agent/verify used to persist runs + artifacts ONLY via prisma. Every
// out-of-DB verdict was dropped on the floor (or, before the best-effort
// fix, 500'd the whole call and the agent read its own PASS/FAIL as "the
// harness crashed"). The DB stays the primary store — this is the same
// pattern as workspace-cwd's durable `.orplex/workspaces.json`: a
// DEVICE-LOCAL file that keeps the data alive when the database is not.
//
// Never throws: a read-only disk must not break verification. Atomic writes
// (tmp + rename), bounded growth (oldest runs evicted).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LocalRunArtifact {
  kind: string;
  name: string;
  mediaType: string;
  content: string;
}

export interface LocalVerifyRun {
  /** "local:<hex>" — never collides with a prisma cuid. */
  id: string;
  userId: string;
  prompt: string;
  status: string;
  workspace: string;
  createdAt: string;
  /** Raw prisma AgentRun.verifyResult JSON (kept shape-compatible). */
  verifyResult: unknown;
  /** Raw prisma AgentTask JSON (kept shape-compatible). */
  task: unknown;
  /** Raw prisma RunEvent JSON (kept shape-compatible). */
  event: unknown;
  artifacts: LocalRunArtifact[];
}

const MAX_RUNS = 50;
/** Skip persisting a single artifact bigger than this (a video/webm can be huge). */
const MAX_ARTIFACT_CHARS = 4_000_000;
/** Drop oldest runs once the JSON exceeds this size (screenshots add up fast). */
const MAX_FILE_CHARS = 20_000_000;

function storeFilePath(): string {
  return process.env.ORPLEX_VERIFY_RUNS_FILE || join(process.cwd(), ".orplex", "verify-runs.json");
}

interface StoreFile {
  runs: LocalVerifyRun[];
}

function readStore(): StoreFile {
  try {
    const raw = readFileSync(storeFilePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (parsed && Array.isArray(parsed.runs)) return parsed;
  } catch {
    // No file yet (or unreadable) → start from an empty store.
  }
  return { runs: [] };
}

function writeStore(store: StoreFile): void {
  try {
    const file = storeFilePath();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 1), "utf8");
    renameSync(tmp, file);
  } catch {
    // Read-only location → the DB (or nothing) stays the source of truth.
  }
}

/** Bounded drop-oldest eviction. */
function truncate(store: StoreFile): void {
  while (store.runs.length > MAX_RUNS) store.runs.shift();
  while (JSON.stringify(store).length > MAX_FILE_CHARS && store.runs.length > 1) {
    store.runs.shift();
  }
}

export function saveVerifyRunLocally(rec: {
  userId: string;
  prompt: string;
  status: string;
  workspace: string;
  verifyResult: unknown;
  task: unknown;
  event?: unknown;
  artifacts?: LocalRunArtifact[];
}): string {
  const id = `local:${Math.random().toString(16).slice(2, 10)}`;
  const artifacts = (rec.artifacts || []).filter(
    (a) => typeof a.content === "string" && a.content.length <= MAX_ARTIFACT_CHARS
  );
  const store = readStore();
  store.runs.push({
    id,
    userId: rec.userId,
    prompt: rec.prompt,
    status: rec.status,
    workspace: rec.workspace,
    createdAt: new Date().toISOString(),
    verifyResult: rec.verifyResult,
    task: rec.task,
    event: rec.event ?? null,
    artifacts,
  });
  truncate(store);
  writeStore(store);
  return id;
}

/** Newest-first read (APIs/tests can surface locally-saved verify data). */
export function listLocalVerifyRuns(userId?: string): LocalVerifyRun[] {
  const runs = readStore().runs;
  const filtered = userId ? runs.filter((r) => r.userId === userId) : runs;
  return [...filtered].reverse();
}
