// LAYER 1 — working/session history. Tracks all writes for undo/rollback.
//
// Durability: the history mirrors itself into localStorage and the workspace
// history endpoint, so pending snapshots survive reloads and app restarts.
//
// This is still NOT git and NOT durable: a bounded, best-effort snapshot
// buffer (50 changes, quota-capped) powering undo_last_change + the Changes
// tab. Durable record lives in Layer 2 (workspace-history.ts).

interface FileChange {
  path: string;
  previousContent: string | null; // null = new file
  newContent: string;
  timestamp: number;
}

const history: FileChange[] = [];
const MAX_HISTORY = 500;

const STORAGE_KEY = "orplex.file-history.v2";
const listeners = new Set<() => void>();

function storageAvailable(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false; // storage access can throw in hardened browser contexts
  }
}

function isValidChange(c: unknown): c is FileChange {
  const v = c as Partial<FileChange> | null;
  return (
    !!v &&
    typeof v.path === "string" &&
    (v.previousContent === null || typeof v.previousContent === "string") &&
    typeof v.newContent === "string" &&
    typeof v.timestamp === "number"
  );
}

/** Restore entries persisted by a previous page load. */
function hydrate(): void {
  if (!storageAvailable()) return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem("orplex.file-history.v1") ??
      window.sessionStorage?.getItem("orplex.file-history.v1");
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const restored = parsed.filter(isValidChange);
    history.length = 0;
    history.push(...restored);
    if (!window.localStorage.getItem(STORAGE_KEY)) persist();
  } catch {
    // Corrupted snapshot — start fresh rather than poisoning undo.
  }
}

function persist(): boolean {
  if (!storageAvailable()) return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    return true;
  } catch {
    try {
      const keep = Math.max(1, Math.ceil(history.length / 2));
      history.length = keep;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
      return true;
    } catch {
      return false;
    }
  }
}

function notify(): void {
  for (const listener of listeners) listener();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("orplex:file-history-updated"));
  }
}

export function subscribeFileHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

hydrate();

/** Record a file change before applying it. */
export async function recordChange(
  path: string,
  previousContent: string | null,
  newContent: string,
  mirrorToWorkspace = true,
): Promise<void> {
  history.unshift({ path, previousContent, newContent, timestamp: Date.now() });
  if (history.length > MAX_HISTORY) history.pop();
  const persisted = persist();
  if (!persisted && storageAvailable()) {
    throw new Error("Could not persist the file snapshot; the write was stopped to preserve undo.");
  }
  notify();
  if (mirrorToWorkspace) await mirrorToServer(path, previousContent, newContent);
}

