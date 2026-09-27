// worktree.ts — Git-worktree isolation for server-side agent execution.
//
// Each isolated run gets a git worktree of the user's registered workspace:
// the agent writes into the worktree, so concurrent runs and the user's own
// edits never collide. Merging back is EXPLICIT (review → merge), and the
// worktree is always cleaned up. Prisma-free so the module stays unit-testable
// and importable from any server context.

import { execFile } from "child_process";
import { cp, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

const GIT_TIMEOUT_MS = 15_000;
const WORKTREE_ROOT = join(tmpdir(), "orplex-worktrees");

function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${stderr || err.message}`.slice(0, 400)));
      else resolve(stdout.trim());
    });
  });
}

export interface MergeOutcome {
  merged: boolean;
  conflict?: string;
  output?: string;
}

export interface WorktreeContext {
  id: string;
  rootDir: string;
  /** Directory the agent works in. */
  worktreeDir: string;
  branch: string;
  /** Starting branch of the root repo (null for non-git copies). */
  baseBranch: string | null;
  isGitRepo: boolean;
  /** Where the agent's changes were committed (HEAD sha), null if none. */
  commit: (message: string) => Promise<string | null>;
  /** Merge the worktree branch back into the repo's original branch. */
  mergeBack: () => Promise<MergeOutcome>;
  /** Files changed vs base (all files for non-git copies are untracked). */
  diffFiles: () => Promise<string[]>;
  /** Full unified diff of the branch vs base — the review-UI patch (empty for non-git). */
  patchText: () => Promise<string>;
  /** Push the branch to origin (60s timeout; honest failure without a remote). */
  pushBranch: () => Promise<PushOutcome>;
  /** Best-effort PR link: gh if installed, else the GitHub compare URL. */
  prLink: () => Promise<PrOutcome>;
  /** Remove the worktree + temp copy + branch (idempotent). */
  cleanup: () => Promise<void>;
}

export interface PushOutcome {
  pushed: boolean;
  /** Remote branch, e.g. origin/orplex/run-abc. */
  ref?: string;
  error?: string;
}

export interface PrOutcome {
  /** "gh" (PR actually opened), "compare-url" (link only), or "none" (no remote). */
  via: "gh" | "compare-url" | "none";
  /** PR URL or compare URL. */
  url?: string;
}

/** Extract origin's https URL from `git remote get-url origin` (handles ssh:// forms). */
export function originRepoSlug(remoteUrl: string): string | null {
  const m = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Deterministic compare-URL fallback for repos without `gh`. */
export function compareUrl(ownerRepo: string, base: string, branch: string): string {
  return `https://github.com/${ownerRepo}/compare/${base}...${encodeURIComponent(branch)}?expand=1`;
}

/**
 * Create an isolated working context for one agent run:
 *  - git repo  → a real worktree on a dedicated branch (orplex/run-<id>)
 *  - otherwise → a directory copy under the OS temp dir
 */
