import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { createWorkspace, listWorkspaces } from "@/lib/parallel-workspaces";

export const dynamic = "force-dynamic";

/**
 * POST /api/workspaces/create — Create an isolated workspace for an agent
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const { rootDir = ".", runId, agentRole } = body;

  try {
    const workspace = await createWorkspace(rootDir, runId, agentRole);

    return NextResponse.json({
      success: true,
      workspace: {
        id: workspace.id,
        workspaceDir: workspace.workspaceDir,
        branchName: workspace.branchName,
        // "copy-fallback" means the git-worktree path FAILED — the UI should
        // flag it, since merge semantics and disk cost differ.
        mode: workspace.mode,
        fallbackReason: workspace.fallbackReason ?? null,
        createdAt: workspace.createdAt.toISOString(),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}

/**
 * GET /api/workspaces/create — List active workspaces
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401 }
    );
  }

  const workspaces = listWorkspaces();

  return NextResponse.json({
    success: true,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      rootDir: w.rootDir,
      workspaceDir: w.workspaceDir,
      branchName: w.branchName,
      mode: w.mode,
      fallbackReason: w.fallbackReason ?? null,
      createdAt: w.createdAt.toISOString(),
      runId: w.runId,
    })),
  });
}
