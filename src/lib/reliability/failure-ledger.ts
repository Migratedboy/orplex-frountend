/**
 * reliability/failure-ledger.ts — Phase 6: a durable, evidence-only failure
 * ledger with an injected storage interface (plan §11.2 `failure_ledger`).
 *
 * Why this exists: `failure-memory.ts` is session-scoped (sessionStorage dies
 * with the tab), and the HTTP run ledger (run-ledger.ts → /api/agent/ledger)
 * is a browser client. This module is the storage-agnostic core: entries are
 * raw evidence (normalized error code + file signature, the failing output,
 * implicated files, recurrence), never model-written text, and the in-memory
 * Failure Doctrine is seeded FROM it through the hydration helpers below.
 *
 * Storage is injected (`LedgerStorage`) so every behaviour is testable
 * without a database — MemoryLedgerStorage ships for tests; the Prisma-backed
 * implementation plugs the same three methods.
 *
 * Behaviour gate: recording and listing are unconditional (collecting
 * evidence never changes what the model or gate does), but SEEDING the
 * model-facing doctrine runs only under reliabilityDurableMemoryEnabled()
 * (RELIABILITY_GATES=1 + RELIABILITY_DURABLE_MEMORY=1) — new model-facing
 * behaviour defaults OFF.
 */

import { mergeServerFailures, type FailureKind, type FailureRecord } from "../failure-memory";
import { extractTypecheckSignatures } from "./gates";
import { reliabilityDurableMemoryEnabled } from "./flags";

export interface LedgerStorage {
  append(entry: LedgerEntry): Promise<void>;
  list(workspaceKey: string, limit?: number): Promise<LedgerEntry[]>;
  resolveSignatures(workspaceKey: string, signatures: string[]): Promise<void>;
}

export type LedgerEntry = {
  id: string;
  workspaceKey: string;
  at: string;
  lane: string;
  signature: string;
  evidence: string;
  files: string[];
  recurrence: number;
  resolved: boolean;
};

const MAX_EVIDENCE_CHARS = 600;
const MAX_FILES = 5;
const MAX_FILE_CHARS = 300;
const MAX_SIGNATURE_CHARS = 300;

/** Lane → failure-memory kind (unknown lanes are dropped, never guessed). */
const LANE_TO_KIND: Record<string, FailureKind> = {
  typecheck: "typecheck",
  lint: "typecheck",
  syntax: "typecheck",
  browser: "browser",
  command: "command",
  exec: "command",
  test: "command",
  review: "review",
  swarm: "review",
};

export function laneToFailureKind(lane: string): FailureKind | null {
  return LANE_TO_KIND[String(lane || "").toLowerCase().trim()] ?? null;
}

/** Codes worth keeping for non-tsc evidence (EADDRINUSE, HTTP 500, exit 1 …). */
const CODE_RE = /\b(TS\d+|E[A-Z]{5,}|(?:HTTP|STATUS)[ -]?\d{3}|EXIT[ -]?\d+|exit(?:[ -]?code)?[ -]?\d+)\b/i;

