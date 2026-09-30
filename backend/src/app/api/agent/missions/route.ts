import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/missions — spawn a mission: one parent run plus N child
 * runs queued for the executor. Children carry parentRunId + missionLabel so
 * the run board can group them. Children inherit the parent's prompt context
 * with their subtask prepended.
 *
 * Body: { prompt, subtasks: string[], workspace?, modelOverride?, priority? }
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const prompt = String(body?.prompt ?? "").trim();
  const subtasks: string[] = Array.isArray(body?.subtasks)
    ? body.subtasks.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 8)
    : [];

  if (!prompt || subtasks.length === 0) {
    return NextResponse.json({ success: false, error: "prompt and at least one subtask required" }, { status: 400 });
  }

  try {
    const missionLabel = (String(body?.label ?? "").trim() || `Mission ${new Date().toISOString().slice(0, 16)}`).slice(0, 120);
    const parent = await prisma.agentRun.create({
      data: {
        userId: session.user.id,
        prompt: prompt.slice(0, 100_000),
        status: "mission",
        workspace: String(body?.workspace ?? process.cwd()).slice(0, 2000),
        executionTarget: "none",
        missionLabel,
      },
    });

    const children = [];
    for (const [i, sub] of subtasks.entries()) {
      const child = await prisma.agentRun.create({
        data: {
          userId: session.user.id,
          prompt: `[Mission: ${missionLabel}] Subtask ${i + 1}/${subtasks.length}: ${sub}\n\nOverall goal: ${prompt.slice(0, 2000)}`,
          status: "pending",
          workspace: String(body?.workspace ?? process.cwd()).slice(0, 2000),
          executionTarget: "server",
          priority: Number.isFinite(body?.priority) ? Math.max(0, Math.min(10, Number(body.priority))) : 0,
          modelOverride: typeof body?.modelOverride === "string" ? body.modelOverride : null,
          parentRunId: parent.id,
          missionLabel,
        },
      });
      children.push(child);
    }

    return NextResponse.json({
      success: true,
      mission: { id: parent.id, label: missionLabel, children: children.length },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to create mission" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/agent/missions — recent missions with their children grouped.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  try {
    const parents = await prisma.agentRun.findMany({
      where: { userId: session.user.id, status: "mission" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, prompt: true, missionLabel: true, createdAt: true },
    });
    const missions = [];
    for (const p of parents) {
      const children = await prisma.agentRun.findMany({
        where: { parentRunId: p.id },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, prompt: true, result: true, completedAt: true },
      });
      missions.push({
        id: p.id,
        label: p.missionLabel,
        createdAt: p.createdAt,
        children: children.map((c) => ({
          id: c.id,
          status: c.status,
          summary: (c.result as { summary?: string } | null)?.summary?.slice(0, 200) ?? null,
          completedAt: c.completedAt,
        })),
        done: children.filter((c) => c.status === "completed").length,
        total: children.length,
      });
    }
    return NextResponse.json({ success: true, missions });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to list missions" },
      { status: 500 },
    );
  }
}
