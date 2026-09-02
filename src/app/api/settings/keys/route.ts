import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptKey, decryptKey, maskKey } from "@/lib/key-encryption";

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
        model: k.model,
        apiKeyMasked: "****",
        isActive: k.isActive,
        usageToday: k.usageToday,
        createdAt: k.createdAt,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/settings/keys — Add a user key
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { provider, apiKey, model } = body;

    if (!provider || !apiKey || !model) {
      return NextResponse.json({ error: "provider, apiKey, and model are required" }, { status: 400 });
    }

    if (!["nvidia", "openrouter"].includes(provider)) {
      return NextResponse.json({ error: "provider must be nvidia or openrouter" }, { status: 400 });
    }

    // Validate key format
    if (provider === "nvidia" && !apiKey.startsWith("nvapi-")) {
      return NextResponse.json({ error: "NVIDIA keys must start with nvapi-" }, { status: 400 });
    }
    if (provider === "openrouter" && !apiKey.startsWith("sk-or-")) {
      return NextResponse.json({ error: "OpenRouter keys must start with sk-or-" }, { status: 400 });
    }

    // Test the key
    let isValid = false;
    try {
      const testUrl = provider === "nvidia"
        ? "https://integrate.api.nvidia.com/v1/chat/completions"
        : "https://openrouter.ai/api/v1/chat/completions";

      const testRes = await fetch(testUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(provider === "openrouter" ? { "HTTP-Referer": "https://orplex.tech" } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 5,
        }),
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
    const encrypted = encryptKey(apiKey);
    const key = await prisma.userApiKey.create({
      data: {
        userId: session.user.id,
        provider,
        apiKey: encrypted,
        model,
      },
    });

    return NextResponse.json({
      key: {
        id: key.id,
        provider: key.provider,
        model: key.model,
        apiKeyMasked: maskKey(apiKey),
        isValid: true,
        message: "Key added successfully",
      },
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

    // Ensure the key belongs to this user
    const key = await prisma.userApiKey.findFirst({ where: { id, userId: session.user.id } });
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });

    await prisma.userApiKey.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
