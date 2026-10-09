// POST /api/mcp/connections/[serverId]/connect — start (or re-check) the OAuth
// flow for a REMOTE MCP connector. Session-gated; the redirect target is
// validated up front (hosted callback or RFC 8252 loopback only).
//
// Responses:
//   {status:"awaiting_browser", authUrl, state, expiresAt} — open authUrl in
//     the SYSTEM browser (never a webview), then wait for the callback leg.
//   {status:"connected"} — stored tokens already authorize this server.
//   {status:"error", code, error} — mapped, honest failure (see flow.ts).

import { NextRequest, NextResponse } from "next/server";
import { getMcpSession } from "@/lib/mcp-auth";
import { resolveRedirectUri, startAuthorization } from "@/lib/mcp/oauth/flow";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ serverId: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getMcpSession();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const { serverId } = await params;
  const body = (await request.json().catch(() => ({}))) as { redirectUri?: unknown };
  const requested = typeof body.redirectUri === "string" ? body.redirectUri : undefined;
  const redirectUri = resolveRedirectUri(requested, request.nextUrl.origin);
  if (!redirectUri) {
    return NextResponse.json(
      {
        success: false,
        status: "error",
        code: "bad_redirect",
        error: "redirectUri must be this app's /api/mcp/oauth/callback or a 127.0.0.1/localhost loopback /callback (RFC 8252)",
      },
      { status: 400 }
    );
  }

  try {
    const result = await startAuthorization({ userId: session.user.id, serverId, redirectUri });
    if (result.status === "error") {
      const status = result.code === "no_remote" ? 400 : 502;
      return NextResponse.json({ success: false, ...result }, { status });
    }
    return NextResponse.json({ success: true, ...result }, { status: 200 });
  } catch (e) {
    return NextResponse.json(
      { success: false, status: "error", code: "oauth_failed", error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
