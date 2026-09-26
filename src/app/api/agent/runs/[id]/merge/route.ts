import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { mergeOrDiscardRun } from "@/lib/server-executor/review";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/agent/runs/[id]/merge — Merge (or discard) the agent's branch
 * after reviewing its diff. Body: { action: "merge" | "discard" }
 *
 * Delegates to mergeOrDiscardRun (shared with the MCP gateway's merge_run
 * tool) so both surfaces get identical guardrails: dirty-tree refusal,
 * clean conflict abort, temp-dir-scoped worktree cleanup.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const action = body?.action === "discard" ? "discard" : "merge";
  const outcome = await mergeOrDiscardRun(session.user.id, id, action);
  if (!outcome.ok) {
    return NextResponse.json({ success: false, error: outcome.error, output: outcome.output }, { status: outcome.status });
  }
  return NextResponse.json({ success: true, ...outcome });
}
