import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptKey, decryptKey, maskKey } from "@/lib/key-encryption";
import { getProviderDef, providerLabel } from "@/lib/provider-registry";

// GET /api/settings/keys — List user's keys
export async function GET() {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const keys = await prisma.userApiKey.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      keys: keys.map(k => ({
        id: k.id,
        provider: k.provider,
        providerLabel: providerLabel(k.provider),
        model: k.model,
        apiKeyMasked: "****",
        isActive: k.isActive,
        usageToday: k.usageToday,
        createdAt: k.createdAt,
        verified: k.verified ?? false,
        lastVerifiedAt: k.lastVerifiedAt,
        modelsFetchedAt: k.modelsFetchedAt,
        cachedModelCount: Array.isArray(k.modelsCache) ? (k.modelsCache as unknown[]).length : null,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/settings/keys — Add a user key (any registry provider)
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const fields = body as Record<string, unknown>;
    const { provider, apiKey, model } = fields;
    const label = typeof fields.label === "string" ? fields.label.trim().slice(0, 60) : "";

    if (typeof provider !== "string" || !provider || typeof apiKey !== "string" || !apiKey || typeof model !== "string" || !model) {
      return NextResponse.json({ error: "provider, apiKey, and model are required" }, { status: 400 });
    }
    // Bound the secret before it touches encrypt/DB/network: megabytes of
    // pasted text are never a valid key.
    if (apiKey.length > 512 || model.length > 120 || provider.length > 40) {
      return NextResponse.json({ error: "Field too long" }, { status: 400 });
    }

    const def = getProviderDef(provider);
    if (!def) {
      return NextResponse.json(
        { error: `Unknown provider "${String(provider).slice(0, 40)}" — pick one from the list.` },
        { status: 400 }
      );
    }

    // Advisory prefix check — a mismatch is a warning, not a rejection.
    // Prefixes drift and the live test below is the real gate.
    const keyText = String(apiKey);
    const prefixWarning =
      def.keyPrefix && !keyText.startsWith(def.keyPrefix)
        ? `${def.label} keys usually start with "${def.keyPrefix}" — the live test decides.`
        : undefined;

    // Live validation against the provider's OpenAI-compatible chat endpoint
    // with the chosen model — the same path real chat traffic takes.
    let isValid = false;
    try {
      const testRes = await fetch(`${def.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${keyText}`,
          ...(def.extraHeaders ?? {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      isValid = testRes.ok;
    } catch {
      isValid = false;
    }

    if (!isValid) {
      return NextResponse.json({
        error: "API key validation failed. Check your key and model.",
        isValid: false,
      }, { status: 400 });
    }

    // Encrypt and store
    const encrypted = encryptKey(keyText);
    const key = await prisma.userApiKey.create({
      data: {
        userId: session.user.id,
        provider,
        apiKey: encrypted,
        model,
        ...(label ? { label } : {}),
        verified: true,
        lastVerifiedAt: new Date(),
      },
    });

    return NextResponse.json({
      key: {
        id: key.id,
        provider: key.provider,
        model: key.model,
        apiKeyMasked: maskKey(keyText),
        isValid: true,
        message: "Key added successfully",
      },
      warning: prefixWarning,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE /api/settings/keys?id=xxx — Remove user key
export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    // Atomic ownership-scoped delete: check-then-delete races (and the
    // unwieldy two-step) collapse into one statement that can only remove
    // THIS user's key. count === 0 means missing-or-not-owned (same 404
    // either way — never reveal which).
    const deleted = await prisma.userApiKey.deleteMany({ where: { id, userId: session.user.id } });
    if (deleted.count === 0) return NextResponse.json({ error: "Key not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
