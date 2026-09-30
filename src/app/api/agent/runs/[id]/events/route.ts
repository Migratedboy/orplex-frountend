import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { getRuntimeEvents } from "@/lib/agent/runtime";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/runs/[id]/events?after=<sequence>
 *
 * Cursor feed for the run timeline: returns every event with sequence
 * greater than `after`, ascending, plus the cursor to pass back on the
 * next poll. The sequence column is the ordering authority (the executor
 * and run-sync both append through the P2002-retried appendRuntimeEvent),
 * so a poller can never miss or double-see an event.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const afterRaw = request.nextUrl.searchParams.get("after");
  // -1 (initial fetch) = include sequence 0 — the executor's `spawned` event
  // lives at sequence 0 and must not be invisible on the timeline.
  const after = Math.max(-1, Number.isNaN(parseInt(afterRaw || "0", 10)) ? -1 : parseInt(afterRaw || "0", 10));

  try {
    const events = await getRuntimeEvents(session.user.id, id, after);

    const cursor = events.length > 0 ? (events[events.length - 1] as Prisma.RunEventGetPayload<object>).sequence : after;

    return NextResponse.json({ success: true, events, cursor });
  } catch {
    // assertRunOwner throws when the run doesn't exist or isn't the caller's
    return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
  }
}
