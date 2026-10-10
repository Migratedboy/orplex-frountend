// LAYER 1 — working/session history. Tracks all writes for undo/rollback.
//
// Durability: the history mirrors itself into sessionStorage so the undo
// safety net survives a page reload — the same survival model as the task
// snapshot/restore in useChatSession. (Server-side persistence would be the
// next step; sessionStorage keeps this module dependency-free and sync.)
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
const MAX_HISTORY = 50;

const STORAGE_KEY = "orplex.file-history.v1";

function storageAvailable(): boolean {
  try {
    return typeof window !== "undefined" && !!window.sessionStorage;
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

/** Restore entries persisted by a previous page load (same tab). */
function hydrate(): void {
  if (!storageAvailable()) return;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const restored = parsed.filter(isValidChange);
    history.length = 0;
    history.push(...restored);
  } catch {
    // Corrupted snapshot — start fresh rather than poisoning undo.
  }
}

function persist(): void {
  if (!storageAvailable()) return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Quota exceeded (large files): drop the oldest half and retry once.
    // Undo degrades gracefully but never crashes the write path.
    try {
      const keep = Math.max(1, Math.ceil(history.length / 2));
      history.length = keep;
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
      // Give up silently — in-memory undo still works for this session's writes.
    }
  }
}

hydrate();

/** Record a file change (call BEFORE writing) */
export function recordChange(path: string, previousContent: string | null, newContent: string) {
  history.unshift({ path, previousContent, newContent, timestamp: Date.now() });
  if (history.length > MAX_HISTORY) history.pop();
  persist();
  mirrorToServer(path, previousContent, newContent);
}

// --- Durable mirror (split-deployment aware) ---------------------------------
// Fire-and-forget POST to /api/agent/history so undo survives machines and
// tabs. Failures are silent by design: the local buffer stays authoritative
// for this session; the server copy is the durable twin.
let mirrorInFlight = 0;

function mirrorToServer(path: string, prev: string | null, next: string): void {
  if (mirrorInFlight >= 4) return; // backpressure: never queue a storm
  mirrorInFlight++;
  const body = JSON.stringify({ path, prev, next, t: Date.now() });
  fetch("/api/agent/history", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body,
    signal: AbortSignal.timeout(4000),
    keepalive: true,
  })
    .catch(() => {})
    .finally(() => {
      mirrorInFlight--;
    });
}

/**
 * Hydrate the local buffer from the durable server copy (new tab, another
 * machine). Server entries FILL GAPS only — newer local entries win.
 */
export async function hydrateFromServer(): Promise<number> {
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

/** Peek at the previous content without removing the history entry */
export function getPreviousContent(path: string): string | null {
  const idx = history.findIndex(c => c.path === path);
  if (idx === -1) return null;
  return history[idx].previousContent;
}

/** Undo the last change to a specific file — returns the previous content */
export function undoLastChange(path: string): string | null {
  const idx = history.findIndex(c => c.path === path);
  if (idx === -1) return null;
  const change = history[idx];
  history.splice(idx, 1);
  persist();
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
