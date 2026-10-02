/**
 * failure-memory.ts — Cross-turn, cross-task memory of what ACTUALLY failed.
 *
 * The Failure Doctrine in the master prompt is static ("read the error, change
 * one variable, retry differently"). This module makes it adapt at runtime: the
 * real verification outputs from the last failed task/typecheck/browser render
 * are captured, and repair turns (plus the opening turn of the NEXT task) get
 * a doctrine block that quotes the actual evidence — which files broke, which
 * errors recurred, what was already tried — instead of generic advice.
 *
 * Browser-side singleton (the worker runs in the renderer), sessionStorage-
 * persisted so it survives reloads, best-effort everywhere.
 */

const STORAGE_KEY = "orplex:failure-memory:v1";
const MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000; // yesterday's failures still teach
const MAX_ITEMS = 12;

export type FailureKind = "typecheck" | "browser" | "command" | "review";

export interface FailureRecord {
  kind: FailureKind;
  /** The actual error output, truncated to the lines that matter. */
  detail: string;
  /** File paths implicated (from the errors or the repair context). */
  files: string[];
  when: number;
  /** How many times this exact detail has recurred. */
  count: number;
}

interface FailureMemory {
  records: FailureRecord[];
  /** What repair was already attempted for the most recent failure. */
  lastRepairAt: number | null;
  lastRepairSummary: string | null;
}

let memory: FailureMemory | null = null;

function hasStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.sessionStorage;
  } catch {
    return false;
  }
}

function load(): FailureMemory {
  if (memory) return memory;
  memory = { records: [], lastRepairAt: null, lastRepairSummary: null };
  if (hasStorage()) {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as FailureMemory;
        if (Array.isArray(parsed.records)) {
          memory.records = parsed.records.filter(
            (r) => typeof r?.when === "number" && Date.now() - r.when < MAX_ENTRY_AGE_MS
          );
        }
        memory.lastRepairAt = parsed.lastRepairAt ?? null;
        memory.lastRepairSummary = parsed.lastRepairSummary ?? null;
      }
    } catch {}
  }
  return memory;
}

function save(): void {
  if (!hasStorage() || !memory) return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {}
}

/** Pull the recurring signal out of noisy verification output. */
function normalizeDetail(kind: FailureKind, detail: string): string {
  const lines = (detail || "").split(/\r?\n/);
  const interesting = lines
    .map((l) => l.trim())
    .filter((l) =>
      kind === "typecheck"
        ? /error\s+TS\d+|\.tsx?\(|cannot find|is not assignable|does not exist/.test(l)
        : kind === "browser"
          ? /error|uncaught|failed|cannot|undefined is not|404|500/.test(l)
          : /error|fail|EADDRINUSE|exit code|ENOENT|refused/.test(l)
    )
    .filter(Boolean);
  const picked = (interesting.length > 0 ? interesting : lines).slice(0, 6);
  return picked.join("\n").slice(0, 600);
}

function extractFiles(detail: string): string[] {
  const files = new Set<string>();
  const re = /([\w./\\-]+\.(?:ts|tsx|js|jsx|css|html|json|prisma))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(detail)) !== null) {
    if (!m[1].startsWith("node_modules")) files.add(m[1]);
    if (files.size >= 5) break;
  }
  return Array.from(files);
}

/** Record a verification failure. Dedups recurrences (count grows instead). */
export function recordFailure(kind: FailureKind, detail: string, files: string[] = []): void {
  const mem = load();
  const norm = normalizeDetail(kind, detail);
  if (!norm) return;
  const recent = mem.records.find(
    (r) => r.kind === kind && r.detail === norm && Date.now() - r.when < MAX_ENTRY_AGE_MS
  );
  if (recent) {
    recent.count++;
    recent.when = Date.now();
  } else {
    mem.records.push({ kind, detail: norm, files: files.slice(0, 5), when: Date.now(), count: 1 });
    if (mem.records.length > MAX_ITEMS) mem.records.shift();
  }
  save();
}

