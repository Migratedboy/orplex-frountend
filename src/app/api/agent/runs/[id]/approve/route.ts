import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/agent/runs/[id]/approve — Decide a pending approval for a
 * server-executed run. Body: { requestId, action: "approve" | "reject" }
 *
 * Server runs gate risky actions through the ApprovalRequest table (not the
 * browser in-memory store), so the Manager can render and decide them from
 * anywhere — the paused executor loop picks up the decision on its next poll.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const { requestId, action } = body ?? {};
  if (typeof requestId !== "string" || !["approve", "reject"].includes(action)) {
    return NextResponse.json({ success: false, error: "requestId and action (approve|reject) required" }, { status: 400 });
  }

  // Ownership: the approval must belong to a run owned by this user.
  const approval = await prisma.approvalRequest.findFirst({
    where: { id: requestId, runId: id, run: { userId: session.user.id } },
    select: { id: true, status: true },
  });
  if (!approval) {
    return NextResponse.json({ success: false, error: "Approval request not found" }, { status: 404 });
  }
  if (approval.status !== "pending") {
    return NextResponse.json({ success: false, error: `Already ${approval.status}` }, { status: 409 });
  }

  const updated = await prisma.approvalRequest.update({
    where: { id: approval.id },
    data: {
      status: action === "approve" ? "approved" : "rejected",
      decidedBy: session.user.id,
      decidedAt: new Date(),
    },
    select: { id: true, status: true },
  });

  return NextResponse.json({ success: true, approval: updated });
}
