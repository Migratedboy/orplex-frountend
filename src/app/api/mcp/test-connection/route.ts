import { NextRequest, NextResponse } from "next/server";
import { getMcpSession } from "@/lib/mcp-auth";
import { getServerRunConfig, recordTestResult } from "@/lib/mcp-accounts";
import { getMcpServerForRun } from "@/lib/mcp-client";
import { syncToolSnapshot } from "@/lib/mcp/tool-snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/mcp/test-connection { serverId }
 * Spawns the configured server (or reuses a healthy session), runs a real
 * `initialize`-shaped tools/list probe, records the result, and shuts the
 * probe session down so it never competes with the run-time budget.
 */
export async function POST(request: NextRequest) {
  const session = await getMcpSession();
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
    const handle = await getMcpServerForRun(serverId, { [serverId]: cfg }, session.user.id);
    const tools = await handle.listTools();
    await recordTestResult(session.user.id, serverId, true);
    // Phase 9: this probe already ran a real tools/list — persist it as the
    // Phase 5 roster so prompts/tools counts don't wait for another trigger.
    void syncToolSnapshot(session.user.id, serverId, tools).catch(() => {});
    // Drop ONLY the probe session so the run-time 2-server budget stays
    // free — shutting down everything would kill other users' live run
    // sessions and concurrent probes (a shared live session respawns
    // on next use, so this is safe even when shared).
    const { shutdownAccountSession } = await import("@/lib/mcp-client");
    await shutdownAccountSession(serverId, { [serverId]: cfg }, session.user.id);
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
      const { shutdownAccountSession } = await import("@/lib/mcp-client");
      await shutdownAccountSession(serverId, { [serverId]: cfg }, session.user.id);
    } catch {}
    return NextResponse.json({ success: true, ok: false, error: message, latencyMs: Date.now() - started });
  }
}
