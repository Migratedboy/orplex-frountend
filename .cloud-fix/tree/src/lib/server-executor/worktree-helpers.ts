// worktree-helpers.ts — Small shared git utilities for API routes that
// operate on the user's registered workspace repo (merge/discard/diff).
// Kept separate from worktree.ts so routes don't pull in fs/copy machinery.

import { execFile } from "child_process";

export function gitInRepo(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${stderr || err.message}`.slice(0, 600)));
      else resolve(stdout.trim());
    });
  });
}
