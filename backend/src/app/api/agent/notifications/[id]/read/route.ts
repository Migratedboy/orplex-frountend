import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/notifications/[id]/read — Mark a notification as read
 * (Currently in-memory; TODO: persist read state in DB)
 */
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  // Placeholder — notifications are currently computed from RunEvents
  // Full implementation would track read state in a NotificationRead table
  return NextResponse.json({ success: true });
}
