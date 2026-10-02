// review.ts — The ONE implementation of "merge or discard the run's branch".
//
// Used by both POST /api/agent/runs/[id]/merge (human review in the UI) and
// the MCP gateway's merge_run tool (programmatic review). Guardrails live
// here so both surfaces get identical safety: dirty-tree refusal, clean
// conflict abort, temp-dir-scoped cleanup.

import { prisma } from "@/lib/prisma";
import { resolveWorkspaceCwd } from "@/lib/workspace-cwd";
import { gitInRepo } from "@/lib/server-executor/worktree-helpers";

export interface ReviewOutcome {
  ok: boolean;
  status: number;
  action?: "merge" | "discard";
  branch?: string;
  output?: string;
  error?: string;
}

export async function mergeOrDiscardRun(userId: string, runId: string, action: "merge" | "discard"): Promise<ReviewOutcome> {
  const run = await prisma.agentRun.findFirst({
    where: { id: runId, userId },
    select: { id: true, userId: true, result: true, status: true },
  });
  if (!run) return { ok: false, status: 404, error: "Run not found" };

  const result = (run.result ?? {}) as { branch?: string; worktreeDir?: string };
  const branch = typeof result.branch === "string" ? result.branch : null;
  if (!branch) return { ok: false, status: 400, error: "This run has no agent branch to merge" };

  // Safety: only ever delete a directory that is a recorded agent worktree
  // under the OS temp root — never a user-chosen path.
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const worktreeRoot = join(tmpdir(), "orplex-worktrees");
  const recordedDir = typeof result.worktreeDir === "string" ? result.worktreeDir : null;
  const safeWorktreeDir = recordedDir && recordedDir.startsWith(worktreeRoot) ? recordedDir : null;

  // Resolve the repo the SAME way the executor did when it created this
  // run's worktree (executor.ts): the user's registered workspace (durable:
  // session Map → User.workspacePath in the DB), falling back to the Orplex
  // checkout itself. A server restart must not dead-lock review while the
  // run clearly had a repo.
  const workDir = (await resolveWorkspaceCwd(userId)) || process.cwd();

  try {
    if (action === "discard") {
      await gitInRepo(workDir, ["branch", "-D", branch]);
      await gitInRepo(workDir, ["worktree", "prune"]).catch(() => {});
      if (safeWorktreeDir) {
        await import("fs/promises").then((fs) => fs.rm(safeWorktreeDir, { recursive: true, force: true })).catch(() => {});
      }
      return { ok: true, status: 200, action, branch };
    }

    // Merge: refuse on dirty tree, abort cleanly on conflict.
    const dirty = await gitInRepo(workDir, ["status", "--porcelain"]);
    if (dirty) return { ok: false, status: 409, error: "Workspace has uncommitted changes — commit or stash before merging" };

    try {
      const out = await gitInRepo(workDir, ["merge", "--no-ff", "--no-edit", branch]);
      await gitInRepo(workDir, ["branch", "-D", branch]).catch(() => {});
      await gitInRepo(workDir, ["worktree", "prune"]).catch(() => {});
      if (safeWorktreeDir) {
        await import("fs/promises").then((fs) => fs.rm(safeWorktreeDir, { recursive: true, force: true })).catch(() => {});
      }
      return { ok: true, status: 200, action, branch, output: out };
    } catch (err) {
      const msg = (err as Error).message;
      if (/conflict/i.test(msg)) {
        await gitInRepo(workDir, ["merge", "--abort"]).catch(() => {});
        return { ok: false, status: 409, error: "Merge conflicts — merge aborted, agent branch preserved", output: msg.slice(0, 500) };
      }
      throw err;
    }
  } catch (err) {
    return { ok: false, status: 500, error: (err as Error).message.slice(0, 400) };
  }
}
