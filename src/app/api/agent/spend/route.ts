import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { describeProviderSelection } from "@/lib/ai-providers";
import { spendAggregates, sortSpendRuns, SpendRun } from "@/lib/spend-format";

export const dynamic = "force-dynamic";

/** How many finished runs feed the chart and aggregates. */
const SPEND_WINDOW = 60;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function asTokenNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * GET /api/agent/spend — per-run token & estimated-cost history for the
 * Settings → Provider & Cost tab.
 *
 * Metering comes from finished runs only (pending/failed runs carry no
 * meaningful usage). No key material is returned — provider info comes from
 * describeProviderSelection, which reports booleans only.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const runs = await prisma.agentRun.findMany({
    where: { userId: session.user.id, status: "completed" },
    orderBy: { createdAt: "desc" },
    take: SPEND_WINDOW,
  });

  const history: SpendRun[] = runs.map((r) => {
    const result = (r.result && typeof r.result === "object" && !Array.isArray(r.result) ? r.result : {}) as Record<string, unknown>;
    const usage = result.tokenUsage && typeof result.tokenUsage === "object" && !Array.isArray(result.tokenUsage) ? (result.tokenUsage as Record<string, unknown>) : null;
    const model = asString(r.modelOverride) || describeProviderSelection().model;
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      totalTokens: r.tokenUsage || 0,
      promptTokens: asTokenNumber(usage?.promptTokens),
      completionTokens: asTokenNumber(usage?.completionTokens),
      provider: asString(result.provider),
      model,
      status: r.status,
    };
  });

  const sorted = sortSpendRuns(history);
  return NextResponse.json({
    success: true,
    history: sorted,
    totals: spendAggregates(sorted),
    provider: describeProviderSelection(),
  });
}
