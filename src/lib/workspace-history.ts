// workspace-history.ts — LAYER 2: the single durable file-change history.
//
// The browser's file-history.ts (Layer 1) is a fast session-local undo buffer.
// This module is the DURABLE twin: the same changes are appended to
// <workspace>/.orplex/history.jsonl so undo survives machines, tabs, and
// days. JSONL (one JSON object per line) is deliberate: appends are atomic
// enough on local disks, a crash can never corrupt earlier entries, and
// compaction = rewrite the kept tail.
//
// Checkpoints (checkpoints.ts) are snapshots OF this layer: each records the
// entry count at capture (historyLength), and restores append inverse entries
// here. Restore always goes through this module — never around it.
//
// Laptop discipline: appends stream (no full-file reads on record); quota
// enforcement happens on READ/compaction, not on the hot write path. The
// .orplex/ directory is janitor-protected.
//
// Pure functions over fs — unit-testable with a temp dir.

import { dirname, join, resolve, sep } from "node:path";

export interface HistoryEntry {
  /** Epoch ms. */
  t: number;
  path: string;
  /** null = the file was created by this change. */
  prev: string | null;
  /** null = the file was deleted by this change. */
  next: string | null;
  /** Which machine/session recorded it (ORPLEX_MACHINE_ID or "browser"). */
  peer: string;
  /** Set on inverse entries created by undo. */
  undoOf?: string;
  /** Keep markers share history.jsonl with the existing write/undo entries. */
  event?: "change" | "keep";
  /** Binary snapshots are base64 encoded; old entries default to UTF-8. */
  encoding?: "utf8" | "base64";
}

export const MAX_ENTRIES = 200;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export function historyPath(root: string): string {
  return join(root, ".orplex", "history.jsonl");
}

/**
 * Containment check: reject paths that escape the workspace root.
 * Mirrors the logic in src/app/api/workspace-file/route.ts.
 */
export function isPathInsideWorkspace(root: string, p: string): boolean {
  if (!p || p.length > 1024) return false;
  // Reject absolute Windows drive paths and UNC prefixes outright.
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\")) return false;
  if (p.includes("\0")) return false;
  const resolvedRoot = resolve(root);
  const full = resolve(resolvedRoot, p);
  return full === resolvedRoot || full.startsWith(resolvedRoot + sep);
}

export function safeJoinWorkspace(root: string, p: string): string | null {
  if (!isPathInsideWorkspace(root, p)) return null;
  return resolve(resolve(root), p);
}

export function parseEntries(raw: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as Partial<HistoryEntry>;
      if (typeof e.t === "number" && typeof e.path === "string" && typeof e.peer === "string") {
        if (e.event === "keep") {
          out.push({ t: e.t, path: e.path, prev: null, next: null, peer: e.peer, event: "keep" });
        } else if ("prev" in e && (typeof e.next === "string" || e.next === null)) {
          out.push({
            t: e.t,
            path: e.path,
            prev: e.prev ?? null,
            next: e.next,
            peer: e.peer,
            ...(e.undoOf ? { undoOf: e.undoOf } : {}),
            event: "change",
            ...(e.encoding === "base64" ? { encoding: "base64" as const } : {}),
          });
        }
      }
    } catch {
      // Torn line from a crash mid-append — skip, never fail the read.
    }
  }
  return out;
}

/**
 * Append one entry. Streams a single write; never reads the file.
 * Returns false when the change is too large to record. Mutating callers must
 * refuse the write when this happens so they never create an un-undoable edit.
 */
export async function appendHistory(
  root: string,
  entry: Omit<HistoryEntry, "t" | "peer" | "event"> & { t?: number; peer?: string }
): Promise<boolean> {
  if (!isPathInsideWorkspace(root, entry.path)) return false;
  // Snapshot cap: base64-inflated binaries must still fit — a 12MB extracted
  // asset ≈ 16MB of base64 — while keeping history lines bounded (compaction
  // via MAX_FILE_BYTES handles file growth). Beyond this the caller skips the
  // write rather than create an un-recordable change.
  if ((entry.prev?.length ?? 0) > 32_000_000 || (entry.next?.length ?? 0) > 32_000_000) return false;
  const full: HistoryEntry = {
    t: entry.t ?? Date.now(),
    path: entry.path,
    prev: entry.prev,
    next: entry.next,
    peer: entry.peer ?? "server",
    event: "change",
    ...(entry.encoding === "base64" ? { encoding: "base64" as const } : {}),
    ...(entry.undoOf ? { undoOf: entry.undoOf } : {}),
  };
  const file = historyPath(root);
  const { appendFile, mkdir } = await import("node:fs/promises");
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(full) + "\n", "utf8");
  return true;
}

