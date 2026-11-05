// POST /api/mcp/connections/[serverId]/client — store the USER's own
// vendor-registered OAuth client (client id + optional secret) for a remote
// connector whose authorization server has no open dynamic registration
// (render, slack, jira, one-drive, figma, …). Session-gated. Secrets are
// AES-256-GCM encrypted at rest and never returned to the page.
//
// Works for catalog ids AND custom `remote-<hash>` ids: the endpoint URL /
// transport are resolved from the catalog entry, falling back to the
// connection row. The next /connect leg picks the credentials up in
// DbMcpOAuthProvider.clientInformation and skips DCR entirely.

import { NextRequest, NextResponse } from "next/server";
import { getMcpSession } from "@/lib/mcp-auth";
import { setConnectionClientCredentials } from "@/lib/mcp-accounts";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ serverId: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getMcpSession();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const { serverId } = await params;
  const body = (await request.json().catch(() => ({}))) as { clientId?: unknown; clientSecret?: unknown };
  if (typeof body.clientId !== "string" || !body.clientId.trim()) {
    return NextResponse.json(
      { success: false, error: "clientId is required (register one OAuth app with the vendor)" },
      { status: 400 }
    );
  }
  if (body.clientSecret !== undefined && typeof body.clientSecret !== "string") {
    return NextResponse.json({ success: false, error: "clientSecret must be a string" }, { status: 400 });
  }
  try {
    await setConnectionClientCredentials(session.user.id, serverId, body.clientId, body.clientSecret);
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
  return NextResponse.json({ success: true }, { status: 200 });
}
