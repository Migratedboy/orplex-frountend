// memory-file-store.ts — create_file backing store.
//
// Where the agent produces a small deliverable OUTSIDE the workspace (a
// summary, a snippet, a checklist) the model can stage it in app memory with
// create_file instead of writing disk. The staged bytes live HERE, in the
// desktop app's own local Next process — a long-lived Node process — never on
// disk, never in a database, and never on the serverless cloud backend whose
// memory does not survive a request boundary. Sentry-quiet and honest: the
// user downloads via the chat card, the model had it last week, and the store
// evaporates on app quit or restart by design.
//
// Hard rules (from the feature contract):
//   - 4h TTL per entry (dev builds may shorten via ORPLEX_MEMORY_FILE_TTL_MS).
//   - max 2 entries per scope; creating the 3rd evicts the oldest — its buffer
//     is zero-filled before it is dropped (defense in depth, though the next
//     GC would reclaim it anyway) and a tombstone is kept so the card can
//     honestly report what happened.
//   - expiry is checked lazily on every read (sweep timer is only a janitor).
//   - content never touches disk and is never logged.
//   - unguessable ids: crypto.randomUUID(), not a counter.

import { randomUUID } from "node:crypto";

// ── Config (single, documented constants) ───────────────────────────────────

const HOUR = 60 * 60 * 1000;

/** Plain TTL — the online workspace spec value: 4 hours. */
const DEFAULT_TTL_MS = 4 * HOUR;

/**
 * Dev-only TTL override. Production ignores it entirely, so a tampered
 * Vercel env cannot shrink the real window. Clamped down to 30s minimum
 * so a bad value can't make entries immortal.
 */
const DEV_TTL_ENV = "ORPLEX_MEMORY_FILE_TTL_MS";

function effectiveTtl(): number {
  const ttl = DEFAULT_TTL_MS;
  if (process.env.NODE_ENV === "production") return ttl;
  const raw = Number(process.env[DEV_TTL_ENV]);
  if (!Number.isFinite(raw) || raw <= 0) return ttl;
  return Math.max(30_000, Math.min(raw, 24 * HOUR));
}

/** Max staged file size — generous for text, small enough that a runaway
 *  model cannot balloon the process heap with 2 entries alive. */
export const MAX_MEMORY_FILE_BYTES = 2_000_000;

/** Max entries per scope. Creating the 3rd evicts the oldest. */
export const MAX_FILES_PER_SCOPE = 2;

// ── Types ───────────────────────────────────────────────────────────────────

export interface MemoryFileEntry {
  id: string;
  filename: string;
  /** UTF-8 bytes. Zero-filled before entry eviction/expiry. */
  buf: Buffer;
  bytes: number;
  lines: number;
  /** Which agent call created it — display only, never a cap partition. */
  ownerId: string | null;
  conversationId: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface MemoryFileMeta {
  id: string;
  filename: string;
  bytes: number;
  lines: number;
  ownerId: string | null;
  conversationId: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface MemoryFileTombstone {
  id: string;
  filename: string;
  conversationId: string | null;
  /** "evicted" (pushed out by the cap) or "expired" (TTL elapsed). */
  reason: "evicted" | "expired";
  at: number;
}

export type MemoryFileState = "live" | "expired" | "removed";

export type CreateMemoryFileResult =
  | {
      ok: true;
      file: MemoryFileMeta;
      evicted: { id: string; filename: string } | null;
      /** True when identical filename+bytes were already staged — the existing
       *  entry was returned untouched; no new id, no eviction. */
      duplicate: boolean;
    }
  | { ok: false; error: "invalid_filename" | "invalid_content" | "too_large" | "internal" };

// ── Filename validation ─────────────────────────────────────────────────────

// Basename deliverables: letters/digits/spaces/._- plus an extension. Path
// separators, control chars and Windows-reserved device names are refused —
// these entries never touch the filesystem, but the filename is echoed into
// the UI and the Content-Disposition header, so it must stay inert.
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,98}[A-Za-z0-9]*$/;
const HAS_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

function validFilename(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 100) return false;
  if (!FILENAME_RE.test(name) || !HAS_EXT_RE.test(name)) return false;
  if (WIN_RESERVED.test(name)) return false;
  return true;
}

