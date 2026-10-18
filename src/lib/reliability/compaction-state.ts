/**
 * reliability/compaction-state.ts — Phase 6: persistable transcript
 * compaction state, so a reload resumes incrementally instead of forcing a
 * full re-summarize (AUDIT §2 "Compaction state persistence — ABSENT").
 *
 * compaction.ts keeps `CompactionState` ({coveredCount, summary,
 * fingerprint:number[]}) inside createTranscriptCompactor's closure — a
 * reload drops it, and the next eviction re-summarizes the WHOLE prefix. This
 * module serializes that state (fingerprint as a comma-joined string so the
 * payload is one plain string per key) and reads/writes it through an
 * injected storage interface, so the worker can persist it to
 * localStorage/IndexedDB (browser lane) or any KV store without this module
 * knowing anything about the transport. MemoryCompactionStateStore is the
 * no-persistence double for tests.
 *
 * Also designs (deliberately does NOT wire) the `recall_event` shape for
 * recovering compacted raw tool output — see the block on RecallEvent below.
 *
 * Behaviour gate: save() — the new persistence — runs only under
 * reliabilityDurableMemoryEnabled() (RELIABILITY_GATES=1 +
 * RELIABILITY_DURABLE_MEMORY=1). load() is unconditional (a read can only
 * ever recover state the armed flag already wrote). Default OFF = the
 * current in-memory-only behaviour, byte for byte.
 */

import type { CompactionState } from "../compaction";
import { reliabilityDurableMemoryEnabled } from "./flags";

export type CompactionStateV2 = {
  coveredCount: number;
  summary: string;
  fingerprint: string;
  updatedAt: number;
};

const MAX_SUMMARY_CHARS = 8_000;
const MAX_FINGERPRINT_PARTS = 10_000;

/** Serialize to a single opaque string — the unit storage reads/writes. */
export function serializeCompactionState(state: CompactionStateV2): string {
  return JSON.stringify({
    v: 2,
    coveredCount: Math.max(0, Math.floor(state.coveredCount) || 0),
    summary: String(state.summary || "").slice(0, MAX_SUMMARY_CHARS),
    fingerprint: String(state.fingerprint || ""),
    updatedAt: Math.max(0, Math.floor(state.updatedAt) || 0),
  });
}

/**
 * Parse + validate. Returns null on ANY corruption (bad JSON, wrong types,
 * non-integer counters) — the caller then starts fresh, which is exactly the
 * old behaviour, never a crash and never a half-applied summary.
 */
export function deserializeCompactionState(raw: string | null | undefined): CompactionStateV2 | null {
  if (typeof raw !== "string" || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.coveredCount !== "number" || !Number.isInteger(p.coveredCount) || p.coveredCount < 0) return null;
  if (typeof p.summary !== "string") return null;
  if (typeof p.fingerprint !== "string") return null;
  if (typeof p.updatedAt !== "number" || !Number.isFinite(p.updatedAt) || p.updatedAt < 0) return null;
  const parts = p.fingerprint === "" ? [] : p.fingerprint.split(",");
  if (parts.length > MAX_FINGERPRINT_PARTS) return null;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null; // must be unsigned ints (FNV-1a hashes)
  }
  return {
    coveredCount: p.coveredCount,
    summary: p.summary.slice(0, MAX_SUMMARY_CHARS),
    fingerprint: p.fingerprint,
    updatedAt: Math.floor(p.updatedAt),
  };
}

/** The KV seam. Storage owns the bytes; this module owns their meaning. */
export interface CompactionStateStorage {
  read(key: string): Promise<string | null>;
  write(key: string, raw: string): Promise<void>;
}

export interface CompactionStateStoreApi {
  load(key: string): Promise<CompactionStateV2 | null>;
  save(key: string, state: CompactionStateV2): Promise<boolean>;
}

/** Durable store over any injected KV storage. Never throws on bad input. */
export class CompactionStateStore implements CompactionStateStoreApi {
  constructor(private readonly storage: CompactionStateStorage) {}

  async load(key: string): Promise<CompactionStateV2 | null> {
    if (!key) return null;
    try {
      return deserializeCompactionState(await this.storage.read(key));
    } catch {
      return null;
    }
  }

  /** Returns false when the flag is off or storage failed — never throws. */
  async save(key: string, state: CompactionStateV2): Promise<boolean> {
    if (!key || !state) return false;
    if (!reliabilityDurableMemoryEnabled()) return false;
    try {
      await this.storage.write(key, serializeCompactionState(state));
      return true;
    } catch {
      return false;
    }
  }
}

