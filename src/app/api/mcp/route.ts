import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { timingSafeTokenCompare, resolveLocalUser } from "@/lib/mcp-gateway";
import { mergeOrDiscardRun } from "@/lib/server-executor/review";

export const dynamic = "force-dynamic";

/**
 * POST /api/mcp — Token-gated MCP gateway for the local stdio proxy
 * (scripts/orplex-mcp-server.mjs).
 *
 * Auth: `Authorization: Bearer $ORPLEX_MCP_TOKEN` — timing-safe comparison
 * against the ORPLEX_MCP_TOKEN env var; the run is always attributed to
 * the resolved local user, never to client-supplied user ids.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const expected = process.env.ORPLEX_MCP_TOKEN || "";
  if (!expected || !token || !timingSafeTokenCompare(token, expected)) {
    return NextResponse.json({ success: false, error: "ORPLEX_MCP_TOKEN not configured or invalid" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const tool = typeof body?.tool === "string" ? body.tool : "";

  try {
    switch (tool) {
      case "spawn_run": {
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) return NextResponse.json({ success: false, error: "prompt required" }, { status: 400 });
        const userId = await resolveLocalUser();
        if (!userId) return NextResponse.json({ success: false, error: "no user exists — sign in once in the app first" }, { status: 400 });
        const run = await prisma.agentRun.create({
          data: {
            userId,
            prompt: prompt.slice(0, 20_000),
            status: "pending",
            workspace: ".",
            executionTarget: "server",
            autonomyPolicy: body.autonomyPolicy === "auto" ? "auto" : "approval",
            idempotencyKey: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          },
        });
        await prisma.runEvent.create({
          data: { runId: run.id, sequence: 0, type: "spawned", payload: { prompt: prompt.slice(0, 500), via: "mcp" } },
        }).catch(() => {});
        return NextResponse.json({ success: true, runId: run.id });
      }

      case "list_runs": {
        const userId = await resolveLocalUser();
        if (!userId) return NextResponse.json({ success: true, runs: [] });
        const runs = await prisma.agentRun.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: Math.min(Math.max(Number(body.limit) || 10, 1), 25),
          select: { id: true, prompt: true, status: true, priority: true, notBefore: true, createdAt: true, result: true },
        });
        return NextResponse.json({ success: true, runs });
      }

      case "get_run_review": {
        const userId = await resolveLocalUser();
        const id = typeof body.runId === "string" ? body.runId : "";
        const run = id && userId
          ? await prisma.agentRun.findFirst({
              where: { id, userId },
              select: { id: true, prompt: true, status: true, result: true, createdAt: true, completedAt: true },
            })
          : null;
        if (!run) return NextResponse.json({ success: false, error: "run not found" }, { status: 404 });
        const [events, patch] = await Promise.all([
          prisma.runEvent.findMany({ where: { runId: run.id }, orderBy: { sequence: "asc" }, select: { sequence: true, type: true, payload: true } }),
          prisma.agentArtifact.findFirst({ where: { runId: run.id, kind: "patch" }, select: { content: true } }),
        ]);
        return NextResponse.json({
          success: true,
          run,
          events: events.slice(-40),
          patch: patch?.content?.slice(0, 100_000) ?? null,
        });
      }

      case "merge_run": {
        const userId = await resolveLocalUser();
        if (!userId) return NextResponse.json({ success: false, error: "no user exists — sign in once in the app first" }, { status: 400 });
        const id = typeof body.runId === "string" ? body.runId : "";
        const action = body.action === "discard" ? "discard" : "merge";
        if (!id) return NextResponse.json({ success: false, error: "runId required" }, { status: 400 });
        const outcome = await mergeOrDiscardRun(userId, id, action);
        return NextResponse.json({ success: outcome.ok, ...outcome }, { status: outcome.status });
      }

      default:
        return NextResponse.json({ success: false, error: `unknown tool "${tool.slice(0, 40)}"` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message.slice(0, 400) }, { status: 500 });
  }
}
