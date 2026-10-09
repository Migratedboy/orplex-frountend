import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function clean(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Google (no-JS endpoint). Google bot-challenges datacenter IPs aggressively —
 * when this returns a consent page or zero parseable results, the chain falls
 * through to Bing RSS (the only remaining fallback).
 */
async function searchGoogle(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, num: "15", hl: "en", gbv: "1" });
  const res = await fetch(`https://www.google.com/search?${params}`, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Google ${res.status}`);
  const html = await res.text();

  // Consent/challenge pages contain no result anchors — treat as failure.
  // 2026-09: Google's gbv=1 endpoint now answers with a JS-retry interstitial
  // (httpservice/retry/enablejs) containing ZERO /url?q= links — detect it so
  // the chain skips to the next engine in milliseconds instead of parsing air.
  if (
    /consent\.google\.com|detected unusual traffic|httpservice\/retry\/enablejs/i.test(html)
  ) {
    throw new Error("Google bot-wall/JS-retry page");
  }

  const results: SearchResult[] = [];
  // No-JS result links look like <a href="/url?q=https://real.url&sa=...">.
  const linkRe = /<a[^>]+href="\/url\?q=([^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && results.length < 10) {
    const url = decodeURIComponent(m[1]);
    if (!/^https?:\/\//i.test(url) || /google\.[a-z.]+\/url|accounts\.google/i.test(url)) continue;
    const title = clean(m[2]);
    // Snippets: nearest h3-adjacent div text is unreliable in raw HTML; the
    // title + URL are the payload the agent needs. Snippet optional.
    if (title && url) {
      results.push({ title, url, snippet: "" });
      continue;
    }
  }
  if (results.length === 0) throw new Error("Google returned no parseable results");
  return results;
}

async function searchBing(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    format: "rss",
    count: "20",
    mkt: "en-US",
    setlang: "en-US",
    cc: "US",
    q: query,
  });
  const res = await fetch(`https://www.bing.com/search?${params}`, {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Bing ${res.status}`);
  const xml = await res.text();

  const results: SearchResult[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && results.length < 10) {
    const item = m[1];
    const link = decodeEntities(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "").trim();
    if (!/^https?:\/\//i.test(link) || /bing\.com\/search/i.test(link)) continue;
    const title = clean(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const snippet = clean(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "");
    if (title && link) results.push({ title, url: link, snippet });
  }
  if (results.length === 0) throw new Error("Bing returned no results");
  return results;
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => null);
    const rawQuery = typeof body?.query === "string" ? body.query : "";
    if (!rawQuery.trim()) {
      return NextResponse.json({ error: "No query provided" }, { status: 400 });
    }
    // Cap the query: it becomes a third-party URL — megabytes of input
    // mean megabytes of outbound request.
    const query = rawQuery.trim().slice(0, 300);

    // Google-first chain; report which engine answered for debugging.
    // DuckDuckGo was removed per product decision — Google, then Bing only.
    const engines: Array<{ name: string; fn: (q: string) => Promise<SearchResult[]> }> = [
      { name: "google", fn: searchGoogle },
      { name: "bing", fn: searchBing },
    ];

    let lastError: string = "unknown";
    for (const engine of engines) {
      try {
        const results = await engine.fn(query);
        return NextResponse.json({ results, query, engine: engine.name });
      } catch (err) {
        lastError = `${engine.name}`;
        console.warn(`[search] ${engine.name} failed:`, (err as Error).message);
      }
    }

    return NextResponse.json(
      { error: `All search engines failed (${lastError})`, results: [] },
      { status: 502 }
    );
  } catch (err) {
    console.error("[search]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Search failed", results: [] }, { status: 500 });
  }
}
