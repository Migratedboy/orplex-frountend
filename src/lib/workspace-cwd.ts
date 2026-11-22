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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_PATH_LENGTH = 500;
/** Registered paths per user. Small: one open folder per session. */
const workspaceCwds = new Map<string, string>();
/** Users cleared in THIS process: without a tombstone the persist-merge below
 *  would keep re-adding their old entry from the file. */
const clearedUsers = new Set<string>();

/**
 * Durable, DEVICE-LOCAL registry file: <ORPLEX_WORKSPACES_FILE> (the desktop
 * app points it at its per-user data dir) or <cwd>/.orplex/workspaces.json.
 *
 * The in-memory Map alone died with the process, so every app restart forgot
 * the open folder: the Plugins page went back to "no workspace open", the
 * agent lost its terminal cwd, and the DB fallback could not help because the
 * desktop's Postgres is not the store that matters here. The file keeps the
 * mapping on THIS machine, next to the rest of the device-local state.
 */
function workspaceFilePath(): string {
  return process.env.ORPLEX_WORKSPACES_FILE || join(process.cwd(), ".orplex", "workspaces.json");
}

/** Seed the map from the durable file. Never throws. */
function loadWorkspaceFile(): void {
  for (const [uid, path] of Object.entries(readWorkspaceFile())) {
    workspaceCwds.set(uid, path);
  }
}

/** The durable file as a plain map (empty when absent/unreadable). */
function readWorkspaceFile(): Record<string, string> {
  try {
    const raw = readFileSync(workspaceFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (parsed && typeof parsed === "object") {
      const out: Record<string, string> = {};
      for (const [uid, path] of Object.entries(parsed)) {
        if (typeof uid === "string" && typeof path === "string" && path) out[uid] = path;
      }
      return out;
    }
  } catch {
    // No file yet (or unreadable) → nothing durable to merge.
  }
  return {};
}

/** Persist the mapping (atomic tmp + rename). Never throws. */
function persistWorkspaceFile(): void {
  try {
    const file = workspaceFilePath();
    mkdirSync(dirname(file), { recursive: true });
    // Merge with what is already on disk: each route handler has its own copy
    // of the Map (see getWorkspaceCwdForUser), so writing only this chunk's
    // entries would delete every other chunk's registrations.
    const merged = { ...readWorkspaceFile(), ...Object.fromEntries(workspaceCwds) };
    for (const uid of clearedUsers) delete merged[uid];
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 1), "utf8");
    renameSync(tmp, file);
  } catch {
    // A read-only disk must not break the registration itself.
  }
}

loadWorkspaceFile();

function sanitizeUserId(userId: string): string | null {
  return typeof userId === "string" && userId.length > 0 && userId.length <= 128
    ? userId
    : null;
}

/**
 * True when the path is unambiguously rooted on ANOTHER operating system than
 * this one, so its absence here says nothing about whether it exists.
 *
 * Split deployment registers a folder on the user's own machine — a Windows
 * path posted from the desktop UI to a Linux backend (or a POSIX path posted
 * from a Mac). `stat()` cannot succeed there, so the old "must be a directory
 * on the server" rule rejected EVERY client-local folder and the UI raised
 * "Could not register <path> as the workspace (HTTP 400 — Invalid
 * directory)" for all of them.
 *
 * This is deliberately narrow: only a Windows drive/UNC root (which no POSIX
 * host can possess) and only a POSIX path that is not even syntactically
 * checkable here. Anything that could plausibly exist on this host still has
 * to pass `stat`.
 */
function isForeignOsPath(path: string): boolean {
  // Windows: `C:\...`, `C:/...`, `\\server\share\...`
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  if (/^\\\\[^\\/]/.test(path)) return true;
  return false;
}

/** Register a workspace directory for a user. Returns false if invalid. */
export async function setWorkspaceCwd(path: string, userId: string): Promise<boolean> {
  const uid = sanitizeUserId(userId);
  if (!uid) return false;
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  try {
    const s = await stat(path);
    if (!s.isDirectory()) return false;
  } catch {
    // Not visible from this host. That is expected — and not a validation
    // failure — for a folder that lives on the user's own machine. Reject it
    // only when it COULD have been checked here and still failed.
    if (!isForeignOsPath(path)) return false;
  }
  workspaceCwds.set(uid, path);
  clearedUsers.delete(uid);
  // Durable DEVICE-LOCAL copy: the in-memory map dies with the process, and a
  // restart must not break merges of runs whose worktrees point at this
  // workspace (or the Plugins page, which is scoped to this folder).
  persistWorkspaceFile();
  // Cloud mirror — best effort, a DB hiccup must not fail the registration.
  void (async () => {
    try {
      const { prisma } = await import("@/lib/prisma");
      await prisma.user.update({ where: { id: uid }, data: { workspacePath: path } });
    } catch {}
  })();
  return true;
}

/**
 * Current workspace cwd for a user, or null when no folder is open.
 *
 * The durable file wins over the in-memory map because route handlers do NOT
 * share module state: Next bundles each route separately, so the Map that
 * `setWorkspaceCwd` writes in /api/agent/workspace-cwd is a DIFFERENT instance
 * from the one /api/agent/fs reads. That divergence is exactly the "Files panel
 * always shows the first project's files" bug: the fs chunk was seeded at its
 * own module load and never learned about later registrations. Reading the file
 * (a few hundred bytes) makes every route agree.
 */
export function getWorkspaceCwdForUser(userId: string): string | null {
  const uid = sanitizeUserId(userId);
  if (!uid) return null;
  if (clearedUsers.has(uid)) return workspaceCwds.get(uid) ?? null;
  const durable = readWorkspaceFile()[uid];
  if (typeof durable === "string" && durable.length > 0) {
    workspaceCwds.set(uid, durable);
    return durable;
  }
  return workspaceCwds.get(uid) ?? null;
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
  if (!uid) return;
  workspaceCwds.delete(uid);
  clearedUsers.add(uid);
  // Persist, or the next read would resurrect the folder from the file.
  persistWorkspaceFile();
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