export async function createIsolatedContext(rootDir: string, runId: string): Promise<WorktreeContext> {
  const id = `run-${runId.slice(0, 12)}-${randomBytes(3).toString("hex")}`;
  let isGitRepo = false;
  try {
    await git(["rev-parse", "--is-inside-work-tree"], rootDir);
    isGitRepo = true;
  } catch {}

  if (!isGitRepo) {
    const copyDir = join(WORKTREE_ROOT, id);
    await mkdir(copyDir, { recursive: true });
    await cp(rootDir, copyDir, {
      recursive: true,
      filter: (src) =>
        !/(^|[\\/])(node_modules|\.git|\.next|dist|build|\.cache)([\\/]|$)/.test(src),
    });
    return {
      id,
      rootDir,
      worktreeDir: copyDir,
      branch: "",
      baseBranch: null,
      isGitRepo: false,
      async commit() {
        return null; // non-git: nothing to commit; merge is a no-op
      },
      async mergeBack() {
        return { merged: false, conflict: "non-git workspace — merge back not supported; agent wrote into an isolated copy" };
      },
      async diffFiles() {
        return [];
      },
      async patchText() {
        return ""; // directory copy: no git diff to show
      },
      async pushBranch() {
        return { pushed: false, error: "non-git workspace — nothing to push" };
      },
      async prLink() {
        return { via: "none" };
      },
      async cleanup() {
        await rm(copyDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  const baseBranch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], rootDir)) || "main";
  const branch = `orplex/${id}`;
  const worktreeDir = join(WORKTREE_ROOT, id);

  await mkdir(WORKTREE_ROOT, { recursive: true });
  // Worktrees cannot live inside the repo they branch from — temp dir is safe.
  await git(["worktree", "add", "-b", branch, worktreeDir], rootDir);

  const cleanup = async () => {
    await rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
    await git(["worktree", "prune"], rootDir).catch(() => {});
    await git(["branch", "-D", branch], rootDir).catch(() => {});
  };

  return {
    id,
    rootDir,
    worktreeDir,
    branch,
    baseBranch,
    isGitRepo: true,
    async commit(message) {
      try {
        await git(["add", "-A"], worktreeDir);
        const status = await git(["status", "--porcelain"], worktreeDir);
        if (!status) return null; // nothing changed
        await git(["-c", "user.name=Orplex Agent", "-c", "user.email=agent@orplex.local", "commit", "-m", message], worktreeDir);
        return await git(["rev-parse", "HEAD"], worktreeDir);
      } catch (err) {
        throw new Error(`worktree commit failed: ${(err as Error).message}`);
      }
    },
    async mergeBack() {
      try {
        // Guard: refuse if the user's tree has uncommitted changes that a
        // merge could tangle with.
        const dirty = await git(["status", "--porcelain"], rootDir);
        if (dirty) {
          return { merged: false, conflict: "workspace has uncommitted changes — commit or stash before merging the agent's work" };
        }
        // --no-ff always creates a merge commit, which needs a committer
        // identity — machines without global git config (fresh CI runners,
        // bare containers) would abort the merge without these -c flags.
        const out = await git(
          ["-c", "user.name=Orplex Agent", "-c", "user.email=agent@orplex.local", "merge", "--no-ff", "--no-edit", branch],
          rootDir
        );
        return { merged: true, output: out };
      } catch (err) {
        const msg = (err as Error).message;
        if (/conflict/i.test(msg)) {
          // Leave the conflict markers for the user; abort the merge state so
          // their repo isn't left mid-merge.
          await git(["merge", "--abort"], rootDir).catch(() => {});
          return { merged: false, conflict: "merge conflicts — the agent's branch is kept; resolve manually or re-run" };
        }
        return { merged: false, conflict: msg };
      }
    },
    async diffFiles() {
      try {
        const out = await git(["diff", "--name-only", `${baseBranch}...${branch}`], rootDir);
        return out ? out.split("\n").filter(Boolean) : [];
      } catch {
        return [];
      }
    },
    async patchText() {
      try {
        // Committed work only (the run commits before finishing), so the
        // three-dot diff is complete — including new files.
        const out = await git(["diff", `${baseBranch}...${branch}`], rootDir);
        return out.slice(0, 400_000);
      } catch {
        return "";
      }
    },
    async pushBranch() {
      try {
        const hasRemote = await git(["remote", "get-url", "origin"], worktreeDir);
        if (!hasRemote) return { pushed: false, error: "no origin remote" };
        await git(["push", "-u", "origin", branch], worktreeDir, 60_000);
        return { pushed: true, ref: `origin/${branch}` };
      } catch (err) {
        return { pushed: false, error: (err as Error).message };
      }
    },
    async prLink() {
      try {
        const remoteUrl = await git(["remote", "get-url", "origin"], worktreeDir).catch(() => "");
        const slug = remoteUrl ? originRepoSlug(remoteUrl) : null;
        if (!slug) return { via: "none" };

        // Prefer a real PR when the GitHub CLI is on PATH; otherwise the
        // compare URL opens the PR-creation form pre-filled with the branch.
        const hasGh = await new Promise<boolean>((resolve) => {
          execFile("gh", ["--version"], { timeout: 5_000, windowsHide: true }, (err) => resolve(!err));
        });
        if (hasGh) {
          const prUrl = await new Promise<string | null>((resolve) => {
            execFile(
              "gh",
              [
                "pr",
                "create",
                "--head",
                branch,
                "--base",
                baseBranch || "main",
                "--title",
                `Orplex agent: ${id.slice(0, 12)}`,
                "--body",
                "Opened by Orplex server executor. Review the run's patch artifact before merging.",
              ],
              { timeout: 60_000, windowsHide: true, cwd: worktreeDir },
              (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
            );
          });
          if (prUrl) return { via: "gh", url: prUrl };
        }
        return { via: "compare-url", url: compareUrl(slug, baseBranch || "main", branch) };
      } catch {
        return { via: "none" };
      }
    },
    cleanup,
  };
}
