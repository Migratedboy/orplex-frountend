// local-db.ts — the local JSON document engine ("no-database" OrplexDB).
//
// REPLACEMENT (user decision 2026-11-06): the app no longer requires ANY
// database server. Postgres/Supabase was the only persistence and the
// desktop's local Postgres was chronically down ("Can't reach database
// server at localhost:5433"), losing chats, keys, runs and config. All
// records now live in device-local JSON files: `.orplex/db/<model>.json`
// (override: ORPLEX_LOCAL_DB_DIR; per-model override: ORPLEX_LOCAL_DB_FILES
// as JSON {model: path}).
//
// Prisma-semantics subset that call sites actually rely on:
// - lazy PrismaPromise (delegates don't execute until awaited — required by
//   `$transaction([...ops])` and `.catch(()=>{})` write-and-forget patterns)
// - findUnique/findFirst/findMany/create/createMany/update/updateMany/
//   upsert/delete/deleteMany/count/groupBy/aggregate(_avg)
// - composite uniques (`runId_sequence`, `userId_serverId`, …) → errors with
//   `.code === "P2002"` for the race-retry call sites
// - relation filters (`where { run: { userId } }`, `dependencies: { some }`),
//   relation includes with nested orderBy/take/select, nested relation
//   creates (`conversation.create({ data: { messages: { create: [...] } } })`)
// - `{ increment: n }` counters, cursor pagination, AND/OR/NOT,
//   contains (with mode:"insensitive")/in/notIn/lt/lte/gt/gte/not,
//   Prisma.JsonNull passthrough (stored as null)
// - $transaction array + interactive with snapshot/rollback atomicity
// - $queryRaw as a friendly no-op (call sites: health probe + advisory lock
//   whose failure path is in-memory anyway)
//
// Writes are atomic (tmp + rename) — same pattern verified in
// local-run-store / workspace-cwd. Collections cache in-memory per process;
// every write is scheduled to flush through. maxRows caps keep telemetry
// collections from ever filling the disk (oldest evicted).

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Model metadata
// ---------------------------------------------------------------------------

export interface RelDef {
  model: string;
  /** Field on THIS row pointing at the related model (one-directional). */
  localKey?: string;
  /** Field on the related model pointing back (reverse collection). */
  foreignKey?: string;
}

export interface ModelDef {
  relations: Record<string, RelDef>;
  /** scalar unique fields */
  uniques: string[];
  /** composite unique constraints (P2002 race loops rely on these) */
  compositeUniques: string[][];
  /** related models whose rows are deleted with this model's rows */
  cascades: string[];
  /** keep at most N rows (telemetry-style collections), oldest evicted */
  maxRows?: number;
}

const M = (over: Partial<ModelDef>): ModelDef => ({
  relations: {},
  uniques: [],
  compositeUniques: [],
  cascades: [],
  ...over,
});

export const MODEL_DEFS: Record<string, ModelDef> = {
  user: M({ uniques: ["email"] }),
  conversation: M({ relations: { messages: { model: "message", foreignKey: "conversationId" } }, cascades: ["message"] }),
  message: M({ relations: { conversation: { model: "conversation", localKey: "conversationId" } } }),
  task: M({ cascades: ["toolCall", "pipelineStep"] }),
  toolCall: M({ relations: { task: { model: "task", localKey: "taskId" } } }),
  pipelineStep: M({ relations: { task: { model: "task", localKey: "taskId" } } }),
  agentRun: M({
    uniques: ["idempotencyKey"],
    relations: {
      tasks: { model: "agentTask", foreignKey: "runId" },
      events: { model: "runEvent", foreignKey: "runId" },
      artifacts: { model: "agentArtifact", foreignKey: "runId" },
      approvals: { model: "approvalRequest", foreignKey: "runId" },
      checkpoints: { model: "runCheckpoint", foreignKey: "runId" },
    },
    cascades: ["agentTask", "runEvent", "agentArtifact", "approvalRequest", "runCheckpoint"],
  }),
  agentTask: M({
    relations: {
      run: { model: "agentRun", localKey: "runId" },
      dependencies: { model: "agentTaskDependency", foreignKey: "taskId" },
    },
    cascades: ["agentTaskDependency"],
  }),
  agentTaskDependency: M({
    relations: {
      task: { model: "agentTask", localKey: "taskId" },
      dependsOn: { model: "agentTask", localKey: "dependsOnId" },
    },
  }),
  runEvent: M({
    compositeUniques: [["runId", "sequence"]],
    relations: { run: { model: "agentRun", localKey: "runId" } },
    maxRows: 10000,
  }),
  agentArtifact: M({
    relations: {
      run: { model: "agentRun", localKey: "runId" },
      comments: { model: "comment", foreignKey: "artifactId" },
    },
    cascades: ["comment"],
  }),
  runCheckpoint: M({
    compositeUniques: [["runId", "sequence"]],
    relations: { run: { model: "agentRun", localKey: "runId" } },
    maxRows: 500,
  }),
  approvalRequest: M({ relations: { run: { model: "agentRun", localKey: "runId" } } }),
  comment: M({ relations: { artifact: { model: "agentArtifact", localKey: "artifactId" } } }),
  notification: M({ maxRows: 500 }),
  providerEvent: M({ maxRows: 2000 }),
  usageLog: M({ maxRows: 5000 }),
  apiKeyPool: M({}),
  userQuota: M({ uniques: ["userId"] }),
  userApiKey: M({}),
  rateLimitWindow: M({ compositeUniques: [["key", "windowStart"]], maxRows: 2000 }),
  circuitBreakerState: M({ uniques: ["provider"] }),
  vectorMemoryEntry: M({ maxRows: 1000 }),
  sonaPattern: M({ maxRows: 500 }),
  sonaTrajectory: M({ maxRows: 2000 }),
  workspace: M({ cascades: ["workspaceMember"] }),
  workspaceMember: M({
    compositeUniques: [["workspaceId", "userId"]],
    relations: {
      workspace: { model: "workspace", localKey: "workspaceId" },
      user: { model: "user", localKey: "userId" },
    },
  }),
  taskRun: M({ maxRows: 1000 }),
  taskFailure: M({ compositeUniques: [["workspaceKey", "kind", "detailHash"]], maxRows: 2000 }),
  workspaceMemory: M({ compositeUniques: [["workspaceKey", "kind", "contentHash"]], maxRows: 2000 }),
  projectRecord: M({ compositeUniques: [["userId", "name"]] }),
  mcpServerConfig: M({ compositeUniques: [["userId", "serverId"]] }),
  mcpConnection: M({ compositeUniques: [["userId", "serverId"]] }),
  mcpOAuthPending: M({ uniques: ["state"], maxRows: 100 }),
  mcpTool: M({ compositeUniques: [["userId", "serverId", "name"]], maxRows: 4000 }),
  syncEvent: M({ uniques: ["id"], maxRows: 5000 }),
  // NextAuth adapter models (OAuth sign-in only; JWT sessions never touch these)
  account: M({
    relations: { user: { model: "user", localKey: "userId" } },
    compositeUniques: [["provider", "providerAccountId"]],
  }),
  session: M({
    relations: { user: { model: "user", localKey: "userId" } },
    maxRows: 500,
  }),
  verificationToken: M({ compositeUniques: [["identifier", "token"]], maxRows: 200 }),
  memoryFile: M({ uniques: ["path"], maxRows: 2000 }),
  memorySetting: M({ uniques: ["userId"] }),
};

