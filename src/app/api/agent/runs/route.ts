import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sweepStaleRuns } from "@/lib/agent/runtime";
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

  // Self-heal: runs orphaned by a crashed tab (never received a terminal
  // checkpoint) are older than the staleness window in an active status.
  // The board + active badge poll this endpoint, so a sweep happens on read.
  await sweepStaleRuns(session.user.id).catch(() => {});

  // parseInt can yield NaN (→ fallback) or negatives (→ Prisma throw).
  // Clamp to [1, 50] so a hostile ?limit= never 500s the board poll.
  const rawLimit = parseInt(request.nextUrl.searchParams.get("limit") || "20", 10);
  const limit = Math.min(50, Number.isFinite(rawLimit) ? Math.max(1, rawLimit) : 20);
  // Debug seam for BYOK: ?model=... previews the resolved model, never the key.
  const modelOverride = request.nextUrl.searchParams.get("model");
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
      // Queue + resilience metadata for the board (morning-queue scheduling,
      // lease priority, per-run model override, restart requeue count).
      priority: true,
      notBefore: true,
      modelOverride: true,
      retries: true,
      // Mission grouping: children carry the parent id + shared label so the
      // board can swimlane a mission's runs together.
      parentRunId: true,
      missionLabel: true,
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
          artifacts: {
            select: { id: true, kind: true, name: true },
            orderBy: { createdAt: "asc" },
          },
        },
      },
      approvals: {
        where: { status: "pending" },
        select: { id: true, action: true, createdAt: true },
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
      priority: run.priority,
      notBefore: run.notBefore?.toISOString() ?? null,
      modelOverride: run.modelOverride,
      retries: run.retries,
      estimatedCostUsd,
      estimatedCostLabel: formatCost(estimatedCostUsd),
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      isActive: ACTIVE_RUN_STATUSES.includes(run.status),
      artifactCount: run._count.artifacts,
      pendingApprovalCount: run.approvals.length,
      // Full pending approvals for the board's inline approve/deny actions.
      pendingApprovals: run.approvals.map((a) => ({
        id: a.id,
        action: a.action,
        createdAt: a.createdAt.toISOString(),
      })),
      tasks: run.tasks.map((t) => ({
        id: t.id,
        role: t.role,
        title: t.title,
        status: t.status,
        isLeased: t.status === "running" && t.leaseOwner !== null,
        error: t.error,
        dependsOn: t.dependencies.map((d) => d.dependsOnId),
        artifacts: t.artifacts,
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

/**
 * POST /api/agent/runs — Create a new agent run (spawn an agent)
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { prompt, mode = "code", autonomyPolicy = "approval", executionTarget = "server" } = body;

  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    return NextResponse.json({ success: false, error: "prompt is required" }, { status: 400 });
  }

  // BYOK per-task model + morning-queue scheduling on the single-spawn path.
  // All enums validated: raw strings here would persist garbage the claim
  // loop and executor never expect (fail-closed to known values).
  const modelOverride =
    typeof body.modelOverride === "string" && body.modelOverride.trim()
      ? body.modelOverride.trim().slice(0, 120)
      : null;
  const sanePriority = Number.isInteger(body.priority) ? (body.priority as number) : 0;
  const priority = Math.min(100, Math.max(-100, sanePriority));
  const safeTarget = ["server", "client", "local", "none"].includes(executionTarget) ? executionTarget : "server";
  const safePolicy = autonomyPolicy === "auto" ? "auto" : "approval";
  const safeMode = ["ask", "plan", "code"].includes(mode) ? mode : "code";
  const notBefore =
    typeof body.notBefore === "string" && !Number.isNaN(Date.parse(body.notBefore))
      ? new Date(body.notBefore)
      : null;

  try {
    const run = await prisma.agentRun.create({
      data: {
        userId: session.user.id,
        prompt: prompt.trim().slice(0, 20_000),
        status: "pending",
        workspace: ".",
        executionTarget: safeTarget,
        autonomyPolicy: safePolicy,
        ...(modelOverride ? { modelOverride } : {}),
        ...(priority !== 0 ? { priority } : {}),
        ...(notBefore ? { notBefore } : {}),
        idempotencyKey: `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    });

    // Create a spawn event
    await prisma.runEvent.create({
      data: {
        runId: run.id,
        sequence: 0,
        type: "spawned",
        payload: {
          prompt: prompt.trim().slice(0, 20_000),
          mode: safeMode,
          ...(modelOverride ? { model: modelOverride } : {}),
          ...(notBefore ? { scheduledFor: notBefore.toISOString() } : {}),
        },
      },
    });

    return NextResponse.json({ success: true, run });
  } catch (error) {
    // Generic 500: Prisma internals must not reach the client.
    console.error("[runs POST]", error instanceof Error ? error.message : error);
    return NextResponse.json({ success: false, error: "Failed to create run" }, { status: 500 });
  }
}
