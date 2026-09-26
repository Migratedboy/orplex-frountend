import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isServerExecutorRunning } from "@/lib/server-executor/executor";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/runs/claim — Atomically claim one pending Manager-spawned
 * run for execution.
 *
 * The executor is the browser tab running the queue-runner (see
 * lib/queue-runner.ts): it polls this endpoint when idle, and the CAS below
 * guarantees two open tabs can never both claim the same run. Only runs
 * spawned by the Manager (executionTarget "server") are claimable — runs
 * mirrored from live chat tasks (executionTarget "client") are owned by the
 * tab that created them.
 */
export async function POST(_request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const userId = session.user.id;

  // Arbitration: when the persistent server executor is running in this
  // process, it owns server-target runs — the client claimer stays idle so
  // the two executors never compete for the same run.
  if (isServerExecutorRunning()) {
    return NextResponse.json({ success: true, run: null });
  }

  // Pick the oldest claimable candidate, then try to CAS it. If another tab
  // wins the race, try the next candidate (bounded attempts).
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = await prisma.agentRun.findFirst({
      where: {
        userId,
        status: "pending",
        executionTarget: "server",
        // Same scheduling gate as the server executor's lease loop.
        OR: [{ notBefore: null }, { notBefore: { lte: new Date() } }],
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      select: { id: true, prompt: true, autonomyPolicy: true },
    });
    if (!candidate) break;

    const claimed = await prisma.agentRun.updateMany({
      where: {
        id: candidate.id,
        status: "pending",
        OR: [{ notBefore: null }, { notBefore: { lte: new Date() } }],
      },
      data: { status: "executing" },
    });
    if (claimed.count === 0) continue; // lost the race — next candidate

    // Spawn event carried the requested mode; recover it for the executor.
    const spawnEvent = await prisma.runEvent.findFirst({
      where: { runId: candidate.id, type: "spawned" },
      orderBy: { sequence: "asc" },
      select: { payload: true, sequence: true },
    });
    const mode =
      spawnEvent?.payload && typeof spawnEvent.payload === "object" && "mode" in spawnEvent.payload
        ? String((spawnEvent.payload as { mode?: unknown }).mode || "code")
        : "code";

    // Lifecycle event: sequence after whatever exists (spawn used 0).
    const latest = await prisma.runEvent.findFirst({
      where: { runId: candidate.id },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    await prisma.runEvent
      .create({
        data: {
          runId: candidate.id,
          sequence: (latest?.sequence ?? -1) + 1,
          type: "claimed",
          payload: { claimedBy: "client-queue-runner" },
        },
      })
      .catch(() => {});

    return NextResponse.json({
      success: true,
      run: {
        id: candidate.id,
        prompt: candidate.prompt,
        mode,
        autonomyPolicy: candidate.autonomyPolicy,
      },
    });
  }

  return NextResponse.json({ success: true, run: null });
}
