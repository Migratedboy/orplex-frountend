// PATCH /api/mcp/connections/[serverId] — per-connector UI settings.
// { autoApproveReadOnly: boolean } is the C6 SDK-lane twin of the browser
// lane's orplex.mcp.prefs.v1 toggle (store.ts → McpConnection column).
//
// DELETE — disconnect: tokens + client registration are wiped in place, the
// row and its auto-approve preference survive for the next connect.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { disconnectConnection, setConnectionAutoApprove } from "@/lib/mcp/oauth/store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ serverId: string }> };

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const { serverId } = await params;
  const body = (await request.json().catch(() => ({}))) as { autoApproveReadOnly?: unknown };
  if (typeof body.autoApproveReadOnly !== "boolean") {
    return NextResponse.json({ success: false, error: "autoApproveReadOnly must be a boolean" }, { status: 400 });
  }
  try {
    const updated = await setConnectionAutoApprove(session.user.id, serverId, body.autoApproveReadOnly);
    if (!updated) {
      return NextResponse.json({ success: false, error: "not connected" }, { status: 404 });
    }
    return NextResponse.json({ success: true, autoApproveReadOnly: body.autoApproveReadOnly });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const { serverId } = await params;
  try {
    const existed = await disconnectConnection(session.user.id, serverId);
    return NextResponse.json({ success: true, existed });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
