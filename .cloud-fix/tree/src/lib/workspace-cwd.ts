// workspace-cwd.ts — Server-side registry of each user's real workspace path.
//
// The renderer picks a folder via the File System Access API (real folder in
// Electron) and registers its ABSOLUTE path here. Agent commands then execute
// in that directory instead of Orplex's own folder.
//
// SECURITY: the registry is keyed by userId. Before this change a single
// module-level string was shared by every session — on a hosted deployment,
// user A registering a workspace redirected user B's exec cwd (correctness
// bug AND cross-user filesystem exposure). Local desktop use has exactly one
// user, which is why the bug was invisible there.

import { stat } from "node:fs/promises";

const MAX_PATH_LENGTH = 500;
/** Registered paths per user. Small: one open folder per session. */
const workspaceCwds = new Map<string, string>();

function sanitizeUserId(userId: string): string | null {
  return typeof userId === "string" && userId.length > 0 && userId.length <= 128
    ? userId
    : null;
}

/** Register a workspace directory for a user. Returns false if invalid. */
export async function setWorkspaceCwd(path: string, userId: string): Promise<boolean> {
  const uid = sanitizeUserId(userId);
  if (!uid) return false;
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  try {
    const s = await stat(path);
    if (!s.isDirectory()) return false;
    workspaceCwds.set(uid, path);
    // Durable copy: the in-memory map dies with the process, and a restart
    // must not break merges of runs whose worktrees point at this workspace.
    // Fire-and-forget — a DB hiccup must not fail the registration itself.
    void (async () => {
      try {
        const { prisma } = await import("@/lib/prisma");
        await prisma.user.update({ where: { id: uid }, data: { workspacePath: path } });
      } catch {}
    })();
    return true;
  } catch {
    return false;
  }
}

/** Current workspace cwd for a user, or null when no folder is open. */
export function getWorkspaceCwdForUser(userId: string): string | null {
  const uid = sanitizeUserId(userId);
  return uid ? (workspaceCwds.get(uid) ?? null) : null;
}

/**
 * Resolve the workspace cwd with a DB fallback for process-local misses.
 *
 * The in-memory Map is per-process; the executor and the merge gate run
 * server-side and must survive restarts (live-observed: after a restart,
 * merge_run failed with "No registered workspace" while the run itself had
 * executed against the repo fine). Order: session Map → durable
 * User.workspacePath (stat-checked — a moved/deleted folder is rejected).
 */
export async function resolveWorkspaceCwd(userId: string): Promise<string | null> {
  const inMemory = getWorkspaceCwdForUser(userId);
  if (inMemory) return inMemory;
  const uid = sanitizeUserId(userId);
  if (!uid) return null;
  try {
    const { prisma } = await import("@/lib/prisma");
    const user = await prisma.user.findUnique({ where: { id: uid }, select: { workspacePath: true } });
    if (!user?.workspacePath) return null;
    const s = await stat(user.workspacePath);
    if (!s.isDirectory()) return null;
    // Re-seed the session Map so subsequent sync lookups hit without DB I/O.
    workspaceCwds.set(uid, user.workspacePath);
    return user.workspacePath;
  } catch {
    return null;
  }
}

/** Clear a user's registration (folder closed / session reset). */
export function clearWorkspaceCwd(userId: string): void {
  const uid = sanitizeUserId(userId);
  if (uid) workspaceCwds.delete(uid);
}

/**
 * DEPRECATED single-tenant accessor — resolves the cwd for a KNOWN user id.
 *
 * Kept only because some server-side call sites (backup, tooling) run outside
 * a request context. Every per-request route MUST use getWorkspaceCwdForUser
 * with the authenticated user's id. Never call this with data derived from a
 * request body.
 */
export function getWorkspaceCwd(userId: string): string | null {
  return getWorkspaceCwdForUser(userId);
}