// --- Durable mirror (split-deployment aware) ---------------------------------
// Fire-and-forget POST to /api/agent/history so undo survives machines and
// tabs. Failures are silent by design: the local buffer stays authoritative
// for this session; the server copy is the durable twin.
async function mirrorToServer(path: string, prev: string | null, next: string): Promise<void> {
  if (typeof window === "undefined") return;
  const body = JSON.stringify({ path, prev, next, t: Date.now() });
  const response = await fetch("/api/agent/history", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body,
    signal: AbortSignal.timeout(20_000),
  }).catch((error: unknown) => {
    throw new Error(`Could not persist the workspace snapshot before writing ${path}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const result = await response.json().catch(() => null) as { recorded?: boolean; error?: string } | null;
  if (!response.ok || !result?.recorded) {
    throw new Error(`Could not persist the workspace snapshot before writing ${path}: ${result?.error || response.statusText || "history service unavailable"}`);
  }
}

/** Drop accepted history entries from the local undo buffer after server Keep. */
export function forgetChanges(paths: readonly string[]): void {
  const accepted = new Set(paths);
  for (let i = history.length - 1; i >= 0; i--) {
    if (accepted.has(history[i].path)) history.splice(i, 1);
  }
  persist();
  notify();
}

/**
 * Hydrate the local buffer from the durable server copy (new tab, another
 * machine). Server entries FILL GAPS only — newer local entries win.
 */
async function hydrateFromServer(): Promise<number> {
  if (!storageAvailable()) return 0;
  const oldestLocal = history.length > 0 ? history[history.length - 1].timestamp : 0;
  try {
    const res = await fetch(`/api/agent/history?since=${oldestLocal}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return 0;
    const j = (await res.json()) as { entries?: Array<{ t: number; path: string; prev: string | null; next: string }> };
    const entries = j.entries ?? [];
    if (entries.length === 0) return 0;
    const known = new Set(history.map((h) => `${h.timestamp}:${h.path}`));
    let added = 0;
    for (const e of entries) {
      const key = `${e.t}:${e.path}`;
      if (known.has(key)) continue;
      known.add(key);
      history.push({ path: e.path, previousContent: e.prev, newContent: e.next, timestamp: e.t });
      added++;
    }
    // Server returns oldest-first; keep the local newest-first ordering.
    history.sort((a, b) => b.timestamp - a.timestamp);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    persist();
    return added;
  } catch {
    return 0;
  }
}

/** Get the last N changes */
export function getRecentChanges(limit = 10): FileChange[] {
  return history.slice(0, limit);
}

export interface LocalPendingChange {
  path: string;
  previousContent: string | null;
  newContent: string | null;
}

/** Current-session pending snapshots, collapsed to the first write per file. */
export function getLocalPendingChanges(): LocalPendingChange[] {
  const pending = new Map<string, LocalPendingChange>();
  for (const change of [...history].reverse()) {
    const first = pending.get(change.path);
    pending.set(change.path, {
      path: change.path,
      previousContent: first ? first.previousContent : change.previousContent,
      newContent: change.newContent,
    });
  }
  return [...pending.values()].filter((item) => item.previousContent !== item.newContent);
}

/** Peek at the previous content without removing the history entry */
export function getPreviousContent(path: string): string | null {
  const idx = history.findIndex(c => c.path === path);
  if (idx === -1) return null;
  return history[idx].previousContent;
}

export function getLatestChange(path: string): FileChange | null {
  const change = history.find((entry) => entry.path === path);
  return change ? { ...change } : null;
}

export function forgetHistoryEntry(path: string, timestamp: number): void {
  const index = history.findIndex((entry) => entry.path === path && entry.timestamp === timestamp);
  if (index < 0) return;
  history.splice(index, 1);
  persist();
  notify();
}

/** Undo the last change to a specific file — returns the previous content */
export function undoLastChange(path: string): string | null {
  const idx = history.findIndex(c => c.path === path);
  if (idx === -1) return null;
  const change = history[idx];
  history.splice(idx, 1);
  persist();
  notify();
  return change.previousContent;
}

/** Generate a simple unified diff between two strings */
export function computeDiff(oldText: string | null, newText: string): string {
  if (oldText === null) {
    // New file
    const lines = newText.split("\n");
    if (lines.length <= 5) {
      return lines.map(l => `+ ${l}`).join("\n");
    }
    return `+ [New file: ${lines.length} lines]\n${lines.slice(0, 3).map(l => `+ ${l}`).join("\n")}\n+ ...`;
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const diff: string[] = [];

  // Simple line-by-line diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  let contextStart = -1;

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine !== newLine) {
      if (contextStart === -1) contextStart = Math.max(0, i - 1);
      if (oldLine !== undefined) diff.push(`- ${oldLine}`);
      if (newLine !== undefined) diff.push(`+ ${newLine}`);
    }
  }

  if (diff.length === 0) return "(no changes)";

  // Compact: if more than 20 lines changed, summarize
  if (diff.length > 20) {
    const added = diff.filter(l => l.startsWith("+")).length;
    const removed = diff.filter(l => l.startsWith("-")).length;
    return `[${added} lines added, ${removed} lines removed]\n${diff.slice(0, 10).join("\n")}\n... (${diff.length - 10} more changes)`;
  }

  return diff.join("\n");
}
