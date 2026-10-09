// GET /api/agent/mcp — which MCP lane this deployment runs (Phase 8 gate).
//
// The renderer cannot read server env, so the agent loop asks here once per
// session: "sdk" (default) dispatches through the hub over /api/agent/mcp/*,
// "legacy" keeps the pre-Phase-8 localStorage lane runnable (C8).

import { NextResponse } from "next/server";
import { getMcpSession } from "@/lib/mcp-auth";
import { resolveMcpLane } from "@/lib/mcp/gate";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getMcpSession();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ success: true, lane: resolveMcpLane(process.env.ORPLEX_MCP) });
}