function normalizeFile(f: string): string {
  return String(f).replace(/\\/g, "/").replace(/^\.\//, "").slice(0, MAX_FILE_CHARS);
}

/**
 * Identity of a failure: normalized error code + file, in the SAME
 * `path:CODE` shape gates.ts uses (tscErrorSignature), so ledger signatures
 * and gate signatures are comparable. For tsc evidence the extractor from
 * gates.ts is reused rather than re-implemented; everything else falls back
 * to `file:CODE` with the first recognizable code in the evidence.
 *
 * Deterministic: gates' extractor returns a sorted set, so the first element
 * is stable across runs even if tsc reorders its output.
 */
export function ledgerSignature(lane: string, evidence: string, files: string[]): string {
  const tsc = extractTypecheckSignatures(evidence);
  if (tsc.length > 0) return tsc[0].slice(0, MAX_SIGNATURE_CHARS);
  const file = normalizeFile(files?.[0] ?? "") || "(no-file)";
  const m = CODE_RE.exec(evidence);
  const code = m ? m[1].toUpperCase().replace(/\s+/g, " ") : "UNKNOWN";
  return `${file}:${code}`.slice(0, MAX_SIGNATURE_CHARS);
}

function newEntryId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a well-formed entry from raw evidence (the recording seam). */
export function createLedgerEntry(input: {
  workspaceKey: string;
  lane: string;
  evidence: string;
  files?: string[];
  at?: string;
  id?: string;
  recurrence?: number;
  signature?: string;
}): LedgerEntry | null {
  const workspaceKey = String(input.workspaceKey || "").trim().slice(0, 200);
  const evidence = String(input.evidence || "").trim().slice(0, MAX_EVIDENCE_CHARS);
  const lane = String(input.lane || "").trim().slice(0, 40);
  if (!workspaceKey || !evidence || !lane) return null;
  const files = (Array.isArray(input.files) ? input.files : [])
    .filter((f): f is string => typeof f === "string" && !!f.trim())
    .map(normalizeFile)
    .slice(0, MAX_FILES);
  const at = typeof input.at === "string" && Number.isFinite(Date.parse(input.at))
    ? new Date(Date.parse(input.at)).toISOString()
    : new Date().toISOString();
  return {
    id: typeof input.id === "string" && input.id ? input.id.slice(0, 100) : newEntryId(),
    workspaceKey,
    at,
    lane,
    signature: String(input.signature || ledgerSignature(lane, evidence, files))
      .trim()
      .slice(0, MAX_SIGNATURE_CHARS),
    evidence,
    files,
    recurrence: Math.max(1, Math.floor(Number(input.recurrence) || 1)),
    resolved: false,
  };
}

/** Defensive re-validation of entries read back from durable storage. */
function normalizeEntry(raw: unknown): LedgerEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<LedgerEntry>;
  if (typeof r.workspaceKey !== "string" || !r.workspaceKey) return null;
  if (typeof r.evidence !== "string" || !r.evidence) return null;
  if (typeof r.signature !== "string" || !r.signature) return null;
  const at = typeof r.at === "string" && Number.isFinite(Date.parse(r.at))
    ? new Date(Date.parse(r.at)).toISOString()
    : new Date().toISOString();
  return {
    id: typeof r.id === "string" && r.id ? r.id : newEntryId(),
    workspaceKey: r.workspaceKey.slice(0, 200),
    at,
    lane: typeof r.lane === "string" ? r.lane.slice(0, 40) : "unknown",
    signature: r.signature.slice(0, MAX_SIGNATURE_CHARS),
    evidence: r.evidence.slice(0, MAX_EVIDENCE_CHARS),
    files: (Array.isArray(r.files) ? r.files : [])
      .filter((f): f is string => typeof f === "string")
      .map(normalizeFile)
      .slice(0, MAX_FILES),
    recurrence: Math.max(1, Math.floor(Number(r.recurrence) || 1)),
    resolved: r.resolved === true,
  };
}

/** Map a ledger entry onto the in-memory FailureRecord shape (null = drop). */
export function toFailureRecord(e: LedgerEntry): FailureRecord | null {
  const kind = laneToFailureKind(e.lane);
  if (!kind || !e.evidence) return null;
  const parsed = Date.parse(e.at);
  return {
    kind,
    detail: e.evidence.slice(0, MAX_EVIDENCE_CHARS),
    files: (Array.isArray(e.files) ? e.files : []).slice(0, MAX_FILES),
    when: Number.isFinite(parsed) ? parsed : Date.now(),
    count: Math.max(1, Math.floor(Number(e.recurrence) || 1)),
  };
}

/**
 * Seed the session Failure Doctrine (failure-memory.ts) from durable entries.
 * mergeServerFailures keeps the higher count and freshest timestamp per
 * kind+detail, so recurrence learned across restarts survives the merge.
 */