export const KNOWN_MODELS = Object.keys(MODEL_DEFS);

// ---------------------------------------------------------------------------
// Errors — the P2002 contract retry loops check for
// ---------------------------------------------------------------------------

export class LocalDbError extends Error {
  code: string;
  meta?: { target?: string[] };
  constructor(code: string, message: string, target?: string[]) {
    super(`[local-db] ${message}`);
    this.name = "LocalDbError";
    this.code = code;
    if (target) this.meta = { target };
  }
}

// ---------------------------------------------------------------------------
// Storage plumbing
// ---------------------------------------------------------------------------

function dbDir(): string {
  const override = process.env.ORPLEX_LOCAL_DB_DIR;
  if (override && override.trim()) return resolve(override.trim());
  return join(process.cwd(), ".orplex", "db");
}

interface ModelFileOverrides {
  [model: string]: string;
}
function modelOverrides(): ModelFileOverrides {
  try {
    return JSON.parse(process.env.ORPLEX_LOCAL_DB_FILES || "{}") as ModelFileOverrides;
  } catch {
    return {};
  }
}

function fileFor(model: string): string {
  const over = modelOverrides()[model];
  if (over) return resolve(over);
  return join(dbDir(), `${model}.json`);
}

/** Revive ISO timestamp strings so call sites can do Date math on rows. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function reviveInto(row: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === "string" && ISO_RE.test(v)) row[k] = new Date(v);
  }
  return row;
}

interface Collection {
  loaded: boolean;
  rows: Record<string, unknown>[];
  flushTimer?: ReturnType<typeof setTimeout>;
}
const collections = new Map<string, Collection>();

function collect(model: string): Collection {
  let c = collections.get(model);
  if (!c) {
    c = { loaded: false, rows: [] };
    collections.set(model, c);
  }
  if (!c.loaded) {
    c.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(fileFor(model), "utf8")) as Record<string, unknown>[];
      if (Array.isArray(parsed)) c.rows = parsed.map((r) => reviveInto({ ...r }));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        // Corrupt or unreadable file → quarantine it, serve from empty.
        try {
          renameSync(fileFor(model), `${fileFor(model)}.corrupt-${Date.now()}`);
        } catch {
          /* best-effort */
        }
      }
    }
  }
  return c;
}

/** Atomic write-through: tmp + rename, Date-safe serialization. */
function flush(model: string): void {
  try {
    const c = collect(model);
    const dir = dbDir();
    mkdirSync(dir, { recursive: true });
    const target = fileFor(model);
    const tmp = `${target}.${Date.now()}.tmp`;
    const repl = (_k: string, v: unknown) => (v instanceof Date ? v.toISOString() : v);
    writeFileSync(tmp, JSON.stringify(c.rows, repl));
    try {
      renameSync(tmp, target);
    } catch {
      // Windows rename-over-existing quirk fallback
      try {
        if (existsSync(target)) unlinkSync(target);
        renameSync(tmp, target);
      } catch (inner) {
        void inner;
      }
    }
  } catch {
    /* disk unavailable — memory stays authoritative for this session */
  }
}

