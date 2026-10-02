import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/open-external?url=... — Hand a URL to the user's REAL browser.
 *
 * The embedded preview lives in an iframe (or the Electron shell); some pages
 * refuse framing even through the proxy, and some the user simply wants on
 * their main screen. This endpoint validates the URL and answers with a tiny
 * HTML page whose script calls window.open() — the only reliable way to pop
 * the user's default browser (Chrome) from inside a framed document, since
 * frames are usually sandboxed against top-level navigation. The Electron
 * shell intercepts window.open externally (shell.openExternal), so desktop
 * users get Chrome; plain-browser users get a new tab in Chrome.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get("url") || "";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  // Real browser can open anything a user could type — but never another
  // app-internal route (that would be a weird redirect primitive).
  if (!/^https?:$/.test(target.protocol)) {
    return NextResponse.json({ error: "Only http(s) URLs can be opened" }, { status: 400 });
  }

  const safe = target.toString();
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Opening in Chrome…</title></head>
<body style="font:14px system-ui,sans-serif;padding:40px;text-align:center;color:#52525b">
<p>Opening <code style="font-size:12px">${target.hostname}${target.pathname.slice(0, 60)}</code> in your real browser…</p>
<p><a href="${escapeAttr(safe)}" target="_blank" rel="noopener">Click here if it doesn't open automatically</a></p>
<script>
  try { window.open(${JSON.stringify(safe)}, "_blank", "noopener"); } catch (e) {}
</script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
