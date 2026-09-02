import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { estimateCostFromTotal, formatCost } from "@/lib/cost-estimator";

export const dynamic = "force-dynamic";

// Statuses that count as "in progress" for the board's active-run badge
export const ACTIVE_RUN_STATUSES = [
  "pending", "planning", "executing", "verifying", "waiting_approval",
];

/**
 * GET /api/agent/runs?limit=20&status=active
 *
 * Board feed for the Manager view: one entry per run with its tasks
 * (status + role only — no artifact bodies, keeps the payload small),
 * pending-approval count, and an estimated cost from token usage.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") || "20", 10) || 20, 50);
  const statusFilter = request.nextUrl.searchParams.get("status");

  const where: Record<string, unknown> = { userId: session.user.id };
  if (statusFilter === "active") {
    where.status = { in: ACTIVE_RUN_STATUSES };
  }

  const runs = await prisma.agentRun.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      prompt: true,
      status: true,
      autonomyPolicy: true,
      executionTarget: true,
      tokenUsage: true,
      createdAt: true,
      completedAt: true,
      tasks: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          role: true,
          title: true,
          status: true,
          leaseOwner: true,
          error: true,
          dependencies: { select: { dependsOnId: true } },
        },
      },
      approvals: {
        where: { status: "pending" },
        select: { id: true, action: true },
      },
      _count: { select: { artifacts: true } },
    },
  });

  const boardRuns = runs.map((run) => {
    const estimatedCostUsd = estimateCostFromTotal(run.tokenUsage);
    return {
      id: run.id,
      prompt: run.prompt,
      status: run.status,
      autonomyPolicy: run.autonomyPolicy,
      executionTarget: run.executionTarget,
      tokenUsage: run.tokenUsage,
      estimatedCostUsd,
      estimatedCostLabel: formatCost(estimatedCostUsd),
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      isActive: ACTIVE_RUN_STATUSES.includes(run.status),
      artifactCount: run._count.artifacts,
      pendingApprovalCount: run.approvals.length,
      tasks: run.tasks.map((t) => ({
        id: t.id,
        role: t.role,
        title: t.title,
        status: t.status,
        isLeased: t.status === "running" && t.leaseOwner !== null,
        error: t.error,
        dependsOn: t.dependencies.map((d) => d.dependsOnId),
      })),
    };
  });

  const activeCount = boardRuns.filter(r => r.isActive).length;
  const pendingApprovals = boardRuns.reduce((sum, r) => sum + r.pendingApprovalCount, 0);

  return NextResponse.json({
    success: true,
    runs: boardRuns,
    summary: { total: boardRuns.length, active: activeCount, pendingApprovals },
  });
}
