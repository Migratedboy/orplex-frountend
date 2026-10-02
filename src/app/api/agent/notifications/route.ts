import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/notifications?limit=20
 *
 * Returns recent run events as notifications for the inbox.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") || "20", 10) || 20, 50);

  // Get recent run events for this user's runs
  const events = await prisma.runEvent.findMany({
    where: {
      run: { userId: session.user.id },
      type: { in: ["completed", "failed", "approval_needed", "artifact_created"] },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      runId: true,
      type: true,
      payload: true,
      createdAt: true,
    },
  });

  const notifications = events.map((event) => {
    const payload = event.payload as Record<string, unknown>;
    let message = "";
    let notifType = "artifact";

    switch (event.type) {
      case "completed":
        message = `Agent completed: ${(payload.prompt as string)?.slice(0, 60) || "task"}`;
        notifType = "completed";
        break;
      case "failed":
        message = `Agent failed: ${(payload.error as string)?.slice(0, 60) || "unknown error"}`;
        notifType = "failed";
        break;
      case "approval_needed":
        message = `Agent needs approval: ${(payload.action as string)?.slice(0, 60) || "action"}`;
        notifType = "approval";
        break;
      case "artifact_created":
        message = `New artifact: ${(payload.name as string) || "artifact"}`;
        notifType = "artifact";
        break;
      default:
        message = event.type;
    }

    return {
      id: event.id,
      runId: event.runId,
      type: notifType,
      message,
      createdAt: event.createdAt.toISOString(),
      read: false, // TODO: track read state in DB
    };
  });

  return NextResponse.json({ success: true, notifications });
}
