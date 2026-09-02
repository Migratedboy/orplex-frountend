import { NextRequest, NextResponse } from "next/server";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, t: "h_", ia: "web" });
  const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!res.ok) throw new Error(`Search failed: ${res.status}`);

  const html = await res.text();
  const results: SearchResult[] = [];

  // Parse result blocks
  const resultRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  let match;
  while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
    let url = match[1];
    // DuckDuckGo wraps URLs in a redirect — extract the actual URL
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);

    const title = match[2].replace(/<[^>]+>/g, "").trim();
    const snippet = match[3].replace(/<[^>]+>/g, "").trim();

    if (title && url.startsWith("http")) {
      results.push({ title, url, snippet });
    }
  }

  // Fallback: simpler regex if the main one didn't match
  if (results.length === 0) {
    const simpleRegex = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const urlRegex = /href="([^"]*uddg=[^"]*)"/g;

    const titles: string[] = [];
    const snippets: string[] = [];
    const urls: string[] = [];

    let m;
    while ((m = simpleRegex.exec(html)) !== null)
      titles.push(m[1].replace(/<[^>]+>/g, "").trim());
    while ((m = snippetRegex.exec(html)) !== null)
      snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
    while ((m = urlRegex.exec(html)) !== null) {
      const uddg = m[1].match(/uddg=([^&]+)/);
      if (uddg) urls.push(decodeURIComponent(uddg[1]));
    }

    for (let i = 0; i < Math.min(titles.length, 8); i++) {
      const url = urls[i] || "";
      if (titles[i] && url.startsWith("http")) {
        results.push({
          title: titles[i],
          url,
          snippet: snippets[i] || "",
        });
      }
    }
  }

  return results;
}

export async function POST(request: NextRequest) {
  try {
    const { query } = await request.json();
    if (!query || typeof query !== "string") {
      return NextResponse.json({ error: "No query provided" }, { status: 400 });
    }

    const results = await searchDuckDuckGo(query);

    return NextResponse.json({ results, query });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, results: [] },
      { status: 500 }
    );
  }
}