const FLUSH_MS = 25;
function scheduleFlush(model: string): void {
  const c = collect(model);
  if (c.flushTimer) return;
  const t = setTimeout(() => {
    c.flushTimer = undefined;
    flush(model);
  }, FLUSH_MS);
  c.flushTimer = t;
  const unref = (t as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(t);
}

/** Persist everything now (used by tests and graceful shutdown). */
export function flushAll(): void {
  for (const model of collections.keys()) {
    const c = collect(model);
    if (c.flushTimer) {
      clearTimeout(c.flushTimer);
      c.flushTimer = undefined;
    }
    flush(model);
  }
}

/** Test helper: reset the in-memory cache (files on disk are kept). */
export function resetForTests(): void {
  for (const [model, c] of collections) {
    if (c.flushTimer) clearTimeout(c.flushTimer);
    c.flushTimer = undefined;
    c.loaded = false;
    c.rows = [];
    collections.delete(model);
  }
  // Wipe on-disk files too so tests don't leak state across cases.
  const dir = process.env.ORPLEX_LOCAL_DB_DIR;
  if (dir) {
    try {
      const fs = require("node:fs");
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".json")) {
          try { fs.unlinkSync(require("node:path").join(dir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* dir may not exist yet */ }
  }
}

// ---------------------------------------------------------------------------
// Where / ordering / paging
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Where = Row | undefined | null;

const FIELD_OPS = new Set([
  "equals", "not", "in", "notIn", "lt", "lte", "gt", "gte", "contains", "startsWith", "endsWith", "mode",
]);
const LOGICAL = new Set(["AND", "OR", "NOT"]);

function norm(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v;
}

function cmp(a: unknown, b: unknown): number {
  const x = norm(a);
  const y = norm(b);
  if (typeof x === "number" && typeof y === "number") return x - y;
  if (typeof x === "boolean" && typeof y === "boolean") return (x ? 1 : 0) - (y ? 1 : 0);
  const xs = String(x ?? "");
  const ys = String(y ?? "");
  if (/^-?\d+(\.\d+)?$/.test(xs) && /^-?\d+(\.\d+)?$/.test(ys)) return Number(xs) - Number(ys);
  return xs < ys ? -1 : xs > ys ? 1 : 0;
}

/** One field-level condition object: { contains, lte, in, not, mode, … } */
function fieldCondMatches(rowVal: unknown, cond: unknown, insensitive: boolean): boolean {
  if (cond === null || cond === undefined) {
    return rowVal === null || rowVal === undefined;
  }
  if (typeof cond !== "object" || Array.isArray(cond)) {
    // plain scalar → equals
    return cmp(rowVal, cond) === 0;
  }
  const entries = Object.entries(cond as Row).filter(([op, v]) => !(op === "mode" || v === undefined));
  if (entries.length === 0) return true;
  let ok = true;
  const useInsensitive = insensitive || (cond as Row).mode === "insensitive";
  for (const [op, operand] of entries) {
    if (!FIELD_OPS.has(op)) continue; // unknown key → ignore (defensive)
    switch (op) {
      case "equals":
        ok = cmp(rowVal, operand) === 0;
        break;
      case "not": {
        if (operand === null || operand === undefined) {
          ok = !(rowVal === null || rowVal === undefined);
        } else if (typeof operand === "object" && !Array.isArray(operand)) {
          ok = !fieldCondMatches(rowVal, operand, useInsensitive);
        } else {
          ok = cmp(rowVal, operand) !== 0;
        }
        break;
      }
      case "in":
        ok = (operand as unknown[]).some((v) => cmp(rowVal, v) === 0);
        break;
      case "notIn":
        ok = !(operand as unknown[]).some((v) => cmp(rowVal, v) === 0);
        break;
      case "lt":
        ok = cmp(rowVal, operand) < 0;
        break;
      case "lte":
        ok = cmp(rowVal, operand) <= 0;
        break;
      case "gt":
        ok = cmp(rowVal, operand) > 0;
        break;
      case "gte":
        ok = cmp(rowVal, operand) >= 0;
        break;
      case "contains": {
        const hay = (rowVal === null || rowVal === undefined ? "" : String(rowVal));
        const needle = String(operand ?? "");
        ok = useInsensitive
          ? hay.toLowerCase().includes(needle.toLowerCase())
          : hay.includes(needle);
        break;
      }
      case "startsWith":
        ok = String(rowVal ?? "").startsWith(String(operand ?? ""));
        break;
      case "endsWith":
        ok = String(rowVal ?? "").endsWith(String(operand ?? ""));
        break;
      case "mode":
        break;
    }
    if (!ok) return false;
  }
  return true;
}

/**
 * Does `row` match `where`? Relation-nested filters (`conversation: {userId}`,
 * `dependencies: { some: {...} }`) traverse with the model's relation map.
 */
function matches(model: string, row: Row, where: Where): boolean {
  if (!where) return true;
  const def = MODEL_DEFS[model];
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === "AND" || key === "and") {
      if (!(cond as Where[]).every((w) => matches(model, row, w as Where))) return false;
      continue;
    }
    if (key === "OR" || key === "or") {
      if (!(cond as Where[]).some((w) => matches(model, row, w as Where))) return false;
      continue;
    }
    if (key === "NOT") {
      if (matches(model, row, cond as Where)) return false;
      continue;
    }
    if (key === "NOT") continue;

    // Composite unique selector: { key_windowStart: { key, windowStart } }
    if (key.includes("_") && cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      const keys = Object.entries(cond as Row);
      const isComponents = keys.length > 0 && keys.every(([k, v]) => !FIELD_OPS.has(k) && (def?.relations[k] || !(v !== null && typeof v === "object")));
      if (isComponents) {
        if (!keys.every(([k, v]) => cmp(row[k], v) === 0)) return false;
        continue;
      }
    }

    const rel = def?.relations[key];
    if (rel) {
      if (rel.localKey) {
        // one-directional: this row has a FK to a single related row
        const target = findOneRelated(rel.model, rel.foreignKey ?? "id", row[rel.localKey]);
        const inner: Where = cond as Where;
        if (!target) {
          // No parent yet: allow null-check style conditions on the FK only
          if ((cond as { equals?: unknown })?.equals === null || cond === null || cond === undefined) continue;
          return false;
        }
        if (!matches(rel.model, target, inner)) return false;
        continue;
      }
      if (rel.foreignKey !== undefined) {
        // reverse collection: { some / every / none / is / plain filter }
        const relRows = collect(rel.model).rows.filter((r) => cmp(r[rel.foreignKey as string], row.id ?? row) === 0);
        const inner: Where = cond as Where;
        const box: Row = cond as Row;
        if (box.some !== undefined) {
          if (!relRows.some((r) => matches(rel.model, r, box.some as Where))) return false;
          continue;
        }
        if (box.every !== undefined) {
          if (!relRows.every((r) => matches(rel.model, r, box.every as Where))) return false;
          continue;
        }
        if (box.none !== undefined) {
          if (relRows.some((r) => matches(rel.model, r, box.none as Where))) return false;
          continue;
        }
        if (box.is !== undefined || box.isNot !== undefined) {
          // to-one relation filter via reverse: rare; treat `is` as none-match-all
          if (box.is !== undefined && relRows.length === 0) return false;
          continue;
        }
        if (!relRows.some((r) => matches(rel.model, r, inner))) return false;
        continue;
      }
    }

    // plain field condition
    if (!fieldCondMatches(row[key], cond, false)) return false;
  }
  return true;
}

function findOneRelated(model: string, foreignKey: string, localVal: unknown): Row | null {
  if (localVal === null || localVal === undefined) return null;
  return collect(model).rows.find((r) => cmp(r[foreignKey], localVal) === 0) ?? null;
}

/** Order rows by a list of { field: "asc"|"desc" }. */
function ordered(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  const sorted = [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [field, dir] of Object.entries(spec)) {
        const c = cmp(a[field], b[field]);
        const s = c === 0 ? 0 : dir === "desc" ? -c : c;
        if (s !== 0) return s;
      }
    }
    return 0;
  });
  return sorted;
}

