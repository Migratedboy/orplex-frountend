import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { getProviderDef } from "@/lib/provider-registry";
import { listProviderModels, verifyProviderModels, type ListedModel } from "@/lib/provider-models";
import { prisma } from "@/lib/prisma";
import { decryptKey } from "@/lib/key-encryption";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/keys/models — the model-fetching engine endpoint.
 *
 * Body: { provider, apiKey? , keyId? }
 *   - apiKey given:  list models with the pasted key (typical add flow).
 *   - keyId given:   list models with the STORED key (re-fetch later,
 *                    e.g. the prompt bar or "Refresh" in Settings).
 *
 * Never stores or logs the key. When keyId is provided and the listing
 * succeeds, the normalized list persists to UserApiKey.modelsCache so the
 * picker can read it without another network call.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const provider = typeof body?.provider === "string" ? body.provider : "";
  const def = getProviderDef(provider);
  if (!def) {
    return NextResponse.json({ success: false, error: "Unknown provider." }, { status: 400 });
  }

  let apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const keyId = typeof body?.keyId === "string" ? body.keyId : "";
  // mode "verify" = the explicit, budget-guarded BYOK probe action.
  const mode = body?.mode === "verify" ? "verify" : "list";

  if (!apiKey && keyId) {
    // Stored-key path: only the owner's key, decrypted server-side.
    const stored = await prisma.userApiKey
      .findFirst({ where: { id: keyId, userId: session.user.id } })
      .catch(() => null);
    if (!stored) {
      return NextResponse.json({ success: false, error: "Key not found." }, { status: 404 });
    }
    apiKey = decryptKey(stored.apiKey);
  }

  if (!apiKey) {
    return NextResponse.json({ success: false, error: "Provide apiKey or keyId." }, { status: 400 });
  }

  const listing = await listProviderModels(provider, apiKey);
  if (!listing.ok) {
    return NextResponse.json({
      success: false,
      models: [],
      error: listing.error,
      persisted: false,
      count: 0,
    });
  }

  let finalModels = listing.models as Array<ListedModel & { verified?: boolean }>;
  let probedCount = 0;
  let verifiedCount = 0;
  if (mode === "verify") {
    const vr = await verifyProviderModels(provider, apiKey, listing.models);
    finalModels = vr.models;
    probedCount = vr.probedCount;
    verifiedCount = vr.verifiedCount;
  }

  // Persist the listing for stored keys so the picker can serve it offline
  // of the provider (best-effort — listing already succeeded or failed).
  let persisted = false;
  if (keyId) {
    persisted = await prisma.userApiKey
      .update({
        where: { id: keyId },
        data: { modelsCache: finalModels as unknown as object, modelsFetchedAt: new Date() },
      })
      .then(() => true)
      .catch(() => false);
  }

  return NextResponse.json({
    success: true,
    models: finalModels,
    warning: listing.warning,
    persisted,
    count: finalModels.length,
    probedCount,
    verifiedCount,
  });
}
