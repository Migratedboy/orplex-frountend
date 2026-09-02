import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { sseTransform } from "@/lib/ai-providers";

const FAST_SYSTEM_PROMPT = `You are a fast, concise assistant. Answer the user's question directly and briefly. No tools, no code blocks unless asked. Keep responses under 200 words.`;

interface ProviderConfig {
  name: string;
  url: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
}

function getFastProvider(): ProviderConfig | null {
  // Try OpenRouter first (llama 8b — fastest)
  const orKey = process.env.OPENROUTER_API_KEY || "";
  if (orKey) {
    return {
      name: "OpenRouter-Fast",
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: orKey,
      model: "meta-llama/llama-3.1-8b-instruct",
      extraHeaders: { "HTTP-Referer": "https://orplex.tech", "X-Title": "Orplex Tech IDE" },
    };
  }
  // Fallback to NVIDIA (llama 8b on NIM — also free)
  const nvKey = process.env.NVIDIA_API_KEY || "";
  if (nvKey) {
    return {
      name: "NVIDIA-Fast",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      apiKey: nvKey,
      model: "meta/llama-3.1-8b-instruct",
    };
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return new Response(
        JSON.stringify({ success: false, error: { message: "Authentication required" } }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body?.messages || !Array.isArray(body.messages)) {
      return new Response(
        JSON.stringify({ success: false, error: { message: "Invalid request" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const provider = getFastProvider();
    if (!provider) {
      return new Response(
        JSON.stringify({ success: false, error: { message: "No AI provider configured" } }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }

    const res = await fetch(provider.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
        ...provider.extraHeaders,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "system", content: FAST_SYSTEM_PROMPT }, ...body.messages],
        max_completion_tokens: 512,
        temperature: 0.5,
        stream: true,
        // M3: disable thinking for instant fast responses
        thinking: { type: "disabled" },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      return new Response(
        JSON.stringify({ success: false, error: { message: `Fast model error: ${res.status}` } }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!res.body) {
      return new Response(
        JSON.stringify({ success: false, error: { message: "No response body" } }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(sseTransform(res.body), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ success: false, error: { message: msg } }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
