// project-registry.ts — Local, per-device roster of the workspace folders the
// user has opened, plus an IndexedDB store that persists their
// FileSystemDirectoryHandles so projects survive restarts and can re-attach
// with a single permission click (Chromium persists handles across sessions).
//
// Split by design:
//   • Roster functions (listProjects/rememberProject/touchProject/…) are PURE
//     — they take a Storage-like object, so the Jest node suite can unit-test
//     them without a browser.
//   • The handle store is a ~40-line hand-rolled IndexedDB wrapper (no
//     dependency) with a promisified request core. In non-browser contexts
//     (tests, SSR) every function degrades to a no-op/null instead of throw.

const HANDLE_DB_NAME = "orplex-project-handles";
const HANDLE_STORE = "handles";
const MAX_PROJECTS = 50;

export interface ProjectEntry {
  /** Folder name — the join key to Conversation.workspaceName. */
  name: string;
  /** Optional user-set alias (rename in the context menu). */
  displayName?: string;
  /** Last opened on THIS device (ms epoch) — drives sort order. */
  lastOpenedAt: number;
  /** True when the roster knows the project but this device has no handle. */
  ghost?: boolean;
  /** Absolute path (captured at folder-open, Electron only) for Reveal in
   * Explorer/Finder. Device-specific; present only where we saw it. */
  lastPath?: string;
}

// === Pure roster core (Storage-like injected) ==============================

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

/** Shared storage key (sync + tests import it — never re-hardcode). */
export const PROJECTS_STORAGE_KEY = "orplex.projects.v1";
const REGISTRY_KEY = PROJECTS_STORAGE_KEY;

/** Parse + validate the stored roster; corrupt data falls back to []. */
export function parseRoster(raw: string | null): ProjectEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is ProjectEntry =>
          p && typeof p === "object" && typeof (p as ProjectEntry).name === "string" && (p as ProjectEntry).name.length > 0
      )
      .slice(0, MAX_PROJECTS)
      .map((p) => ({
        name: p.name,
        displayName: typeof p.displayName === "string" ? p.displayName : undefined,
        lastOpenedAt: typeof p.lastOpenedAt === "number" ? p.lastOpenedAt : 0,
        ghost: !!p.ghost,
        lastPath: typeof (p as ProjectEntry).lastPath === "string" ? (p as ProjectEntry).lastPath : undefined,
      }));
  } catch {
    return [];
  }
}

function serializeRoster(entries: ProjectEntry[]): string {
  return JSON.stringify(entries.slice(0, MAX_PROJECTS));
}

