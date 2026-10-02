import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { getServerRunConfig, recordTestResult } from "@/lib/mcp-accounts";
import { getMcpServerForRun, shutdownAllMcp } from "@/lib/mcp-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/mcp/test-connection { serverId }
 * Spawns the configured server (or reuses a healthy session), runs a real
 * `initialize`-shaped tools/list probe, records the result, and shuts the
 * probe session down so it never competes with the run-time budget.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const serverId = typeof body?.serverId === "string" ? body.serverId : "";
  if (!serverId) {
    return NextResponse.json({ success: false, error: "serverId required" }, { status: 400 });
  }

  const cfg = await getServerRunConfig(session.user.id, serverId);
  if (!cfg) {
    return NextResponse.json({ success: false, error: "not connected (or disabled)" }, { status: 404 });
  }

  const started = Date.now();
  try {
    const handle = await getMcpServerForRun(serverId, { [serverId]: cfg });
    const tools = await handle.listTools();
    await recordTestResult(session.user.id, serverId, true);
    // Drop the probe session so the run-time 2-server budget stays free.
    await shutdownAllMcp();
    return NextResponse.json({
      success: true,
      ok: true,
      toolCount: tools.length,
      tools: tools.slice(0, 25).map((t) => ({ name: t.name, description: t.description.slice(0, 120) })),
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    const message = (err as Error).message.slice(0, 400);
    await recordTestResult(session.user.id, serverId, false).catch(() => {});
    try {
      await shutdownAllMcp();
    } catch {}
    return NextResponse.json({ success: true, ok: false, error: message, latencyMs: Date.now() - started });
  }
}
