// POST /api/mcp/remote-servers — register a USER-ADDED remote MCP server
// (OAuth) that is not in the catalog ("Remote servers (OAuth)" → "Connect
// with browser"). Registration only creates an McpConnection row with status
// "disconnected" and no tokens; the panel then runs the standard connect
// flow for the returned serverId (POST /api/mcp/connections/:id/connect →
// browser OAuth → /api/mcp/oauth/complete), and the hub dispatches its
// tools like any catalog connector.
//
// DELETE /api/mcp/remote-servers?serverId=remote-… — remove the registration
// row AND its tool snapshot entirely (unlike catalog disconnects, which keep
// the row for re-connect).

import { NextRequest, NextResponse } from "next/server";
import { getMcpSession } from "@/lib/mcp-auth";
import { deleteCustomRemote, upsertCustomRemote } from "@/lib/mcp/custom-remote";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await getMcpSession();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { url?: unknown; transport?: unknown } | null;
  if (!body || typeof body.url !== "string" || body.url.trim() === "") {
    return NextResponse.json({ success: false, error: "url is required" }, { status: 400 });
  }
  try {
    const { serverId, entry } = await upsertCustomRemote(session.user.id, {
      url: body.url,
      transport: typeof body.transport === "string" ? body.transport : undefined,
    });
    return NextResponse.json({ success: true, serverId, name: entry.name });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const session = await getMcpSession();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const serverId = request.nextUrl.searchParams.get("serverId") ?? "";
  try {
    const removed = await deleteCustomRemote(session.user.id, serverId);
    if (!removed) {
      return NextResponse.json({ success: false, error: "not a registered custom remote" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