/** List projects, most-recently-opened first. */
export function listProjects(storage: StorageLike): ProjectEntry[] {
  return parseRoster(storage.getItem(REGISTRY_KEY)).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/**
 * Insert or update a project in the roster. Exists → updates timestamp/
 * displayName/ghost per args; missing → prepended. Returns the new roster.
 */
export function rememberProject(
  storage: StorageLike,
  name: string,
  opts: { displayName?: string; ghost?: boolean; openedAt?: number } = {}
): ProjectEntry[] {
  const trimmed = name.trim();
  if (!trimmed) return listProjects(storage);
  const rest = parseRoster(storage.getItem(REGISTRY_KEY));
  const existing = rest.find((p) => p.name === trimmed);
  const next: ProjectEntry[] = [
    {
      name: trimmed,
      displayName: opts.displayName ?? existing?.displayName,
      lastOpenedAt: opts.openedAt ?? Date.now(),
      ghost: opts.ghost ?? existing?.ghost ?? false,
      // lastPath survives re-materialization: a sync-triggered remember used
      // to rebuild the row without it, and the desktop terminal lane reads
      // cwd from exactly this field — dropping it made every agent command
      // fail with "no workspace folder path is registered".
      lastPath: existing?.lastPath,
    },
    ...rest.filter((p) => p.name !== trimmed),
  ].slice(0, MAX_PROJECTS);
  storage.setItem(REGISTRY_KEY, serializeRoster(next));
  return next;
}

/** Update lastOpenedAt (activity ordering); no-op for unknown projects. */
export function touchProject(storage: StorageLike, name: string, at: number = Date.now()): ProjectEntry[] {
  const rest = parseRoster(storage.getItem(REGISTRY_KEY));
  if (!rest.some((p) => p.name === name)) return listProjects(storage);
  const next = rest.map((p) => (p.name === name ? { ...p, lastOpenedAt: at } : p));
  storage.setItem(REGISTRY_KEY, serializeRoster(next));
  return next;
}

/** Rename the display alias (folder `name` is immutable — it's the join key). */
export function setProjectAlias(storage: StorageLike, name: string, displayName: string | null): ProjectEntry[] {
  const rest = parseRoster(storage.getItem(REGISTRY_KEY));
  if (!rest.some((p) => p.name === name)) return listProjects(storage);
  const next = rest.map((p) =>
    p.name === name ? { ...p, displayName: displayName && displayName.trim() ? displayName.trim() : undefined } : p
  );
  storage.setItem(REGISTRY_KEY, serializeRoster(next));
  return next;
}

/**
 * Record the absolute folder path for a project.
 *
 * UPSERT: a missing row is created on the spot. It used to be a silent no-op
 * for unknown names — and on the FIRST picker open no other writer created
 * the row, so a freshly-resolved absolute path was dropped and every later
 * agent command failed with "no workspace folder path is registered" even
 * though the folder was plainly open (live-observed 2026-10-19, psd10).
 */
export function setProjectPath(storage: StorageLike, name: string, path: string): ProjectEntry[] {
  const trimmed = name.trim();
  if (!trimmed || !path) return listProjects(storage);
  const rest = parseRoster(storage.getItem(REGISTRY_KEY));
  const existing = rest.find((p) => p.name === trimmed);
  const next = existing
    ? rest.map((p) => (p.name === trimmed ? { ...p, lastPath: path } : p))
    : [{ name: trimmed, lastOpenedAt: Date.now(), lastPath: path }, ...rest].slice(0, MAX_PROJECTS);
  storage.setItem(REGISTRY_KEY, serializeRoster(next));
  return next;
}

/** Forget a project on this device (files/threads untouched). */
export function forgetProject(storage: StorageLike, name: string): ProjectEntry[] {
  const next = parseRoster(storage.getItem(REGISTRY_KEY)).filter((p) => p.name !== name);
  storage.setItem(REGISTRY_KEY, serializeRoster(next));
  return next;
}

/**
 * Merge a synced roster (e.g. from /api/projects on another machine) into the
 * local one: union by name, newer lastOpenedAt wins, local displayName kept
 * when the remote has none. Ghost flags only ever turn ON locally (a synced
 * name with no local handle), never OFF (that's this device's knowledge).
 */
export function mergeRosters(local: ProjectEntry[], remote: ProjectEntry[]): ProjectEntry[] {
  const byName = new Map<string, ProjectEntry>();
  for (const p of local) byName.set(p.name, { ...p });
  for (const r of remote) {
    if (!r?.name) continue;
    const existing = byName.get(r.name);
    if (!existing) {
      byName.set(r.name, { ...r, ghost: true, lastOpenedAt: r.lastOpenedAt || 0 });
    } else {
      existing.lastOpenedAt = Math.max(existing.lastOpenedAt, r.lastOpenedAt || 0);
      existing.displayName = existing.displayName ?? r.displayName;
      // ghost stays as-is: local handle knowledge beats remote absence.
      if (existing.ghost === undefined) existing.ghost = false;
    }
  }
  return [...byName.values()]
    .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
    .slice(0, MAX_PROJECTS);
}

/** Convenience accessor for the real browser environment. */
export function listProjectsLocal(): ProjectEntry[] {
  try {
    return listProjects(window.localStorage);
  } catch {
    return [];
  }
}

// === FileSystemDirectoryHandle persistence (IndexedDB) ====================

/** Open (and upgrade) the handle DB. Returns null outside the browser. */
function openHandleDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(HANDLE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return openHandleDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(HANDLE_STORE, mode);
          const req = fn(tx.objectStore(HANDLE_STORE));
          req.onsuccess = () => resolve(req.result as T);
          req.onerror = () => resolve(null);
          tx.oncomplete = () => db.close();
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      })
  );
}

/** Persist a directory handle under its folder name. Best-effort. */
export async function saveProjectHandle(name: string, handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore("readwrite", (store) => store.put(handle, name));
}

/** Load a persisted handle, or null when absent/unavailable. */
export async function loadProjectHandle(name: string): Promise<FileSystemDirectoryHandle | null> {
  const handle = await withStore<FileSystemDirectoryHandle>("readonly", (store) => store.get(name));
  return handle ?? null;
}

/** Delete a persisted handle (project removed / ghost conversion). */
export async function deleteProjectHandle(name: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(name));
}

/**
 * Query/ask permission for a persisted handle (Chromium only).
 * query=true → don't prompt (silent check); false → show the one-click prompt.
 * Resolves "granted" | "denied" | "unsupported".
 */
export async function requestHandlePermission(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "readwrite",
  query = false
): Promise<"granted" | "denied" | "unsupported"> {
  try {
    const anyHandle = handle as any;
    if (typeof anyHandle.queryPermission !== "function" || typeof anyHandle.requestPermission !== "function") {
      return "unsupported";
    }
    const opts = { mode };
    const state: string = query ? await anyHandle.queryPermission(opts) : await anyHandle.requestPermission(opts);
    return state === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}