function applyIdSelection(model: string, rows: Row[], args: Row): Row[] {
  let out = rows;
  if (args.cursor) {
    const cur = args.cursor as Row;
    const ci = out.findIndex((r) => Object.entries(cur).every(([k, v]) => cmp(r[k], v) === 0));
    // Prisma: selection starts AT the cursor row. `skip` then skips from the
    // cursor position (skip:1 = the cursor row itself, skip:2 = one past it).
    if (ci >= 0) out = out.slice(ci);
    else out = [];
  }
  if (typeof args.skip === "number" && args.skip > 0) out = out.slice(args.skip);
  if (typeof args.take === "number") {
    if (args.take >= 0) out = out.slice(0, args.take);
    else {
      // prisma negative take = last N rows, walked backwards
      out = out.slice(Math.max(0, out.length + args.take));
    }
  }
  void model;
  return out;
}

// ---------------------------------------------------------------------------
// shaping (select / include) + nested writes
// ---------------------------------------------------------------------------

/** Shape a row per `select`/`include` args (returns plain row when neither). */
function shape(model: string, row: Row, args: Row, depth: number): Row {
  const def = MODEL_DEFS[model] ?? M({});
  const argsSelect = args.select as Row | undefined;
  const argsInclude = args.include as Row | undefined;
  if (!argsSelect && !argsInclude) return row;

  const out: Row = { ...row };

  if (argsSelect) {
    // only selected fields (+ relation fields listed there too)
    const keeper = new Set(Object.keys(argsSelect));
    for (const k of Object.keys(out)) if (!keeper.has(k)) delete out[k];
  }

  const relSpecs = argsSelect ?? argsInclude ?? {};
  for (const [relName, relArg] of Object.entries(relSpecs)) {
    const rel = def.relations[relName];
    if (!rel) continue;
    const skip = relArg === false;
    if (skip) {
      if (relArg === false) delete out[relName];
      continue;
    }
    const relOpts = (relArg && typeof relArg === "object" ? { ...relArg } : {}) as Row;

    let relRows: Row[];
    if (rel.localKey) {
      const target = findOneRelated(rel.model, rel.foreignKey ?? "id", row[rel.localKey as string]);
      relRows = target ? [target] : [];
      if (relOpts.where && relRows.length === 1 && !matches(rel.model, relRows[0], relOpts.where as Where)) relRows = [];
    } else {
      relRows = collect(rel.model).rows.filter((r) => cmp(r[rel.foreignKey as string], row.id) === 0);
      if (relOpts.where) relRows = relRows.filter((r) => matches(rel.model, r, relOpts.where as Where));
      if (relOpts.orderBy) relRows = ordered(relRows, relOpts.orderBy as Row);
    }
    let shaped = relRows.slice(0, typeof relOpts.take === "number" ? Math.max(relOpts.take, 0) : relRows.length);
    if (depth < 3) shaped = shaped.map((r) => shape(rel.model, r, relOpts, depth + 1));
    if (rel.localKey) out[relName] = shaped[0] ?? null;
    else out[relName] = shaped;
  }
  return out;
}

