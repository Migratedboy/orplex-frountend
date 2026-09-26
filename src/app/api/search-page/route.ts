// search-page route — server-rendered search results for the embedded browser.
//
// Google-first: we parse Google's no-JS HTML endpoint server-side (works from
// residential connections; datacenter IPs may hit a consent/challenge page, in
// which case the chain falls back to Bing's stable RSS endpoint, then DDG).
// Result links load through /api/proxy so pages stay inside the embedded
// browser, and each hit also carries an "open in Chrome" affordance that
// hands the real URL to the user's installed browser via /api/open-external.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, (m) => XML_ENTITIES[m] ?? m);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function clean(s: string): string {
  return escapeHtml(decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim());
}

async function fetchGoogle(query: string): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, num: "15", hl: "en", gbv: "1" });
  const res = await fetch(`https://www.google.com/search?${params}`, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Google ${res.status}`);
  const html = await res.text();
  // 2026-09: Google's gbv=1 endpoint returns a JS-retry interstitial with
  // zero parseable links — bail fast so Bing RSS answers instead.
  if (
    /consent\.google\.com|detected unusual traffic|httpservice\/retry\/enablejs/i.test(html)
  ) {
    throw new Error("Google bot-wall/JS-retry page");
  }

  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]+href="\/url\?q=([^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && hits.length < 15) {
    const url = decodeURIComponent(m[1]);
    if (!/^https?:\/\//i.test(url) || /google\.[a-z.]+\/url|accounts\.google/i.test(url)) continue;
    const title = clean(m[2]);
    if (title && url) hits.push({ title, url, snippet: "" });
  }
  if (hits.length === 0) throw new Error("Google returned no parseable results");
  return hits;
}

async function fetchBing(query: string): Promise<SearchHit[]> {
  // mkt/setlang/cc are REQUIRED: without them Bing RSS ignores the query's
  // locale and returns garbage (e.g. local address lookups for "youtube").
  const rssUrl = `https://www.bing.com/search?format=rss&count=20&mkt=en-US&setlang=en-US&cc=US&q=${encodeURIComponent(query)}`;
  const res = await fetch(rssUrl, {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Bing RSS ${res.status}`);
  const xml = await res.text();

  const hits: SearchHit[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && hits.length < 15) {
    const item = m[1];
    const link = decodeEntities(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "")
      .trim()
      .replace(/[\s\u3000\uFF0C\u3001\u3002]+$/u, "");
    if (!/^https?:\/\//i.test(link) || /bing\.com\/search/i.test(link)) continue;
    const title = clean(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const snippet = clean(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "");
    if (title && link) hits.push({ title, url: link, snippet });
  }
  if (hits.length === 0) throw new Error("Bing returned no results");
  return hits;
}

/** Last resort: DDG lite — tiny static page, no bot-wall on server fetches. */
async function fetchDuckDuckGoLite(query: string): Promise<SearchHit[]> {
  const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DDG-lite ${res.status}`);
  const html = await res.text();

  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && hits.length < 15) {
    let url = m[1];
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    if (title && /^https?:\/\//i.test(url)) hits.push({ title, url, snippet: "" });
  }
  if (hits.length === 0) throw new Error("DDG-lite returned no results");
  return hits;
}

async function fetchResults(query: string): Promise<{ hits: SearchHit[]; engine: string }> {
  const engines: Array<{ name: string; fn: (q: string) => Promise<SearchHit[]> }> = [
    { name: "google", fn: fetchGoogle },
    { name: "bing", fn: fetchBing },
    { name: "ddg-lite", fn: fetchDuckDuckGoLite },
  ];
  let lastError = "unknown";
  for (const engine of engines) {
    try {
      return { hits: await engine.fn(query), engine: engine.name };
    } catch (err) {
      lastError = `${engine.name}: ${(err as Error).message}`;
    }
  }
  throw new Error(lastError);
}

function renderPage(query: string, hits: SearchHit[], engine: string, error?: string): string {
  const results = error
    ? `<div class="err">Search failed: ${escapeHtml(error)}. Try again in a moment.</div>`
    : hits.length === 0
      ? `<div class="err">No results for “${escapeHtml(query)}”.</div>`
      : hits
          .map(
            (h) => `
  <div class="hit">
    <a class="hitlink" href="/api/proxy?url=${encodeURIComponent(h.url)}">
      <div class="u">${escapeHtml(shortUrl(h.url))}</div>
      <div class="t">${h.title}</div>
      <div class="s">${h.snippet}</div>
    </a>
    <a class="chrome" title="Open in your real browser (Chrome)" href="/api/open-external?url=${encodeURIComponent(h.url)}" target="_blank" rel="noopener">↗ Chrome</a>
  </div>`
          )
          .join("");

  const byline = error ? "" : `<div class="engine">via ${escapeHtml(engine)}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(query)} — search</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px 22px 40px; font: 14px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; background: #fff; color: #1a1c1d; }
  form { display: flex; gap: 8px; max-width: 640px; margin: 0 auto 10px; }
  input[type=search] { flex: 1; padding: 9px 14px; border: 1px solid #d4d4d8; border-radius: 10px; font-size: 14px; outline: none; }
  input[type=search]:focus { border-color: #ea580c; }
  button { padding: 9px 16px; border: 0; border-radius: 10px; background: #ea580c; color: #fff; font-weight: 600; cursor: pointer; }
  .max { max-width: 640px; margin: 0 auto; }
  .engine { max-width: 640px; margin: 0 auto 14px; font: 10px ui-monospace, monospace; color: #a1a1aa; text-align: right; }
  .hit { position: relative; display: block; margin-bottom: 10px; border: 1px solid #e4e4e7; border-radius: 10px; transition: border-color .15s, background .15s; }
  .hitlink { display: block; padding: 12px 14px; text-decoration: none; color: inherit; }
  .hit:hover { border-color: #ea580c; background: #fff7ed; }
  .chrome { position: absolute; top: 8px; right: 10px; font: 10px ui-monospace, monospace; color: #6b7280; text-decoration: none; border: 1px solid #d4d4d8; border-radius: 6px; padding: 2px 7px; }
  .chrome:hover { color: #ea580c; border-color: #ea580c; }
  .u { font: 11px ui-monospace, monospace; color: #16a34a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 62px; }
  .t { font-size: 15px; font-weight: 600; color: #1d4ed8; margin: 3px 0; }
  .s { font-size: 12.5px; color: #52525b; }
  .err { padding: 14px; border: 1px dashed #d4d4d8; border-radius: 10px; color: #71717a; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1c1d; color: #f4f4f5; }
    input[type=search] { background: #26262a; border-color: #3f3f46; color: #f4f4f5; }
    .hit { border-color: #3f3f46; } .hit:hover { background: #27211a; border-color: #ea580c; }
    .t { color: #93b4ff; } .s { color: #a1a1aa; } .u { color: #4ade80; }
    .err { border-color: #3f3f46; color: #a1a1aa; }
    .chrome { border-color: #3f3f46; color: #a1a1aa; } .chrome:hover { color: #ea580c; border-color: #ea580c; }
  }
</style>
</head>
<body>
<form method="GET" action="/api/search-page">
  <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Search… (results open in Chrome on click if framed page blocks them)" autofocus>
  <button type="submit">Search</button>
</form>
${byline}
<div class="max">${results}</div>
</body>
</html>`;
}

function shortUrl(u: string): string {
  try {
    const p = new URL(u);
    return p.host + (p.pathname.length > 1 ? p.pathname.slice(0, 60) : "");
  } catch {
    return u.slice(0, 70);
  }
}

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = request.nextUrl.searchParams.get("q")?.slice(0, 300) || "";
  if (!q.trim()) {
    return new NextResponse(renderPage("", [], ""), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  try {
    const { hits, engine } = await fetchResults(q);
    return new NextResponse(renderPage(q, hits, engine), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch (err) {
    return new NextResponse(renderPage(q, [], "", (err as Error).message), {
      status: 502,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}
