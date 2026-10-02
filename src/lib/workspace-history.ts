// workspace-history.ts — Server-side durable file-change history.
//
// The browser's file-history.ts is a fast session-local undo buffer. This
// module is the DURABLE twin: the same changes are appended to
// <workspace>/.orplex/history.jsonl so undo survives machines, tabs, and
// days. JSONL (one JSON object per line) is deliberate: appends are atomic
// enough on local disks, a crash can never corrupt earlier entries, and
// compaction = rewrite the kept tail.
//
// Laptop discipline: appends stream (no full-file reads on record); quota
// enforcement happens on READ/compaction, not on the hot write path. The
// .orplex/ directory is janitor-protected.
//
// Pure functions over fs — unit-testable with a temp dir.

import { appendFile, readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface HistoryEntry {
  /** Epoch ms. */
  t: number;
  path: string;
  /** null = the file was created by this change. */
  prev: string | null;
  next: string;
  /** Which machine/session recorded it (ORPLEX_MACHINE_ID or "browser"). */
  peer: string;
  /** Set on inverse entries created by undo. */
  undoOf?: string;
}

export const MAX_ENTRIES = 200;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CONTENT_CHARS = 200_000; // per side; larger files skip content capture

export function historyPath(root: string): string {
  return join(root, ".orplex", "history.jsonl");
}

function clamp(s: string | null): string | null {
  if (s === null) return null;
  return s.length > MAX_CONTENT_CHARS ? s.slice(0, MAX_CONTENT_CHARS) : s;
}

export function parseEntries(raw: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as Partial<HistoryEntry>;
      if (typeof e.t === "number" && typeof e.path === "string" && typeof e.next === "string" && ("prev" in e) && typeof e.peer === "string") {
        out.push({ t: e.t, path: e.path, prev: e.prev ?? null, next: e.next, peer: e.peer, ...(e.undoOf ? { undoOf: e.undoOf } : {}) });
      }
    } catch {
      // Torn line from a crash mid-append — skip, never fail the read.
    }
  }
  return out;
}

/**
 * Append one entry. Streams a single write; never reads the file.
 * Returns false when the change is too large to record (content capture
 * disabled) — callers treat that as success (undo just won't cover it).
 */
export async function appendHistory(
  root: string,
  entry: Omit<HistoryEntry, "t" | "peer"> & { t?: number; peer?: string }
): Promise<boolean> {
  const prev = clamp(entry.prev);
  const next = clamp(entry.next);
  if (prev === null && entry.prev !== null) return false;
  if (next === null) return false;
  const full: HistoryEntry = {
    t: entry.t ?? Date.now(),
    path: entry.path,
    prev,
    next,
    peer: entry.peer ?? "server",
    ...(entry.undoOf ? { undoOf: entry.undoOf } : {}),
  };
  const file = historyPath(root);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(full) + "\n", "utf8");
  return true;
}

/** Read all entries, oldest first, enforcing the quota by dropping the OLDEST overflow. */
export async function readHistory(root: string, since?: number): Promise<HistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(historyPath(root), "utf8");
  } catch {
    return [];
  }
  let entries = parseEntries(raw);
  if (since != null) entries = entries.filter((e) => e.t > since);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
  return entries;
}

/** Quota enforcement: rewrite the file keeping only the newest MAX_ENTRIES (and under MAX_FILE_BYTES). */
export async function compactHistory(root: string): Promise<number> {
  const file = historyPath(root);
  let raw = "";
  try {
    const s = await stat(file);
    if (s.size <= MAX_FILE_BYTES) {
      // Size is fine; only enforce entry count on read anyway.
      return 0;
    }
    raw = await readFile(file, "utf8");
  } catch {
    return 0;
  }
  let entries = parseEntries(raw);
  const before = entries.length;
  // Keep the newest entries that fit the byte budget.
  let kept: HistoryEntry[] = [];
  let bytes = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = JSON.stringify(entries[i]).length + 1;
    if (bytes + line > MAX_FILE_BYTES || kept.length >= MAX_ENTRIES) break;
    kept.unshift(entries[i]);
    bytes += line;
  }
  entries = kept;
  const tmp = file + ".tmp";
  await mkdir(dirname(tmp), { recursive: true });
  await writeFile(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), "utf8");
  await rename(tmp, file);
  return before - entries.length;
}

/**
 * The latest restorable entry for a path (newest first), skipping entries
 * whose content no longer matches `currentContent` (someone wrote after us).
 * Pass null to match anything.
 */
export function findUndoTarget(entries: HistoryEntry[], path: string, currentContent: string | null): HistoryEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.path !== path || e.undoOf) continue;
    if (currentContent !== null && e.next !== currentContent) continue;
    return e;
  }
  return null;
}

/** The inverse entry for an undo (records what undo did so undo-undo works). */
export function inverseOf(target: HistoryEntry, machineId: string): HistoryEntry {
  return {
    t: Date.now(),
    path: target.path,
    prev: target.next,
    next: target.prev ?? "",
    peer: machineId,
    undoOf: `${target.t}:${target.path}`,
  };
}

export function machineId(): string {
  return process.env.ORPLEX_MACHINE_ID || "orplex-local";
}
