import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { webSearch } from "@/lib/web-search";

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

    // One chain, shared with the server executor (src/lib/web-search.ts).
    const outcome = await webSearch(rawQuery);
    if (outcome.error) {
      return NextResponse.json({ error: outcome.error, results: [] }, { status: 502 });
    }
    return NextResponse.json({
      results: outcome.results,
      query: rawQuery.trim().slice(0, 300),
      engine: outcome.engine,
    });
  } catch (err) {
    console.error("[search]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Search failed", results: [] }, { status: 500 });
  }
}