/** Mark that a repair turn was just attempted (so the next directive can say so). */
export function recordRepairAttempt(summary: string): void {
  const mem = load();
  mem.lastRepairAt = Date.now();
  mem.lastRepairSummary = summary.slice(0, 300);
  save();
}

/** Verification lane succeeded — clear that lane's history (problem solved). */
export function clearFailures(kind?: FailureKind): void {
  const mem = load();
  mem.records = kind ? mem.records.filter((r) => r.kind !== kind) : [];
  if (!kind) {
    mem.lastRepairAt = null;
    mem.lastRepairSummary = null;
  }
  save();
}

export function getFailures(): FailureRecord[] {
  return load().records.slice().sort((a, b) => b.when - a.when);
}

/**
 * Merge failure records learned elsewhere (the persistent ledger) into the
 * session store — hydrates the doctrine after a restart so the FIRST task
 * already knows what failed last time. Recurrences merge by kind + detail,
 * keeping the higher count and the freshest timestamp.
 */
export function mergeServerFailures(records: FailureRecord[]): void {
  if (!Array.isArray(records) || records.length === 0) return;
  const mem = load();
  for (const r of records) {
    if (!r || !r.kind || !r.detail) continue;
    if (!(r.kind === "typecheck" || r.kind === "browser" || r.kind === "command" || r.kind === "review")) continue;
    const norm = normalizeDetail(r.kind, r.detail) || r.detail;
    const existing = mem.records.find((x) => x.kind === r.kind && x.detail === norm);
    if (existing) {
      existing.count = Math.max(existing.count, Number(r.count) || 1);
      existing.when = Math.max(existing.when, Number(r.when) || 0);
    } else {
      mem.records.push({
        kind: r.kind,
        detail: norm,
        files: Array.isArray(r.files) ? r.files.slice(0, 5) : [],
        when: Number(r.when) || Date.now(),
        count: Number(r.count) || 1,
      });
    }
  }
  mem.records.sort((a, b) => b.when - a.when);
  if (mem.records.length > MAX_ITEMS) mem.records.length = MAX_ITEMS;
  save();
}

/**
 * Build the runtime Failure Doctrine block for repair turns / fresh tasks.
 * Returns "" when there's nothing real to teach — the static prompt section
 * is enough in that case (never pad the context with empty structure).
 */
export function buildFailureDoctrineContext(): string {
  const mem = load();
  const records = getFailures();
  if (records.length === 0) return "";

  const parts: string[] = [
    "[FAILURE CONTEXT — adapted from this workspace's real verification history]",
  ];

  const byKind = new Map<FailureKind, FailureRecord[]>();
  for (const r of records) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind)!.push(r);
  }

  for (const [kind, recs] of byKind) {
    const latest = recs[0];
    const label =
      kind === "typecheck" ? "Typecheck" : kind === "browser" ? "Browser render" : kind === "command" ? "Command" : "Review";
    parts.push(`${label} failed${latest.count > 1 ? ` ${latest.count}× (RECURRING — your previous fix did not resolve it)` : ""}:`);
    parts.push(latest.detail);
    if (latest.files.length > 0) parts.push(`Implicated files: ${latest.files.join(", ")}`);
  }

  if (mem.lastRepairSummary) {
    parts.push(`Already attempted (do NOT repeat verbatim): ${mem.lastRepairSummary}`);
  }

  parts.push(
    "Apply the Failure Doctrine to THIS evidence: fix the named files/errors at the root cause; for recurring failures change strategy, not syntax."
  );

  return parts.join("\n").slice(0, 1800);
}

/** Test/session isolation. */
export function resetFailureMemory(): void {
  memory = null;
  if (hasStorage()) {
    try { window.sessionStorage.removeItem(STORAGE_KEY); } catch {}
  }
}
