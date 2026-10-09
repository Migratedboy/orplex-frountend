import { NextRequest, NextResponse } from "next/server";
import { getMcpSession } from "@/lib/mcp-auth";
import { MCP_CATEGORIES, searchMcpCatalog, MCP_CATALOG_SIZE } from "@/lib/mcp-catalog";

export const dynamic = "force-dynamic";

/**
 * GET /api/mcp/catalog?q=&category=
 * The verified MCP server catalog for the Connectors browser.
 */
export async function GET(request: NextRequest) {
  const session = await getMcpSession();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const category = request.nextUrl.searchParams.get("category") ?? "all";
  const results = searchMcpCatalog(q, category as never);
  return NextResponse.json({
    success: true,
    total: MCP_CATALOG_SIZE,
    categories: MCP_CATEGORIES,
    servers: results.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      category: e.category,
      auth: e.auth,
      remote: e.remote ?? null,
      stdio: e.stdio ?? null,
      oauth: e.oauth ?? null,
      docsUrl: e.docsUrl ?? null,
      popular: !!e.popular,
    })),
  });
}