export function seedFailureMemory(entries: LedgerEntry[]): number {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  const records: FailureRecord[] = [];
  for (const e of entries) {
    const rec = normalizeEntry(e);
    if (!rec) continue;
    const mapped = toFailureRecord(rec);
    if (mapped) records.push(mapped);
  }
  if (records.length === 0) return 0;
  mergeServerFailures(records);
  return records.length;
}

export class FailureLedger {
  constructor(
    private readonly storage: LedgerStorage,
    private readonly defaultWorkspaceKey?: string
  ) {}

  /** Record evidence. Never throws — storage failure is {ok:false}, not a task break. */
  async record(entry: LedgerEntry): Promise<boolean> {
    const normalized = normalizeEntry(entry);
    if (!normalized) return false;
    try {
      await this.storage.append(normalized);
      return true;
    } catch {
      return false;
    }
  }

  /** Open (unresolved) entries for a workspace, newest first. Never throws. */
  async listUnresolved(workspaceKey: string, limit = 50): Promise<LedgerEntry[]> {
    const scope = String(workspaceKey || "").trim().slice(0, 200);
    if (!scope) return [];
    const cap = Math.min(Math.max(Math.floor(limit) || 50, 1), 500);
    try {
      const rows = await this.storage.list(scope, cap);
      if (!Array.isArray(rows)) return [];
      const out: LedgerEntry[] = [];
      for (const raw of rows) {
        const e = normalizeEntry(raw);
        if (e && !e.resolved) out.push(e);
        if (out.length >= cap) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Mark signatures healed (a passing lane). Workspace defaults to the scope
   * the ledger was constructed with; with neither available this is a no-op
   * rather than an error — resolution is best-effort by design.
   */
  async markResolved(signatures: string[], workspaceKey?: string): Promise<void> {
    const scope = String(workspaceKey ?? this.defaultWorkspaceKey ?? "").trim();
    const sigs = (Array.isArray(signatures) ? signatures : [])
      .map((s) => String(s).trim().slice(0, MAX_SIGNATURE_CHARS))
      .filter(Boolean);
    if (!scope || sigs.length === 0) return;
    try {
      await this.storage.resolveSignatures(scope, sigs);
    } catch {
      /* best-effort: an unresolvable signature just keeps teaching */
    }
  }

  /**
   * Hydrate the in-memory Failure Doctrine from durable entries. Returns the
   * number of records seeded, or 0 (flag off, nothing stored, storage error).
   */
  async hydrateFailureMemory(workspaceKey: string, limit = 50): Promise<number> {
    if (!reliabilityDurableMemoryEnabled()) return 0;
    try {
      const entries = await this.listUnresolved(workspaceKey, limit);
      return seedFailureMemory(entries);
    } catch {
      return 0;
    }
  }
}

/**
 * In-memory LedgerStorage — the test double (and a no-DB fallback). Same
 * semantics a Prisma-backed store must implement: append, per-workspace list
 * newest-first, resolve-by-signature within one workspace.
 */
export class MemoryLedgerStorage implements LedgerStorage {
  private readonly entries: LedgerEntry[] = [];

  async append(entry: LedgerEntry): Promise<void> {
    this.entries.push({ ...entry, files: [...entry.files] });
  }

  async list(workspaceKey: string, limit = 50): Promise<LedgerEntry[]> {
    return this.entries
      .filter((e) => e.workspaceKey === workspaceKey)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, Math.max(1, limit))
      .map((e) => ({ ...e, files: [...e.files] }));
  }

  async resolveSignatures(workspaceKey: string, signatures: string[]): Promise<void> {
    const set = new Set(signatures);
    for (const e of this.entries) {
      if (e.workspaceKey === workspaceKey && set.has(e.signature)) e.resolved = true;
    }
  }

  /** Test/inspection helper: every entry, across workspaces. */
  all(): LedgerEntry[] {
    return this.entries.map((e) => ({ ...e, files: [...e.files] }));
  }
}
