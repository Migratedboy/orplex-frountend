import { NextRequest, NextResponse } from "next/server";
import { getMcpSession } from "@/lib/mcp-auth";
import { getMarketplaceSnapshot } from "@/lib/marketplace-client";
import { MCP_CATEGORIES } from "@orplex/sdk/mcp";

export const dynamic = "force-dynamic";

const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, " ");

/**
 * GET /api/mcp/catalog?q=&category=
 *
 * The MCP catalogue is marketplace data now, not a compiled-in array: it is
 * fetched once, signature-verified and cached by marketplace-client. When the
 * marketplace is unreachable the list is empty and `source` says why — an
 * empty connectors list is better than a list of servers nobody verified.
 */
export async function GET(request: NextRequest) {
  const session = await getMcpSession();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const q = norm(request.nextUrl.searchParams.get("q") ?? "");
  const category = request.nextUrl.searchParams.get("category") ?? "all";
  const snapshot = await getMarketplaceSnapshot();
  const catalog = snapshot.bundle?.mcp ?? [];

  // Same ranking the previous implementation used: exact name/id beats prefix,
  // beats substring, beats description, beats category.
  const score = (e: (typeof catalog)[number]): number => {
    if (!q) return e.popular ? 2 : 1;
    const name = norm(e.name);
    const id = norm(e.id);
    if (name === q || id === q) return 100;
    if (name.startsWith(q) || id.startsWith(q)) return 80;
    if (name.includes(q) || id.includes(q)) return 60;
    if (norm(e.description ?? "").includes(q)) return 40;
    if (e.category.includes(q)) return 20;
    return 0;
  };

  const pool = category === "all" ? catalog : catalog.filter((e) => e.category === category);
  const servers = pool
    .map((entry) => ({ entry, score: score(entry) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, 60)
    .map(({ entry }) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      auth: entry.auth,
      remote: entry.remote ?? null,
      stdio: entry.stdio ?? null,
      oauth: entry.oauth ?? null,
      docsUrl: entry.docsUrl ?? null,
      popular: !!entry.popular,
    }));

  return NextResponse.json({
    success: true,
    total: catalog.length,
    source: snapshot.source,
    verified: snapshot.verified,
    error: snapshot.error ?? null,
    categories: snapshot.bundle?.mcpCategories?.length
      ? [{ key: "all", label: "All" }, ...snapshot.bundle.mcpCategories]
      : MCP_CATEGORIES,
    servers,
  });
}