// ── Store ───────────────────────────────────────────────────────────────────

// Single scope = the app process (Electron desktop: one signed-in user). The
// cap is intentionally NOT per conversation — 2 staged deliverables is the
// total budget of the app, which keeps the heap ceiling exact.
const scopeFiles = new Map<string, MemoryFileEntry>(); // creation order (FIFO)
const tombstones = new Map<string, MemoryFileTombstone>();

const MAX_TOMBSTONES = 200; // keeps long sessions honest without heap growth

function metaOf(entry: MemoryFileEntry): MemoryFileMeta {
  const { buf: _buf, ...meta } = entry;
  return meta;
}

/** Tombstone of a live entry (eviction or natural expiry). */
function retire(entry: MemoryFileEntry, reason: "evicted" | "expired"): void {
  // Zero-fill the byte buffer first — the safest available in-page scrub of
  // bytes that are about to drop out of every reference.
  entry.buf.fill(0);
  scopeFiles.delete(entry.id);
  const tomb: MemoryFileTombstone = {
    id: entry.id,
    filename: entry.filename,
    conversationId: entry.conversationId,
    reason,
    at: Date.now(),
  };
  tombstones.set(tomb.id, tomb);
  while (tombstones.size > MAX_TOMBSTONES) {
    const oldest = tombstones.keys().next().value as string | undefined;
    if (!oldest) break;
    tombstones.delete(oldest);
  }
}

// ── Lazy expiry + sweep ─────────────────────────────────────────────────────

function expireDue(now = Date.now()): void {
  for (const entry of scopeFiles.values()) {
    if (now >= entry.expiresAt) retire(entry, "expired");
  }
}

let sweepTimer: NodeJS.Timeout | null = null;

/** 60s janitor — unref'd so it never keeps the process (or jest) alive
 *  waiting on it. Real safety comes from lazy checks on every read. */
function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => expireDue(), 60_000);
  sweepTimer.unref?.();
}

/** Test hook: stop the janitor so a suite can exit cleanly. */
export function stopMemoryFileStoreSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Test hook: hard-reset store + tombstones between suites. */
export function resetMemoryFileStoreForTests(): void {
  for (const entry of scopeFiles.values()) entry.buf.fill(0);
  scopeFiles.clear();
  tombstones.clear();
}

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * Stage a text file in memory. Returns the card metadata (never content) and,
 * when the 3rd entry displaced one, the evicted file's id/filename so the
 * model and the user's card can say what happened.
 */
export function createMemoryFile(opts: {
  filename: unknown;
  content: unknown;
  ownerId?: string | null;
  conversationId?: string | null;
}): CreateMemoryFileResult {
  try {
    if (!validFilename(opts.filename)) return { ok: false, error: "invalid_filename" };
    const content = opts.content;
    if (typeof content !== "string" || content.length === 0) {
      return { ok: false, error: "invalid_content" };
    }

    const buf = Buffer.from(content, "utf8");
    if (buf.length > MAX_MEMORY_FILE_BYTES) return { ok: false, error: "too_large" };

    // Idempotent by content: an identical filename+bytes already live in the
    // scope is returned as-is (same card, no eviction churn). This is the
    // guard against models re-invoking create_file for an artefact they (or a
    // regenerate pass) already staged — the honest answer is "already there".
    expireDue();
    let replacedNamesake: MemoryFileEntry | null = null;
    for (const existing of scopeFiles.values()) {
      if (existing.filename !== opts.filename) continue;
      if (existing.buf.equals(buf)) {
        return { ok: true, file: metaOf(existing), evicted: null, duplicate: true };
      }
      replacedNamesake = existing;
    }
    let evicted: { id: string; filename: string } | null = null;
    if (replacedNamesake) {
      // One card per filename: a live namesake with DIFFERENT content is
      // replaced outright (regardless of the cap), evicting the old entry.
      evicted = { id: replacedNamesake.id, filename: replacedNamesake.filename };
      retire(replacedNamesake, "evicted");
    }
    while (scopeFiles.size >= MAX_FILES_PER_SCOPE) {
      const oldest = scopeFiles.keys().next().value as string | undefined;
      if (!oldest) break;
      const victim = scopeFiles.get(oldest);
      if (!victim) break;
      evicted = { id: victim.id, filename: victim.filename };
      retire(victim, "evicted");
    }

    const now = Date.now();
    const entry: MemoryFileEntry = {
      id: randomUUID(),
      filename: opts.filename,
      buf,
      bytes: buf.length,
      lines: content.split("\n").length,
      ownerId: opts.ownerId ?? null,
      conversationId: opts.conversationId ?? null,
      createdAt: now,
      expiresAt: now + effectiveTtl(),
    };
    scopeFiles.set(entry.id, entry);
    ensureSweep();

    return { ok: true, file: metaOf(entry), evicted, duplicate: false };
  } catch {
    // Never log content — a swallowed internal failure is safer than content
    // leaking into any sink. The caller reports an honest error.
    return { ok: false, error: "internal" };
  }
}

