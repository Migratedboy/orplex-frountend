import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { getRecentTaskMeters } from "@/lib/prompt-meter";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/context-budget — per-task token accounting for the Settings
 * → Provider & Cost dashboard. Reads the renderer-side prompt-meter history
 * (per-call system vs context token split, profile actually sent, and the
 * counterfactual full-profile cost). Read-only; no secrets.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const raw = request.nextUrl.searchParams.get("limit");
  const limit = Math.min(20, Math.max(1, Number(raw) || 10));
  const meters = getRecentTaskMeters(limit);
  return NextResponse.json({
    success: true,
    meters,
  });
}
