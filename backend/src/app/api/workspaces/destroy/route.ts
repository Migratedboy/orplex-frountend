import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { destroyWorkspace } from "@/lib/parallel-workspaces";

export const dynamic = "force-dynamic";

/**
 * POST /api/workspaces/destroy — Destroy a workspace and clean up
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
  const { workspaceId } = body;

  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "workspaceId is required" },
      { status: 400 }
    );
  }

  try {
    const success = await destroyWorkspace(workspaceId);
    return NextResponse.json({ success });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