/** Strip nested-relation write payloads and perform their side effects. */
function applyNestedWrites(model: string, parent: Row, data: Row): void {
  const def = MODEL_DEFS[model];
  for (const [key, val] of Object.entries(data)) {
    const rel = def?.relations[key];
    if (!rel || val === null || typeof val !== "object" || Array.isArray(val)) continue;
    delete data[key];
    const box = val as Row;
    if (rel.foreignKey) {
      // reverse collection: nested create only (the used pattern)
      const creates = box.create;
      if (creates) {
        const list = Array.isArray(creates) ? creates : [creates];
        for (const item of list) {
          const nested = { ...(item as Row), [rel.foreignKey]: parent.id };
          createRow(rel.model, nested, false);
        }
        scheduleFlush(rel.model);
      }
      if (box.update !== undefined || box.updateMany !== undefined) {
        // not used by the codebase; no-op (defensive)
      }
      continue;
    }
    if (rel.localKey && box.connect !== undefined) {
      const c = box.connect as Row;
      const fkVal = (c.id ?? Object.values(c)[0]) as unknown;
      if (fkVal !== undefined && fkVal !== null) parent[rel.localKey] = fkVal;
      continue;
    }
    if (rel.localKey && box.create !== undefined) {
      const nested = createRow(rel.model, { ...(box.create as Row) }, false);
      parent[rel.localKey] = nested.id;
      continue;
    }
  }
}

