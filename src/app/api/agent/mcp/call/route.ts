// POST /api/agent/mcp/call — one tools/call through the Phase 4 hub
// (server-side OAuth tokens in McpConnection, SSRF-guarded endpoint, retry
// semantics). The renderer's mcp__ dispatch lands here in the default sdk
// lane; the C6 risk/approval gate runs BEFORE this call in the caller.
//
// Responses: { success: true, text, isError } on completion; hub failures
// map honestly to { success: false, code, error, retryAt? } with 401
// (needs_reauth), 503 (cooldown), or 502 (connect/call failures).

import { NextRequest, NextResponse } from "next/server";
import { getMcpSession } from "@/lib/mcp-auth";
import { hubCallTool, McpHubError } from "@/lib/mcp/hub";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await getMcpSession();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { serverId?: unknown; tool?: unknown; args?: unknown };
  const serverId = typeof body.serverId === "string" ? body.serverId.trim() : "";
  const tool = typeof body.tool === "string" ? body.tool.trim() : "";
  const args =
    body.args && typeof body.args === "object" && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {};
  if (!serverId || serverId.length > 200 || !tool || tool.length > 200) {
    return NextResponse.json({ success: false, error: "serverId and tool are required (max 200 chars)" }, { status: 400 });
  }
  try {
    const result = await hubCallTool(session.user.id, serverId, tool, args);
    return NextResponse.json({ success: true, text: result.text, isError: result.isError });
  } catch (e) {
    if (e instanceof McpHubError) {
      const status = e.code === "needs_reauth" ? 401 : e.code === "cooldown" ? 503 : 502;
      return NextResponse.json(
        { success: false, code: e.code, error: e.message, ...(e.retryAt ? { retryAt: e.retryAt } : {}) },
        { status }
      );
    }
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
