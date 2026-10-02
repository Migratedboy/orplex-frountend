import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { listConnectedServers, connectServer, disconnectServer, setServerEnabled } from "@/lib/mcp-accounts";

export const dynamic = "force-dynamic";

/**
 * GET  /api/mcp/servers   — the user's connected connectors (secrets masked)
 * POST /api/mcp/servers   — connect or re-save: { serverId, label?, env?, args?, enabled? }
 * PATCH /api/mcp/servers  — toggle: { serverId, enabled }
 * DELETE /api/mcp/servers?serverId= — disconnect
 */
export async function GET() {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const servers = await listConnectedServers(session.user.id);
  return NextResponse.json({ success: true, servers });
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body.serverId !== "string") {
    return NextResponse.json({ success: false, error: "serverId required" }, { status: 400 });
  }
  const result = await connectServer(session.user.id, body.serverId, {
    label: typeof body.label === "string" ? body.label : undefined,
    env: body.env && typeof body.env === "object" ? (body.env as Record<string, unknown>) : undefined,
    args: Array.isArray(body.args) ? body.args : undefined,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
  });
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ success: true, server: result.server });
}

export async function PATCH(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body.serverId !== "string" || typeof body.enabled !== "boolean") {
    return NextResponse.json({ success: false, error: "serverId and enabled required" }, { status: 400 });
  }
  const ok = await setServerEnabled(session.user.id, body.serverId, body.enabled);
  if (!ok) return NextResponse.json({ success: false, error: "not connected" }, { status: 404 });
  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const serverId = request.nextUrl.searchParams.get("serverId");
  if (!serverId) {
    return NextResponse.json({ success: false, error: "serverId required" }, { status: 400 });
  }
  const ok = await disconnectServer(session.user.id, serverId);
  if (!ok) return NextResponse.json({ success: false, error: "not connected" }, { status: 404 });
  return NextResponse.json({ success: true });
}
