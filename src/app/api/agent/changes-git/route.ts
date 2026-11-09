// changes-git — GET /api/agent/changes-git?scope=unc|all | ?path=<relfile>
//
// Git working-tree shape for the Changes tab (Right Panel v2, P3; DECISIONS
// D8). Runs git on the user's disk, so it is LOCAL_ONLY (proxy.ts) — the
// cloud backend could never see the local worktree.
//
// response: { success, isGitRepo, branch, scope, rows: [{path,status,added,
// deleted}], totals, truncated } — or for ?path= : { success, diff, isNew }.
// Non-git folders return isGitRepo:false and the client falls back to the
// durable history list.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { execFile } from "node:child_process";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { getWorkspaceCwd } from "@/lib/workspace-cwd";
import { isGitRepo } from "@/lib/checkpoints";
import { parsePorcelain, parseNumstat, mergeCounts, totalsOf } from "@/lib/git-changes";
import { safeJoinWorkspace } from "@/lib/workspace-history";
import { publicErrorMessage } from "@/lib/errors";
import { readFile } from "node:fs/promises";

export const dynamic = "force-dynamic";

const GIT_TIMEOUT_MS = 20_000;
const MAX_ROWS = 500;
const MAX_DIFF_CHARS = 200_000;

function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, out: String((err as NodeJS.ErrnoException).code ?? "error") });
      resolve({ ok: true, out: stdout.toString() });
    });
  });
}

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const root = getWorkspaceCwd(session.user.id);
  if (!root) return NextResponse.json({ success: false, error: "no workspace" }, { status: 400 });

  try {
    if (!(await isGitRepo(root))) {
      return NextResponse.json({ success: true, isGitRepo: false, rows: [], totals: { added: 0, deleted: 0 } });
    }

    const params = request.nextUrl.searchParams;
    const pathParam = params.get("path");

    // Single-file diff for the expanded row.
    if (pathParam) {
      const abs = safeJoinWorkspace(root, pathParam);
      if (!abs) return NextResponse.json({ success: false, error: "path escapes workspace" }, { status: 403 });
      const rel = pathParam.replace(/\\/g, "/").replace(/^\.\//, "");
      const diffRes = await git(["diff", "HEAD", "--", rel], root);
      let diff = diffRes.ok ? diffRes.out : "";
      let isNew = false;
      if (!diffRes.ok) diff = "";
      if (!diff) {
        // Untracked / newly added — synthesize the added-file diff from disk.
        const status = await git(["status", "--porcelain=v1", "-z", "--", rel], root);
        if (status.ok && status.out.includes("??")) {
          isNew = true;
          try {
            const content = await readFile(abs, "utf8");
            diff = content
              .split("\n")
              .map((l) => `+${l}`)
              .join("\n");
          } catch {
            diff = "";
          }
        } else if (diffRes.ok && diffRes.out) {
          diff = diffRes.out;
        }
      }
      if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + "\n… (truncated)";
      return NextResponse.json({ success: true, diff, isNew });
    }

    const scope = params.get("scope") === "all" ? "all" : "unc";
    const branchRes = await git(["branch", "--show-current"], root);
    const branch = branchRes.ok ? branchRes.out.trim() || null : null;

    const statusRes = await git(["status", "--porcelain=v1", "-z"], root);
    const rows = parsePorcelain(statusRes.ok ? statusRes.out : "", true);

    const numstatRes = await git(["diff", "--numstat", "-z", "HEAD"], root);
    const counts = parseNumstat(numstatRes.ok ? numstatRes.out : "", true);

    let merged = mergeCounts(rows, counts);

    // scope=all: add committed-on-branch counts since the merge-base.
    let committedEmpty = true;
    if (scope === "all") {
      const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root);
      let base = "";
      if (upstream.ok) {
        const mb = await git(["merge-base", "HEAD", "@{u}"], root);
        if (mb.ok) base = mb.out.trim();
      }
      if (!base) {
        // No upstream configured — fall back to the remote default branch if
        // any, else the scope is honest-degraded to uncommitted-only.
        const remoteHead = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], root);
        if (remoteHead.ok) {
          const mb = await git(["merge-base", "HEAD", remoteHead.out.trim()], root);
          if (mb.ok) base = mb.out.trim();
        }
      }
      if (base) {
        const committed = await git(["diff", "--numstat", "-z", base, "HEAD"], root);
        if (committed.ok && committed.out.trim()) {
          const extra = parseNumstat(committed.out, true);
          for (const [p, c] of extra) {
            const existing = merged.find((r) => r.path === p);
            if (existing) {
              existing.added += c.added;
              existing.deleted += c.deleted;
            } else {
              merged.push({ path: p, status: "modified", added: c.added, deleted: c.deleted });
            }
          }
          committedEmpty = false;
        }
      }
    }

    const truncated = merged.length > MAX_ROWS;
    if (truncated) merged = merged.slice(0, MAX_ROWS);
    return NextResponse.json({
      success: true,
      isGitRepo: true,
      branch,
      scope,
      committedEmpty: scope === "all" ? committedEmpty : undefined,
      rows: merged,
      totals: totalsOf(merged),
      truncated,
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: publicErrorMessage(err, "Git changes failed") }, { status: 500 });
  }
}
