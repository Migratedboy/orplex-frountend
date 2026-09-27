import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import * as nodeDns from "node:dns/promises";
import { jwtOnlyOptions } from "@/lib/auth";
import { isProxiableUrl, rewriteHtml } from "@/lib/browser-proxy";
import { resolveTargetGuard, nextRedirectUrl, buildPassthroughHeaders } from "@/lib/proxy-guard";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Cap on manual redirect hops — failure mode is an honest error page. */
const MAX_REDIRECTS = 5;

/**
 * Fetch a proxied target with redirect re-validation: unlike `redirect:
 * "follow"` (which would happily bounce to http://127.0.0.1:5433 after the
 * initial URL passed the SSRF guard), every hop is guarded again. Returns
 * the final response plus the URL it actually came from.
 */
async function guardedFetch(
  startUrl: string,
  signal: AbortSignal,
): Promise<{ res: Response; finalUrl: string } | { error: string }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const guard = await resolveTargetGuard(current, (h) => nodeDns.lookup(h, { all: true }));
    if (!guard.ok) return { error: `Blocked: ${guard.reason}` };
    const res = await fetch(current, {
      signal,
      redirect: "manual", // we re-validate each hop ourselves
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        // Defense in depth: never volunteer cookies to the target even if a
        // future refactor adds a cookie jar — the proxy is uncredentialed.
        "Cookie": "",
      },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const next = nextRedirectUrl(current, res.headers.get("location"));
      if (!next) return { error: "Redirect without a Location header" };
      if (!isProxiableUrl(next)) return { error: "Redirect to a non-web scheme" };
      try { await res.body?.cancel(); } catch { /* drained */ }
      current = next;
      continue;
    }
    return { res, finalUrl: current };
  }
  return { error: `Too many redirects (>${MAX_REDIRECTS})` };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Friendly landing for YouTube pages the embedded browser can't render.
 * Offers a video search (which plays through the embed player) and a handoff
 * to the real browser.
 */
function youtubeInterstitial(realUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YouTube — embedded browser</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
         font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; background: #1a1c1d; color: #f4f4f5; }
  .card { max-width: 460px; text-align: center; }
  .logo { font-size: 44px; }
  h2 { margin: 10px 0 6px; font-size: 19px; }
  p { margin: 0 0 18px; color: #a1a1aa; font-size: 13.5px; }
  form { display: flex; gap: 8px; margin-bottom: 14px; }
  input { flex: 1; padding: 10px 14px; border: 1px solid #3f3f46; border-radius: 10px; background: #26262a; color: #f4f4f5; font-size: 14px; outline: none; }
  input:focus { border-color: #ea580c; }
  button { padding: 10px 18px; border: 0; border-radius: 10px; background: #ea580c; color: #fff; font-weight: 600; cursor: pointer; }
  a.real { display: inline-block; margin-top: 4px; color: #93b4ff; font-size: 13.5px; text-decoration: none; }
  a.real:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">▶️</div>
  <h2>YouTube pages can't render here</h2>
  <p>Video links open in the embedded player — just click one from search results.
     This page (${esc(shortHost(realUrl))}) needs your real browser.</p>
  <form method="GET" action="/api/search-page">
    <input type="search" name="q" placeholder="Search YouTube videos…" autofocus>
    <button type="submit">Search</button>
  </form>
  <a class="real" href="${esc(realUrl)}" target="_blank" rel="noopener">Open this page in your real browser ↗</a>
</div>
</body>
</html>`;
}

function shortHost(u: string): string {
  try { return new URL(u).hostname.replace(/^(www|m)\./i, ""); } catch { return "this site"; }
}

export async function GET(request: NextRequest) {
  // Auth: same session gate as the rest of the app APIs.
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawUrl = request.nextUrl.searchParams.get("url");
  const rawMode = request.nextUrl.searchParams.get("raw") === "1";
  if (!rawUrl) {
    return NextResponse.json({ error: "URL required" }, { status: 400 });
  }
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  if (!isProxiableUrl(rawUrl)) {
    return NextResponse.json({ error: "URL not allowed" }, { status: 403 });
  }

  // YouTube non-video pages (home, channels, playlists) are JS SPAs that
  // cannot survive the same-origin proxy — they render as a broken skeleton
  // because their scripts need the real origin. Show a clean interstitial
  // instead. Video pages (/watch, /shorts, /live) are upgraded client-side to
  // the official embed player, so they still pass through untouched.
  const strippedHost = target.hostname.replace(/^(www|m)\./i, "");
  const isVideoPath = /^\/(watch|shorts|live|embed)\b/i.test(target.pathname);
  if ((strippedHost === "youtube.com" || strippedHost === "youtube-nocookie.com") && !isVideoPath) {
    return new NextResponse(youtubeInterstitial(target.toString()), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Proxy-Url": target.toString() },
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let upstream: Response;
  let finalUrl = target.toString();
  try {
    const result = await guardedFetch(target.toString(), controller.signal);
    if ("error" in result) {
      clearTimeout(timeout);
      return new NextResponse(
        `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#5f6368"><div style="text-align:center"><div style="font-size:64px">🛡️</div><h2>Blocked</h2><p style="color:#80868b">${esc(result.error)}</p></div></body></html>`,
        { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }
    upstream = result.res;
    finalUrl = result.finalUrl;
    clearTimeout(timeout);

    const contentType = upstream.headers.get("content-type") || "text/html";

    // Non-HTML: stream through untouched (images, css, js, fonts).
    if (rawMode || !/text\/html|application\/xhtml/i.test(contentType)) {
      // Strict allowlist of upstream headers — drops Set-Cookie (cookie
      // tossing on the app origin) and any other upstream auth state.
      const passthrough = buildPassthroughHeaders(upstream.headers);
      passthrough.set("Cache-Control", "private, max-age=300");
      passthrough.set("X-Proxy-Url", finalUrl);
      return new NextResponse(upstream.body, { status: upstream.status, headers: passthrough });
    }

    // HTML: rewrite for same-origin framing. The exfiltration-hardened CSP
    // for proxied pages lives in middleware.ts (same branch as frame-ancestors
    // 'self') — middleware headers win over route headers, so it is the
    // single source of truth.
    const html = await upstream.text();
    const rewritten = rewriteHtml(html, finalUrl);
    return new NextResponse(rewritten, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Proxy-Url": finalUrl,
      },
    });
  } catch (err) {
    clearTimeout(timeout);
    const aborted = (err as Error).name === "AbortError";
    return new NextResponse(
      `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#5f6368"><div style="text-align:center"><div style="font-size:64px">🌐</div><h2>${aborted ? "This site took too long to respond" : "This site can’t be reached"}</h2><p style="color:#80868b">${target.hostname}</p></div></body></html>`,
      { status: aborted ? 504 : 502, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}
