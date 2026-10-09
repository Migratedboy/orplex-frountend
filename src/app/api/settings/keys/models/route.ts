import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { getProviderDef } from "@/lib/provider-registry";
import { listProviderModels, verifyProviderModels, type ListedModel } from "@/lib/provider-models";
import { prisma } from "@/lib/prisma";
import { decryptKey } from "@/lib/key-encryption";
import { notify } from "@/lib/notify";

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

  // True only when keyId passed the ownership check below — the persist
  // step must never fire for a keyId the caller doesn't own (sending both a
  // raw apiKey and a victim's keyId would otherwise overwrite their cache).
  let keyIdOwned = false;
  if (!apiKey && keyId) {
    // Stored-key path: only the owner's key, decrypted server-side.
    const stored = await prisma.userApiKey
      .findFirst({ where: { id: keyId, userId: session.user.id } })
      .catch(() => null);
    if (!stored) {
      return NextResponse.json({ success: false, error: "Key not found." }, { status: 404 });
    }
    keyIdOwned = true;
    try {
      apiKey = decryptKey(stored.apiKey);
    } catch {
      return NextResponse.json({ success: false, error: "Stored key unreadable." }, { status: 500 });
    }
  }

  if (!apiKey) {
    return NextResponse.json({ success: false, error: "Provide apiKey or keyId." }, { status: 400 });
  }

  const listing = await listProviderModels(provider, apiKey);
  if (!listing.ok) {
    // Listing itself failed (bad key rejected at the models endpoint,
    // provider down, rate limit). Notify precisely — never a naked error.
    const kind: "invalid_key" | "no_credits" | "network" =
      listing.status === 401 || listing.status === 403
        ? "invalid_key"
        : listing.status === 402
          ? "no_credits"
          : "network";
    const label = def.label;
    await notify(session.user.id, {
      type: "error",
      title: kind === "invalid_key" ? "API key is not valid" : kind === "no_credits" ? "No credits left in the API" : "Provider unreachable",
      message: `${label}: ${listing.error || "could not list models."}`,
      source: "models",
    });
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

    // Trial outcome notifications: only when NOTHING survived — the user
    // must know why the picker is empty (bad key / empty credits / dead
    // network). Successes notify too, briefly, so the action always lands.
    const label = def.label;
    if (vr.failureKind === "invalid_key") {
      await notify(session.user.id, {
        type: "error",
        title: "API key is not valid",
        message: `Every ${label} model failed the "hi" trial — the provider rejected your API key.${vr.failureDetail ? ` (${vr.failureDetail.slice(0, 140)})` : ""}`,
        source: "models",
      });
    } else if (vr.failureKind === "no_credits") {
      await notify(session.user.id, {
        type: "error",
        title: "No credits left in the API",
        message: `Every ${label} model failed the "hi" trial — your key has no remaining credits. Top up at the provider's billing page.`,
        source: "models",
      });
    } else if (vr.failureKind === "no_models" || vr.failureKind === "network") {
      await notify(session.user.id, {
        type: "error",
        title: vr.failureKind === "no_models" ? "No models available in the API" : "Provider unreachable",
        message: `${label}: ${vr.error || "the model trial could not run."}`,
        source: "models",
      });
    } else if (verifiedCount === 0) {
      await notify(session.user.id, {
        type: "error",
        title: "No models available in the API",
        message: `None of the ${probedCount} ${label} models tried answered the "hi" trial — the models may be temporarily down.`,
        source: "models",
      });
    } else {
      await notify(session.user.id, {
        type: "success",
        title: "Model trial passed",
        message: `${verifiedCount}/${probedCount} ${label} models answered the "hi" trial and are marked verified.`,
        source: "models",
      });
    }
  }

  // Persist the listing for stored keys so the picker can serve it offline
  // of the provider (best-effort — listing already succeeded or failed).
  // Ownership-scoped: only fires for a keyId verified above, never for a
  // caller-supplied id paired with a raw apiKey.
  let persisted = false;
  if (keyId && keyIdOwned) {
    persisted = await prisma.userApiKey
      .updateMany({
        where: { id: keyId, userId: session.user.id },
        data: { modelsCache: finalModels as unknown as object, modelsFetchedAt: new Date() },
      })
      .then((r) => r.count > 0)
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