/** Map-backed store: the test double (and a same-process fallback). */
export class MemoryCompactionStateStore implements CompactionStateStoreApi {
  private readonly map = new Map<string, string>();

  async load(key: string): Promise<CompactionStateV2 | null> {
    return deserializeCompactionState(this.map.get(key) ?? null);
  }

  async save(key: string, state: CompactionStateV2): Promise<boolean> {
    if (!key || !state) return false;
    if (!reliabilityDurableMemoryEnabled()) return false;
    this.map.set(key, serializeCompactionState(state));
    return true;
  }

  /** Test/inspection helper. */
  has(key: string): boolean {
    return this.map.has(key);
  }
}

// ---------------------------------------------------------------------------
// compaction.ts interop — V2 (string fingerprint) ↔ CompactionState (number[])
// ---------------------------------------------------------------------------

/** Convert the live compactor state into the persistable V2 shape. */
export function toCompactionStateV2(state: CompactionState, updatedAt = Date.now()): CompactionStateV2 {
  return {
    coveredCount: Math.max(0, Math.floor(state.coveredCount) || 0),
    summary: String(state.summary || ""),
    fingerprint: (Array.isArray(state.fingerprint) ? state.fingerprint : []).join(","),
    updatedAt: Math.max(0, Math.floor(updatedAt) || 0),
  };
}

/**
 * Convert persisted V2 back into the shape compactTranscript(state?) accepts.
 * null when the fingerprint does not line up with `coveredCount` — that is a
 * corrupt/partial state, and passing it on would disable the incremental
 * prefix check; better to start fresh (full re-summarize) than to summarize
 * a tail against a summary of content that no longer exists.
 */
export function fromCompactionStateV2(v2: CompactionStateV2 | null): CompactionState | null {
  if (!v2) return null;
  const parts = v2.fingerprint === "" ? [] : v2.fingerprint.split(",");
  if (parts.length !== v2.coveredCount) return null;
  const fingerprint: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0) return null;
    fingerprint.push(n);
  }
  return { coveredCount: v2.coveredCount, summary: v2.summary, fingerprint };
}

// ---------------------------------------------------------------------------
// recall_event — DESIGN ONLY, not wired anywhere
// ---------------------------------------------------------------------------

/**
 * recall_event — how compacted raw tool output becomes retrievable again.
 *
 * compaction.ts emits `messages: [block, ...messages.slice(evictCount)]`:
 * the evicted prefix is DROPPED with no durable copy, so the raw tool output
 * inside it (file reads, test dumps, command output) is unrecoverable — there
 * is no recall_event equivalent today (AUDIT §2).
 *
 * Shape (kept deliberately small — one key, the raw text, a timestamp):
 *
 *   type RecallEvent = { key: string; rawPrefix: string; at: number };
 *
 * CONTRACT FOR THE CALLER (not implemented here on purpose — compaction.ts
 * and background-worker.ts are out of this module's scope): the raw prefix
 * MUST be written to a store (the same CompactionStateStorage KV works) at
 * COMPACTION TIME, inside/next to the caller that builds `block`, under
 * buildRecallKey(firstEvictedIndex, contentHashOfThatMessage). Writing it
 * after the fact is impossible — the prefix no longer exists once
 * compactTranscript returns. Retrieval is then a pure key lookup: rebuild
 * buildRecallKey(index, hash) for a message the summary references and read
 * rawPrefix back. Bounded by the caller (e.g. keep the newest N recall
 * events, cap rawPrefix length) — this module never stores bytes itself.
 */
export interface RecallEvent {
  key: string;
  rawPrefix: string;
  at: number;
}

/**
 * Deterministic recall key for one evicted transcript message:
 * `recall:<messageIndex>:<contentHash>`. Index is the message's ORIGINAL
 * position in the transcript (not its post-compaction position), so the key
 * stays stable across successive compactions.
 */
export function buildRecallKey(messageIndex: number, contentHash: string): string {
  const idx = Number.isFinite(messageIndex) ? Math.max(0, Math.trunc(messageIndex)) : 0;
  return `recall:${idx}:${String(contentHash || "")}`;
}

/** Build the recall_event the compaction-time caller persists (see above). */
export function buildRecallEvent(
  messageIndex: number,
  contentHash: string,
  rawPrefix: string,
  at = Date.now()
): RecallEvent {
  return {
    key: buildRecallKey(messageIndex, contentHash),
    rawPrefix: String(rawPrefix || ""),
    at: Math.max(0, Math.floor(at) || 0),
  };
}
