import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import {
  mintDesktopGrant,
  readDesktopCode,
  checkDesktopFlow,
  DESKTOP_FLOW_COOKIE,
} from "@/lib/desktop-auth";
import { checkRateLimit, clientIp } from "@/lib/rate-limiter";

export const dynamic = "force-dynamic";

function page(body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Orplex Code — signed in</title>` +
      `<body style="font-family:system-ui;background:#141414;color:#eee;display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="text-align:center;max-width:420px">${body}</div></body>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function GET(request: Request) {
  const rl = checkRateLimit(`desktop-finish:${clientIp(request)}`);
  if (!rl.allowed) {
    return page(`<h2 style="color:#ff6b00">Too many sign-in attempts</h2><p style="color:#9aa">Wait a minute and try again.</p>`);
  }
  const code = new URL(request.url).searchParams.get("code") || "";
  const claims = readDesktopCode(code);
  if (!claims) return page(`<h2 style="color:#ff6b00">Link expired</h2><p style="color:#9aa">Return to the app and start sign-in again.</p>`);

  // Login-CSRF defense: only the browser that minted the code (holder of
  // the HttpOnly flow cookie) may complete it. A cross-site lure carries no
  // cookie → same generic "expired" page (never reveal why).
  const cookieHeader = request.headers.get("cookie") || "";
  const flowToken = cookieHeader
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === DESKTOP_FLOW_COOKIE)?.[1];
  let flowOk = false;
  try {
    flowOk = checkDesktopFlow(claims, flowToken ? decodeURIComponent(flowToken) : null);
  } catch {
    flowOk = false;
  }
  if (!flowOk) return page(`<h2 style="color:#ff6b00">Link expired</h2><p style="color:#9aa">Return to the app and start sign-in again.</p>`);

  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user) {
    return page(`<h2 style="color:#ff6b00">Sign-in did not complete</h2><p style="color:#9aa">Return to the app and try again.</p>`);
  }

  // Hand the app an encrypted grant instead of a server-side handle: the
  // exchange call can land on another serverless instance, so no state may
  // be kept between here and there.
  const grant = mintDesktopGrant({
    id: (session.user as { id?: string }).id || session.user.email || "",
    name: session.user.name,
    email: session.user.email,
    image: session.user.image ?? null,
  });

  // Deep link via JS (a 302 to a custom scheme would be blocked by browsers);
  // keep a manual <a> fallback in case the OS has no orplex:// handler.
  const deepLink = `orplex://auth?code=${encodeURIComponent(grant)}`;
  return page(
    `<h2 style="color:#ff6b00">&#10003; Signed in</h2>` +
      `<p style="color:#9aa">Returning to Orplex Code… you can close this tab.</p>` +
      `<p><a href="${deepLink}" style="color:#ff8a3d">Open Orplex Code</a></p>` +
      `<script>setTimeout(() => { window.location.href = ${JSON.stringify(deepLink)}; }, 150);</script>`
  );
}
