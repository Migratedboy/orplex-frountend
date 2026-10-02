import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prepareMerge, applyMerge } from "@/lib/parallel-workspaces";

export const dynamic = "force-dynamic";

/**
 * POST /api/workspaces/merge — Preview or apply workspace merge
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
  const { workspaceId, apply = false, files } = body;

  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "workspaceId is required" },
      { status: 400 }
    );
  }

  try {
    if (apply) {
      const result = await applyMerge(workspaceId, files);
      return NextResponse.json(result);
    } else {
      const result = await prepareMerge(workspaceId);
      return NextResponse.json(result);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
