import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { encryptKey, maskKey } from "@/lib/key-encryption";
import { getPoolSummary } from "@/lib/key-pool";

// GET /api/admin/keys — List all keys
export async function GET() {
  try {
    await requireAdmin();
    const summary = await getPoolSummary();

    return NextResponse.json({
      keys: summary.keys.map(k => ({
        ...k,
        apiKeyMasked: "****",
      })),
      summary: {
        totalKeys: summary.totalKeys,
        activeKeys: summary.activeKeys,
        totalUsageToday: summary.totalUsageToday,
        totalCapacity: summary.totalCapacity,
        utilizationPercent: summary.utilizationPercent,
      },
    });
  } catch (err: any) {
    const status = err.message === "Unauthorized" ? 401 : err.message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}

// POST /api/admin/keys — Add new key
export async function POST(request: NextRequest) {
  try {
    await requireAdmin();
    const body = await request.json();
    const { provider, apiKey, model, dailyLimit, priority } = body;

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

    // Test the key with a minimal API call
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
    const key = await prisma.apiKeyPool.create({
      data: {
        provider,
        apiKey: encrypted,
        model,
        dailyLimit: dailyLimit || 1000,
        priority: priority || 0,
      },
    });

    return NextResponse.json({
      key: {
        id: key.id,
        provider: key.provider,
        model: key.model,
        apiKeyMasked: maskKey(apiKey),
        isValid: true,
        message: "Key added and verified successfully",
      },
    });
  } catch (err: any) {
    const status = err.message === "Unauthorized" ? 401 : err.message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}

// PATCH /api/admin/keys — Update key
export async function PATCH(request: NextRequest) {
  try {
    await requireAdmin();
    const body = await request.json();
    const { id, isActive, priority, dailyLimit } = body;

    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const updateData: any = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (priority !== undefined) updateData.priority = priority;
    if (dailyLimit !== undefined) updateData.dailyLimit = dailyLimit;

    const key = await prisma.apiKeyPool.update({ where: { id }, data: updateData });

    return NextResponse.json({ key: { id: key.id, provider: key.provider, isActive: key.isActive } });
  } catch (err: any) {
    const status = err.message === "Unauthorized" ? 401 : err.message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}

// DELETE /api/admin/keys?id=xxx — Delete key
export async function DELETE(request: NextRequest) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    await prisma.apiKeyPool.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    const status = err.message === "Unauthorized" ? 401 : err.message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