/** Record acceptance in the same durable history used by tool undo. */
export async function appendKeepMarker(root: string, path: string, peer = "browser"): Promise<boolean> {
  if (!isPathInsideWorkspace(root, path)) return false;
  return appendKeepMarkers(root, [path], peer);
}

export async function appendKeepMarkers(root: string, paths: readonly string[], peer = "browser"): Promise<boolean> {
  if (paths.some((path) => !isPathInsideWorkspace(root, path))) return false;
  if (paths.length === 0) return true;
  const file = historyPath(root);
  const { appendFile, mkdir } = await import("node:fs/promises");
  await mkdir(dirname(file), { recursive: true });
  const timestamp = Date.now();
  await appendFile(
    file,
    paths.map((path) => JSON.stringify({ t: timestamp, path, peer, event: "keep" })).join("\n") + "\n",
    "utf8",
  );
  return true;
}

export interface PendingHistoryChange {
  path: string;
  prev: string | null;
  next: string | null;
  encoding: "utf8" | "base64";
}

/** Collapse repeated writes to each path back to its first snapshot since Keep. */
export function getPendingHistoryChanges(entries: readonly HistoryEntry[]): PendingHistoryChange[] {
  const pending = new Map<string, PendingHistoryChange>();
  for (const entry of entries) {
    if (entry.event === "keep") {
      pending.delete(entry.path);
      continue;
    }
    const first = pending.get(entry.path);
    pending.set(entry.path, {
      path: entry.path,
      prev: first ? first.prev : entry.prev,
      next: entry.next,
      encoding: first?.encoding ?? entry.encoding ?? "utf8",
    });
  }
  return [...pending.values()].filter((item) => item.prev !== item.next);
}

/** Read all entries, oldest first, enforcing the quota by dropping the OLDEST overflow. */
export async function readHistory(root: string, since?: number): Promise<HistoryEntry[]> {
  let raw: string;
  try {
    const { readFile } = await import("node:fs/promises");
    raw = await readFile(historyPath(root), "utf8");
  } catch {
    return [];
  }
  let entries = parseEntries(raw);
  if (since != null) entries = entries.filter((e) => e.t > since);
  if (entries.length > MAX_ENTRIES) {
    const retained = new Set<number>();
    for (let i = Math.max(0, entries.length - MAX_ENTRIES); i < entries.length; i++) retained.add(i);
    for (const pending of getPendingHistoryChanges(entries)) {
      let first = -1;
      let last = -1;
      for (let i = 0; i < entries.length; i++) {
        const event = entries[i];
        if (event.path !== pending.path) continue;
        if (event.event === "keep") {
          first = -1;
          last = -1;
          continue;
        }
        if (first === -1) first = i;
        last = i;
      }
      if (first !== -1) retained.add(first);
      if (last !== -1) retained.add(last);
    }
    entries = [...retained].sort((a, b) => a - b).map((index) => entries[index]);
  }
  return entries;
}

/** Quota enforcement: rewrite the file keeping only the newest MAX_ENTRIES (and under MAX_FILE_BYTES). */
async function compactHistory(root: string): Promise<number> {
  const file = historyPath(root);
  const { mkdir, readFile, rename, stat, writeFile } = await import("node:fs/promises");
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
 * whose content no longer matches `currentContent`. Omit currentContent to
 * match anything.
 */
export function findUndoTarget(entries: HistoryEntry[], path: string, currentContent?: string | null): HistoryEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.path !== path) continue;
    if (e.event === "keep") return null;
    if (e.undoOf) continue;
    if (currentContent !== undefined && e.next !== currentContent) continue;
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
    next: target.prev,
    peer: machineId,
    event: "change",
    ...(target.encoding ? { encoding: target.encoding } : {}),
    undoOf: `${target.t}:${target.path}`,
  };
}

export function machineId(): string {
  return process.env.ORPLEX_MACHINE_ID || "orplex-local";
}
