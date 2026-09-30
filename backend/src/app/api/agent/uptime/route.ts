import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { summarizeUptime, type UptimeEvent } from "@/lib/spend-format";

export const dynamic = "force-dynamic";

/** Reliability window shown in Settings → Provider & Cost (days). */
const UPTIME_WINDOW_DAYS = 7;

/**
 * GET /api/agent/uptime — provider reliability telemetry for the Settings →
 * Provider & Cost tab. Returns raw attempt events from the last 7 days plus
 * the pure aggregation (per provider/model success rates and error kinds);
 * the heavy shaping lives in summarizeUptime so it stays unit-testable.
 * Rows are capped defensively — a chatty week is thousands of rows, not
 * millions, but a cap keeps the payload honest if that ever changes.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const since = new Date(Date.now() - UPTIME_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.providerEvent.findMany({
    where: { userId: session.user.id, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const events: UptimeEvent[] = rows.map((r) => ({
    lane: r.lane,
    provider: r.provider,
    model: r.model,
    outcome: r.outcome === "error" ? "error" : "ok",
    errorKind: r.errorKind ?? null,
    createdAt: r.createdAt.toISOString(),
  }));

  return NextResponse.json({
    success: true,
    windowDays: UPTIME_WINDOW_DAYS,
    events,
    summary: summarizeUptime(events, UPTIME_WINDOW_DAYS),
  });
}
