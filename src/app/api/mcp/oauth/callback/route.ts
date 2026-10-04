// GET /api/mcp/oauth/callback — hosted (browser) leg of the OAuth callback.
//
// The authorization server redirects the user's browser HERE with
// ?code&state&iss (or ?error…). This request carries the app's session
// cookie, so the exchange runs entirely server-side: claim the one-time
// state, exchange via the SDK, and answer with a small branded page telling
// the user to return to the app. Desktop uses the 127.0.0.1 loopback + POST
// /api/mcp/oauth/complete instead (see electron/mcp-bridge.ts).

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { completeAuthorization } from "@/lib/mcp/oauth/flow";

export const dynamic = "force-dynamic";

const PAGE = (title: string, detail: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title} · Orplex</title>` +
  `<body style="font-family:system-ui;background:#141414;color:#eee;display:grid;place-items:center;height:100vh;margin:0">` +
  `<div style="text-align:center;max-width:28rem;padding:1.5rem">` +
  `<h1 style="color:#ff6b00;font-size:1.4rem;margin:0 0 .5rem">${title}</h1>` +
  `<p style="color:#9aa;line-height:1.5;margin:0">${detail}</p>` +
  `</div></body></html>`;

function html(title: string, detail: string, status: number): NextResponse {
  return new NextResponse(PAGE(title, detail), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return html("Sign in required", "Open Orplex and sign in, then start the connection again.", 401);
  }
  const state = request.nextUrl.searchParams.get("state");
  if (!state) {
    return html("Sign-in link incomplete", "The authorization server did not return a state parameter. Return to the app and try again.", 400);
  }

  try {
    const result = await completeAuthorization({
      userId: session.user.id,
      state,
      params: request.nextUrl.searchParams, // whole query: finishAuth wants code + iss (+ nothing else)
    });
    if (result.status === "connected") {
      return html("&#10003; Connector connected", "You can close this tab and return to the Orplex app.", 200);
    }
    return html("Connection failed", `${result.error} Return to the app and try again.`, 400);
  } catch (e) {
    return html("Connection failed", `${e instanceof Error ? e.message : String(e)} Return to the app and try again.`, 500);
  }
}
