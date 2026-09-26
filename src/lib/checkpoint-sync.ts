// checkpoint-sync.ts — "Checkpoints you own": push/pull ONLY the
// refs/orplex/checkpoints/* namespace to the workspace's own git remote.
//
// Safety rails (mirroring ORPLEX_PUSH_BRANCH discipline):
//   - the namespace is the ONLY thing pushed/pulled — user branches, tags,
//     and history are never touched;
//   - no force anywhere: a rejected push fails honestly;
//   - credentials come from the server process's git (GCM/SSH/gh) — this
//     module never sees or stores a token.
// Opt-in: ORPLEX_PUSH_CHECKPOINTS=1. Never runs concurrently with a verify
// lane (callers execute it in the executor's serial section).

import { execFile } from "node:child_process";

const GIT_TIMEOUT_MS = 60_000;
export const REF_NAMESPACE = "refs/orplex/checkpoints";

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: root, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 300)));
      else resolve(stdout);
    });
  });
}

export function checkpointsPushEnabled(): boolean {
  return process.env.ORPLEX_PUSH_CHECKPOINTS === "1";
}

export async function hasRemote(root: string): Promise<boolean> {
  try {
    const out = await git(root, ["remote"]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Push the checkpoint namespace. Never branches, never tags, never force.
 * Returns { pushed: true } or an honest failure reason.
 */
export async function pushCheckpoints(root: string): Promise<{ pushed: boolean; reason?: string }> {
  if (!checkpointsPushEnabled()) return { pushed: false, reason: "ORPLEX_PUSH_CHECKPOINTS not enabled" };
  if (!(await hasRemote(root))) return { pushed: false, reason: "no origin remote" };
  try {
    await git(root, ["push", "origin", `${REF_NAMESPACE}:${REF_NAMESPACE}`]);
    return { pushed: true };
  } catch (err) {
    return { pushed: false, reason: (err as Error).message.slice(0, 200) };
  }
}

/**
 * Pull the checkpoint namespace from the remote. Fetch is always safe — it
 * writes nothing but remote-tracking refs; we then copy fetched refs into
 * the local namespace only where missing (local checkpoints win on collision).
 */
export async function pullCheckpoints(root: string): Promise<{ pulled: number; reason?: string }> {
  if (!(await hasRemote(root))) return { pulled: 0, reason: "no origin remote" };
  try {
    await git(root, ["fetch", "origin", `+${REF_NAMESPACE}:${REF_NAMESPACE}`]);
  } catch (err) {
    return { pulled: 0, reason: (err as Error).message.slice(0, 200) };
  }
  try {
    const out = await git(root, ["for-each-ref", "--format=%(refname)", REF_NAMESPACE]);
    return { pulled: out.trim() ? out.trim().split("\n").length : 0 };
  } catch {
    return { pulled: 0 };
  }
}