/**
 * Fetch a staged file (content included) for download. Lazy expiry runs
 * first, so a caller never sees bytes past the TTL.
 */
export function readMemoryFile(id: string): {
  state: MemoryFileState;
  meta: MemoryFileMeta | null;
  content: string | null;
  tombstone: MemoryFileTombstone | null;
} {
  const t = staleCheck(id);
  if (t) {
    return { state: "removed", meta: null, content: null, tombstone: t };
  }
  const entry = scopeFiles.get(id);
  if (!entry) {
    // Unknown id entirely — an evicted-but-forgotten tombstone is still a
    // removed card, everything else is removed too (no error state).
    return { state: "removed", meta: null, content: null, tombstone: null };
  }
  return { state: "live", meta: metaOf(entry), content: entry.buf.toString("utf8"), tombstone: null };
}

/**
 * Status-only read for cards (state: live/expired/removed). An expired entry
 * reports "expired" — the card can say "Expired" instead of a catch-all;
 * evicted/unknown ids report "removed".
 */
export function memoryFileStatus(id: string): MemoryFileState {
  const t = staleCheck(id);
  if (t) return t.reason === "expired" ? "expired" : "removed";
  return scopeFiles.has(id) ? "live" : "removed";
}

/** Live status lookup that also lazily expires. */
function staleCheck(id: string): MemoryFileTombstone | null {
  const existing = tombstones.get(id);
  if (existing) return existing;
  const entry = scopeFiles.get(id);
  if (entry && Date.now() >= entry.expiresAt) {
    retire(entry, "expired");
    return tombstones.get(id) ?? null;
  }
  return null;
}

/**
 * Dev-only seed for the card's three render states (live / Expired /
 * Removed). Guarded by the dev check INSIDE the store so production routes
 * cannot be tricked into creating demo tombstones.
 */
export function seedDemoMemoryFileStates(dev: boolean): {
  liveId: string | null;
  expiredId: string | null;
  removedId: string | null;
} {
  let liveId: string | null = null;
  let expiredId: string | null = null;
  let removedId: string | null = null;
  if (!dev) return { liveId, expiredId, removedId };

  const seedMeta = (
    res: CreateMemoryFileResult,
    id: string
  ): { id: string } | null => {
    if (!res.ok) return null;
    // Swap the random UUID for a stable demo id so the client can target it.
    const entry = scopeFiles.get(res.file.id);
    if (entry) {
      entry.id = id;
      scopeFiles.set(id, entry);
      scopeFiles.delete(res.file.id);
    }
    return { id };
  };

  const live = seedMeta(
    createMemoryFile({ filename: "demo-live.sum", content: "Live demo entry — downloadable card." }),
    `demo-live-${Date.now()}`
  );
  if (live) liveId = live.id;

  const expired = seedMeta(
    createMemoryFile({ filename: "demo-expired.txt", content: "Expired demo entry." }),
    `demo-expired-${Date.now()}`
  );
  if (expired) {
    expiredId = expired.id;
    // Force it through a synthetic already-elapsed TTL so the card reads "Expired".
    const entry = scopeFiles.get(expired.id);
    if (entry) entry.expiresAt = Date.now() - 1;
  }

  removedId = `demo-removed-${Date.now()}`;
  tombstones.set(removedId, {
    id: removedId,
    filename: "demo-removed.sum",
    conversationId: null,
    reason: "evicted",
    at: Date.now(),
  });

  return { liveId, expiredId, removedId };
}
