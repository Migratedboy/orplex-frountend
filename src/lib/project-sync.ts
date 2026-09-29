// project-sync.ts — Cross-machine roster sync for the Projects sidebar.
//
// WHAT moves: project NAMES + display aliases + lastOpenedAt (the roster).
// WHAT NEVER moves: FileSystemDirectoryHandles and absolute paths — they are
// device-bound, so a synced-but-unbound project becomes a ghost row on the
// receiving machine (mergeRosters sets ghost; the UI explains it).
//
// Conventions: authenticated like every user-scoped endpoint (session cookie
// via apiFetch — the same next-auth session the sibling routes read), NOT a
// second signed-transport scheme; the HMAC envelope machinery in
// sync-transport.ts is for workspace-file mailbox sync between peers, while
// this roster lives per-user in Postgres. The pure core below injects fetch,
// so tests cover offline failure / conflict / first-sync without a browser.
//
// Failure tolerance: every entry point resolves to a typed SyncResult and
// never throws — offline use must never block the sidebar.

import { listProjects, mergeRosters, PROJECTS_STORAGE_KEY, type ProjectEntry, type StorageLike } from "./project-registry";
import { apiFetch } from "./api-base";

export const PROJECTS_ENDPOINT = "/api/projects";

/**
 * Server-side tombstone for forgotten projects so the next sync pull cannot
 * resurrect them as ghost rows. Fire-and-forget by contract (callers .catch).
 * Best-effort auth via apiFetch (session cookie); offline is fine — the next
 * successful PUT re-pushes only existing projects anyway, and the roster
 * stays consistent per-machine until connectivity returns.
 */
export async function forgetProjectsRemote(names: string[]): Promise<{ ok: boolean; removed?: number }> {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return { ok: false };
  try {
    const res = await apiFetch(PROJECTS_ENDPOINT, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: clean }),
    });
    if (!res.ok) return { ok: false };
    const body = await res.json().catch(() => ({}));
    return { ok: true, removed: typeof body?.removed === "number" ? body.removed : 0 };
  } catch {
    return { ok: false };
  }
}

export interface SyncResult {
  ok: boolean;
  /** "offline" = fetch/network failure — the local roster is untouched. */
  reason?: "unauthenticated" | "offline" | "server-error" | "bad-response";
  /** Projects now in the local roster after the sync (ok only). */
  projects?: ProjectEntry[];
  /** How many remote entries the server reported accepting on push. */
  pushed?: number;
}

/** The wire shape — deliberately narrow (no handles, no paths, no userId). */
export interface ProjectWireEntry {
  name: string;
  displayName?: string;
  lastOpenedAt: number;
}

/** Local roster → push payload (name/alias/timestamp only). */
export function buildPushEntries(local: ProjectEntry[]): ProjectWireEntry[] {
  return local
    .filter((p) => p && typeof p.name === "string" && p.name.length > 0)
    .map((p) => ({ name: p.name, displayName: p.displayName, lastOpenedAt: p.lastOpenedAt || 0 }));
}

/** Validate one remote entry; anything malformed is dropped, not fatal. */
function parseRemoteEntry(raw: unknown): ProjectEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || r.name.length === 0) return null;
  return {
    name: r.name,
    displayName: typeof r.displayName === "string" ? r.displayName : undefined,
    lastOpenedAt: typeof r.lastOpenedAt === "number" ? r.lastOpenedAt : 0,
    ghost: true, // remote rows never carry a local handle
    lastPath: undefined,
  };
}

export interface SyncDeps {
  storage: StorageLike;
  fetchImpl: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
  endpoint?: string;
}

/** The one apiFetch→SyncDeps adapter (the hook passes it; tests inject fakes). */
export function syncNow(storage: StorageLike): Promise<SyncResult> {
  return syncProjects({
    storage,
    fetchImpl: (input, init) =>
      apiFetch(input, init as RequestInit).then((r) => ({ ok: r.ok, status: r.status, json: () => r.json() })),
  });
}

/**
 * One sync cycle: PUSH the local roster (upsert batch), PULL the remote
 * roster, merge with mergeRosters, and write the merged roster back.
 * - Unauthenticated → no-op (the sidebar just shows the local roster).
 * - Offline/server error → local roster untouched, ok:false with a reason.
 * - First sync (empty remote) → push-only; local roster returned unchanged.
 */
export async function syncProjects(deps: SyncDeps): Promise<SyncResult> {
  const endpoint = deps.endpoint || PROJECTS_ENDPOINT;
  const local = listProjects(deps.storage);

  let res;
  try {
    res = await deps.fetchImpl(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projects: buildPushEntries(local) }),
    });
  } catch {
    return { ok: false, reason: "offline" };
  }

  if (res.status === 401) return { ok: false, reason: "unauthenticated" };
  if (!res.ok) return { ok: false, reason: "server-error" };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "bad-response" };
  }

  const raw = (body as { projects?: unknown[] })?.projects;
  if (!Array.isArray(raw)) return { ok: false, reason: "bad-response" };

  const remote = raw.map(parseRemoteEntry).filter((p): p is ProjectEntry => p !== null);
  const pushed = typeof (body as { accepted?: number })?.accepted === "number" ? (body as { accepted: number }).accepted : 0;

  // Remote-only entries arrive ghosted; mergeRosters handles conflicts
  // (newer lastOpenedAt wins, local alias preserved, local ghost knowledge
  // never cleared). The CALLER persists the merged roster — sync never
  // touches storage beyond reading it (single owner of writes).
  const merged = mergeRosters(local, remote);

  return { ok: true, projects: merged, pushed };
}