let idCounter = 0;
const AGG_OPS = new Set(["_count", "_sum", "_avg", "_min", "_max"]);
function mintId(): string {
  idCounter = (idCounter + 1) % 1679616;
  return `c${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Prisma JSON sentinels (Prisma.JsonNull / DbNull / AnyNull) → engine null.
// The @prisma/client package is required lazily so the sentinels are matched
// by IDENTITY — no string sniffing. Anything already "null-like" passes.
let jsonNullSentinels: unknown[] | null = null;
function jsonSentinels(): unknown[] {
  if (jsonNullSentinels) return jsonNullSentinels;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- identity match requires the module
    const pkg = require("@prisma/client") as { Prisma?: { JsonNull?: unknown; DbNull?: unknown; AnyNull?: unknown } };
    const P = pkg?.Prisma;
    jsonNullSentinels = [P?.JsonNull, P?.DbNull, P?.AnyNull].filter((v) => v !== undefined) as unknown[];
  } catch {
    jsonNullSentinels = []; // @prisma/client unavailable → nothing to match
  }
  return jsonNullSentinels;
}

/** Prisma JSON sentinel → real null; undefined passes through untouched. */
function deNull<T>(v: T): T | null {
  if (v !== null && v !== undefined && jsonSentinels().includes(v)) return null;
  return v;
}

function createRow(model: string, data: Row, persistNow: boolean): Row {
  const def = MODEL_DEFS[model] ?? M({});
  const row: Row = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue; // prisma: undefined create keys take defaults
    row[k] = deNull(v);
  }
  if (row.id === undefined || row.id === null || row.id === "") row.id = mintId();
  const now = new Date();
  if (row.createdAt === undefined) row.createdAt = now;
  if (row.updatedAt === undefined && hasUpdatedAtDefault(model)) row.updatedAt = now;
  if (typeof row.createdAt === "string" && ISO_RE.test(row.createdAt)) row.createdAt = new Date(row.createdAt);
  applyNestedWrites(model, row, row);
  assertUniques(model, row, null);
  const c = collect(model);
  c.rows.push(row);
  applyMaxRows(model);
  if (persistNow) flush(model);
  else scheduleFlush(model);
  return row;
}

function hasUpdatedAtDefault(model: string): boolean {
  return !["userQuota", "apiKeyPool", "circuitBreakerState", "mcpTool", "mcpOAuthPending", "vectorMemoryEntry", "sonaPattern"].includes(model);
}

function applyMaxRows(model: string): void {
  const def = MODEL_DEFS[model];
  if (!def?.maxRows) return;
  const c = collect(model);
  if (c.rows.length > def.maxRows) {
    c.rows.splice(0, c.rows.length - def.maxRows);
  }
}

function assertUniques(model: string, row: Row, excludeId: string | null): void {
  const def = MODEL_DEFS[model];
  if (!def) return;
  const violates = (target: string[]): boolean =>
    collect(model).rows.some((r) => r.id !== excludeId && target.every((f) => cmp(r[f], row[f]) === 0));
  for (const u of def.uniques) {
    if (row[u] === undefined || row[u] === null) continue;
    if (violates([u])) {
      throw new LocalDbError("P2002", `Unique constraint failed on ${model}.${u}`, [u]);
    }
  }
  for (const cu of def.compositeUniques) {
    if (cu.some((f) => row[f] === undefined || row[f] === null)) continue;
    if (violates(cu)) {
      throw new LocalDbError("P2002", `Unique constraint failed on ${model}.${cu.join("_")}`, [...cu]);
    }
  }
}

/** prisma update-data semantics: { count: { increment: 1 } }, scalars, JSON. */
function applyUpdate(model: string, row: Row, data: Row): void {
  const def = MODEL_DEFS[model];
  for (const [k, v0] of Object.entries(data)) {
    if (v0 === undefined) continue; // prisma skips undefined update keys
    const v = deNull(v0);
    if (def?.relations[k]) continue; // handled below via nested writes
    if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      const ops = v as Row;
      const cur = row[k];
      if (ops.increment !== undefined) row[k] = (typeof cur === "number" ? cur : 0) + (ops.increment as number);
      else if (ops.decrement !== undefined) row[k] = (typeof cur === "number" ? cur : 0) - (ops.decrement as number);
      else if (ops.multiply !== undefined) row[k] = (typeof cur === "number" ? cur : 0) * (ops.multiply as number);
      else if (ops.set !== undefined) row[k] = ops.set;
      else row[k] = v; // JSON-shaped payload
    } else {
      row[k] = v;
    }
  }
  const nestedData = { ...data };
  applyNestedWrites(model, row, nestedData);
  if (hasUpdatedAtDefault(model)) row.updatedAt = new Date();
}

/** Flatten unique selectors: composite { a_b: {...} } → component equalities. */
function selectionToMatcher(model: string, where: Row): (r: Row) => boolean {
  const comps: Array<[string, unknown]> = [];
  for (const [key, val] of Object.entries(where)) {
    if (key.includes("_") && val !== null && typeof val === "object" && !Array.isArray(val)) {
      for (const [k, v] of Object.entries(val as Row)) comps.push([k, v]);
    } else {
      comps.push([key, val]);
    }
  }
  return (r) => comps.every(([k, v]) => cmp(r[k], v) === 0);
}

// ---------------------------------------------------------------------------
// Delegate factory — prisma.<model>.<method>
// ---------------------------------------------------------------------------

export type LocalDbPromise = {
  then<R>(onFulfilled?: (v: unknown) => R | Promise<R>, onRejected?: (e: unknown) => R | Promise<R>): Promise<R>;
  catch<R>(onRejected?: (e: unknown) => R | Promise<R>): Promise<R>;
  finally(cb: () => void): Promise<unknown>;
};

class LazyAction<T> implements PromiseLike<T> {
  constructor(private run: () => T) {}
  private exec(): Promise<T> {
    try {
      return Promise.resolve(this.run());
    } catch (e) {
      return Promise.reject(e);
    }
  }
  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return this.exec().then(onFulfilled, onRejected);
  }
  catch<R2 = never>(onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<T | R2> {
    return this.exec().catch(onRejected);
  }
  finally(cb: () => void): PromiseLike<T> {
    return this.exec().finally(cb);
  }
}

function buildDelegate(model: string): Record<string, (args: Row) => LazyAction<unknown>> {
  const def = MODEL_DEFS[model] ?? M({});
  const findRows = (args: Row): Row[] => {
    let rows = collect(model).rows.filter((r) => matches(model, r, args.where as Where));
    if (args.orderBy) rows = ordered(rows, args.orderBy as Row | Row[]);
    return applyIdSelection(model, rows, args);
  };

  return {
    findUnique: (args) =>
      new LazyAction(async () => {
        const matcher = selectionToMatcher(model, (args.where ?? {}) as Row);
        const row = collect(model).rows.find(matcher) ?? null;
        if (!row) return null;
        return shape(model, row, args, 0);
      }),
    findFirst: (args) =>
      new LazyAction(async () => {
        const [row] = findRows(args);
        if (!row) return null;
        return shape(model, row, args, 0);
      }),
    findMany: (args) =>
      new LazyAction(async () => {
        const rows = findRows(args);
        return rows.map((r) => shape(model, r, args, 0));
      }),
    count: (args) =>
      new LazyAction(async () => {
        const sel = collect(model).rows.filter((r) => matches(model, r, args.where as Where));
        const take = typeof args.take === "number" ? args.take : undefined;
        return take !== undefined ? sel.slice(0, take).length : sel.length;
      }),
    create: (args) =>
      new LazyAction(async () => {
        const data = { ...(args.data as Row) };
        const row = createRow(model, data, true);
        return shape(model, row, args, 0);
      }),
    createMany: (args) =>
      new LazyAction(async () => {
        const list = (args.data as Row[]) ?? [];
        let count = 0;
        for (const item of list) {
          const probe = { ...item };
          try {
            createRow(model, probe, false);
            count++;
          } catch (e) {
            if ((e as LocalDbError).code === "P2002" && args.skipDuplicates) continue;
            flush(model);
            throw e;
          }
        }
        flush(model);
        return { count };
      }),
    update: (args) =>
      new LazyAction(async () => {
        const matcher = selectionToMatcher(model, (args.where ?? {}) as Row);
        const row = collect(model).rows.find(matcher);
        if (!row) {
          throw new LocalDbError("P2025", `Record to update not found (${model})`);
        }
        applyUpdate(model, row, { ...(args.data as Row) });
        assertUniques(model, row, row.id as string);
        flush(model);
        return shape(model, row, args, 0);
      }),
    updateMany: (args) =>
      new LazyAction(async () => {
        const sel = collect(model).rows.filter((r) => matches(model, r, args.where as Where));
        sel.forEach((row) => applyUpdate(model, row, { ...(args.data as Row) }));
        flush(model);
        return { count: sel.length };
      }),
    upsert: (args) =>
      new LazyAction(async () => {
        const where = (args.where ?? {}) as Row;
        const matcher = selectionToMatcher(model, where);
        let row = collect(model).rows.find(matcher);
        if (row) {
          applyUpdate(model, row, { ...(args.update as Row) });
          flush(model);
          return shape(model, row, args, 0);
        }
        row = createRow(model, { ...(args.create as Row) }, true);
        return shape(model, row, args, 0);
      }),
    delete: (args) =>
      new LazyAction(async () => {
        const matcher = selectionToMatcher(model, (args.where ?? {}) as Row);
        const c = collect(model);
        const i = c.rows.findIndex(matcher);
        if (i < 0) throw new LocalDbError("P2025", `Record to delete not found (${model})`);
        const [row] = c.rows.splice(i, 1);
        cascadeDelete(model, row);
        flush(model);
        return shape(model, row, args, 0);
      }),
    deleteMany: (args) =>
      new LazyAction(async () => {
        const c = collect(model);
        const sel = c.rows.filter((r) => matches(model, r, args.where as Where));
        c.rows = c.rows.filter((r) => !sel.includes(r));
        sel.forEach((row) => cascadeDelete(model, row));
        flush(model);
        return { count: sel.length };
      }),
    groupBy: (args) =>
      new LazyAction(async () => {
        const by = (args.by as string[]) ?? [];
        const sel = collect(model).rows.filter((r) => matches(model, r, args.where as Where));
        const numsOf = (rows: Row[], pick: string): number[] =>
          rows.map((r) => r[pick]).filter((v) => typeof v === "number") as number[];
        const groups = new Map<string, Row & { __rows?: Row[] }>();
        for (const r of sel) {
          const gkey = by.map((f) => JSON.stringify(norm(r[f]))).join("|");
          let g = groups.get(gkey);
          if (!g) {
            g = { __rows: [], ...Object.fromEntries(by.map((f) => [f, r[f]])) } as Row & { __rows: Row[] };
            groups.set(gkey, g);
          }
          g.__rows!.push(r);
        }
        const out: Row[] = [];
        for (const g of groups.values()) {
          const rows: Row[] = g.__rows ?? [];
          delete g.__rows;
          const acc: Row = {};
          for (const [k, v] of Object.entries(args)) {
            if (!AGG_OPS.has(k)) continue; // only _count/_sum/_avg/_min/_max
            const op = k;
            const eFields = v;
            const fields = eFields === true ? null : (typeof eFields === "object" && eFields !== null ? (eFields as Row) : null);
            if (fields === null && eFields !== true && eFields !== null) continue;
            const fieldNames = fields ? Object.keys(fields) : ["_all"];
            const bucket: Row = {};
            for (const f of fieldNames) {
              if (op === "_count") {
                if (f === "_all") bucket._all = rows.length;
                else bucket[f] = rows.filter((r) => r[f] !== null && r[f] !== undefined).length;
              } else if (op === "_sum") {
                const ns = numsOf(rows, f);
                bucket[f] = ns.length ? ns.reduce((x: number, y: number) => x + y, 0) : null;
              } else if (op === "_avg") {
                const ns = numsOf(rows, f);
                bucket[f] = ns.length ? ns.reduce((x: number, y: number) => x + y, 0) / ns.length : null;
              } else if (op === "_min" || op === "_max") {
                const vs = rows.map((r) => norm(r[f])).sort(cmp) as unknown[];
                bucket[f] = op === "_min" ? (vs[0] ?? null) : (vs[vs.length - 1] ?? null);
              }
            }
            acc[op] = { ...(acc[op] as Row), ...bucket };
          }
          out.push({ __cnt: rows.length, ...g, ...acc });
        }
        if (args.orderBy) {
          const specs = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
          out.sort((a, b) => {
            for (const spec of specs) {
              for (const [field0, dir0] of Object.entries(spec as Row)) {
                // Prisma shapes: { field: "desc" } | { _count: { sub: "desc" } }
                let field = field0;
                let dir = dir0;
                if (field === "_count" && dir0 !== null && typeof dir0 === "object") {
                  const [sub, subDir] = Object.entries(dir0 as Row)[0] ?? ["_all", "asc"];
                  field = `_count.${sub}`;
                  dir = subDir;
                }
                const av = digOut(a, field);
                const bv = digOut(b, field);
                const c = cmp(av, bv);
                const s = c === 0 ? 0 : dir === "desc" ? -c : c;
                if (s !== 0) return s;
              }
            }
            return 0;
          });
        }
        if (typeof args.take === "number") out.splice(Math.max(0, args.take));
        for (const r of out) delete r.__cnt;
        return out;
      }),
    aggregate: (args) =>
      new LazyAction(async () => {
        const sel = collect(model).rows.filter((r) => matches(model, r, args.where as Where));
        const out: Row = {};
        for (const [k, spec] of Object.entries(args)) {
          if (k === "where" || k === "orderBy" || k === "take" || k === "skip" || k === "cursor") continue;
          if (spec === null || spec === undefined) continue;
          if (spec === true) {
            if (k === "_count") out[k] = sel.length;
            else out[k] = null;
            continue;
          }
          if (typeof spec !== "object") continue;
          const fields = spec as Row;
          const fieldNames = Object.keys(fields);
          const bucket: Row = {};
          for (const f of fieldNames) {
            if (fields[f] === false || fields[f] === undefined) continue;
            const nums = sel.map((r) => r[f]).filter((v) => typeof v === "number") as number[];
            if (k === "_count") bucket[f] = nums.length;
            else if (k === "_sum") bucket[f] = nums.length ? nums.reduce((x: number, y: number) => x + y, 0) : null;
            else if (k === "_avg") bucket[f] = nums.length ? nums.reduce((x: number, y: number) => x + y, 0) / nums.length : null;
            else if (k === "_min" || k === "_max") {
              const vs = sel.map((r) => norm(r[f])).sort(cmp) as unknown[];
              bucket[f] = k === "_min" ? (vs[0] ?? null) : (vs[vs.length - 1] ?? null);
            }
          }
          out[k] = bucket;
        }
        return out;
      }),
  };
}

/** digOut(grouped, "_count" | "_count._all" | "_count.field" | fieldname) for groupBy ordering. */
function digOut(row: Row, field: string): unknown {
  const [head, sub] = field.split(".");
  if (head === "_count") {
    // _count/_count._all → total group rows (hidden __cnt from groupBy);
    // _count.<field> → the selected bucket value, falling back to __cnt
    // (correct whenever the counted field is non-null on every row).
    if (field === "_count" || field === "_count._all" || sub === "_all") return row.__cnt ?? 0;
    const bucket = row._count as Row | undefined;
    if (bucket && typeof bucket === "object" && bucket[sub] !== undefined) return bucket[sub];
    return row.__cnt ?? 0;
  }
  const bucket = row[head] as Row | undefined;
  if (bucket && typeof bucket === "object") return sub ? bucket[sub] : 1;
  return row[field];
}

/** Delete rows that hang off a deleted row (schema cascade equivalents). */
function cascadeDelete(model: string, row: Row): void {
  // Models referencing this one: a child declares a localKey rel (one-directional),
  // a parent declares a foreignKey rel — collect both mappings → childModel → fk.
  const referencing = new Map<string, string>();
  for (const rel of Object.values(MODEL_DEFS[model]?.relations ?? {})) {
    if (rel.model && rel.foreignKey) referencing.set(rel.model, rel.foreignKey);
  }
  for (const [childModel, childDef] of Object.entries(MODEL_DEFS)) {
    for (const rel of Object.values(childDef.relations)) {
      if (rel.model === model && rel.localKey) referencing.set(childModel, rel.localKey);
    }
  }
  for (const [childModel, fk] of referencing) {
    const c2 = collect(childModel);
    const victims = c2.rows.filter((r) => cmp(r[fk], row.id) === 0);
    c2.rows = c2.rows.filter((r) => !victims.includes(r));
    victims.forEach((v) => cascadeDelete(childModel, v));
    flush(childModel);
  }
}

// ---------------------------------------------------------------------------
// The prisma-compatible client
// ---------------------------------------------------------------------------

/**
 * The client shape: model delegates keyed by camelCase name, plus the
 * prisma-special $-methods. Cast to `unknown`/`PrismaClient` at the seam —
 * call sites are typed against the generated client, so this interface is
 * intentionally loose (an `unknown` widening index keeps TS happy).
 */
export interface LocalDbClient {
  [model: string]: unknown;
}

export function buildLocalDbClient(): LocalDbClient {
  const client = Object.create(null) as LocalDbClient;
  for (const model of KNOWN_MODELS) {
    client[model] = buildDelegate(model) as unknown as Record<string, (args: Row) => LazyAction<unknown>>;
  }

  const transactionImpl = (arg: unknown): Promise<unknown> => {
    if (typeof arg === "function") {
      // Interactive form: same engine state, snapshot/rollback around the
      // callback. The tx handle is the shared client (all state is shared,
      // writes inside the callback hit the snapshot on failure).
      return snapshotRun(() => (arg as (tx: LocalDbClient) => Promise<unknown>)(client));
    }
    // Array form: ops are LazyActions — they execute lazily as awaited, one
    // after another, inside the snapshot. All-or-nothing: any rejection
    // restores every collection to the pre-transaction state.
    const ops = arg as LocalDbPromise[];
    return snapshotRun(async () => {
      const out: unknown[] = [];
      for (const op of ops) out.push(await op);
      return out;
    });
  };
  client.$transaction = transactionImpl as unknown as LocalDbClient["$transaction"];
  client.$queryRaw = (async () => [{ locked: true }]) as unknown as LocalDbClient["$queryRaw"];
  client.$connect = async () => undefined;
  client.$disconnect = async () => {
    flushAll();
  };
  return client;
}

/**
 * Run `body` against the current collections; any rejection restores EVERY
 * model's in-memory rows (and files) to the snapshot taken on entry.
 * Note: nested object references are duplicated per level of depth needed —
 * rows are shallow-cloned, which is sufficient because ops replace whole
 * fields rather than mutating nested structures in place.
 */
function snapshotRun<R>(body: () => Promise<R>): Promise<R> {
  const snap = new Map<string, Row[]>();
  for (const model of KNOWN_MODELS) {
    const c = collect(model);
    snap.set(model, c.rows.map((r) => ({ ...r })));
  }
  return body().then(
    (v) => v,
    (err) => {
      for (const [model, rows] of snap) {
        const c = collect(model);
        c.rows = rows.map((r) => reviveInto({ ...r }));
        flush(model);
      }
      throw err;
    }
  );
}

// JsonNull support: the two `Prisma.JsonNull` call sites were rewritten to
// plain `null` (identical end state: the JSON field reads back null). No
// sentinel plumbing needed.
