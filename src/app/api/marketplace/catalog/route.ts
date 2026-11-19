// GET /api/marketplace/catalog — the signed marketplace catalogue as JSON.
//
// The client components that render the skill picker need this data at render
// time; serving it here keeps the Ed25519 public key and the disk cache on the
// server, and gives the UI one place to learn that the catalogue is stale.
import { NextResponse } from "next/server";
import { getMarketplaceSnapshot } from "@/lib/marketplace-client";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await getMarketplaceSnapshot();
  const bundle = snapshot.bundle;
  return NextResponse.json(
    {
      success: !!bundle,
      source: snapshot.source,
      verified: snapshot.verified,
      fetchedAt: snapshot.fetchedAt,
      generatedAt: bundle?.generatedAt ?? null,
      error: snapshot.error ?? null,
      counts: bundle?.counts ?? { skill: 0, mcp: 0, plugin: 0 },
      skillCategories: bundle?.skillCategories ?? [],
      skills: bundle?.skills ?? [],
    },
    { headers: { "cache-control": "private, max-age=300" } },
  );
}
