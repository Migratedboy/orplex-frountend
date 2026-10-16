/**
 * Regression cover for the adapter-lane image loss.
 *
 * Every adapter inherited `stream()` from `OpenAICompatibleAdapter`, which
 * called `flattenContent()` unconditionally. That filtered every message down
 * to its text parts, so `image_url` parts were dropped for ALL providers —
 * picking a vision-capable model (Gemini, Claude, GPT-4o via OpenRouter)
 * still sent no image, because the loss happened in the shared adapter rather
 * than per provider.
 *
 * A text-only provider must keep receiving plain text (an OpenAI-compatible
 * endpoint rejects a multimodal body), while a vision provider must get the
 * parts intact.
 */

import { OpenRouterAdapter, GroqAdapter, OpenAICompatibleAdapter } from "@/lib/ai-providers";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Body = {
  messages: { role: string; content: unknown }[];
  model: string;
};

/** Capture the request body the adapter would send to the provider. */
async function captureBody(adapter: OpenAICompatibleAdapter, messages: never[]): Promise<Body> {
  let captured: Body | null = null;
  const originalFetch = global.fetch;
  global.fetch = (async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return new Response(new ReadableStream({ start(c) { c.close(); } }), {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;
  try {
    await adapter.stream(messages);
  } finally {
    global.fetch = originalFetch;
  }
  return captured!;
}

const MESSAGES = [
  {
    role: "user",
    content: [
      { type: "text", text: "What is in this image?" },
      { type: "image_url", image_url: { url: PNG } },
    ],
  },
];

describe("adapter multimodal passthrough", () => {
  it("flags which providers accept images", () => {
    expect(new OpenRouterAdapter("k", "google/gemini-2.0-flash").supportsVision).toBe(true);
    // Groq's chat surface is text-only for the models we route there.
    expect(new GroqAdapter("k", "llama-3.3-70b").supportsVision).toBe(false);
  });

  it("sends image_url parts intact to a vision provider", async () => {
    const body = await captureBody(new OpenRouterAdapter("k", "google/gemini-2.0-flash"), MESSAGES as never);

    const user = body.messages.find((m) => m.role === "user")!;
    expect(Array.isArray(user.content)).toBe(true);

    const parts = user.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts.some((p) => p.type === "image_url" && p.image_url?.url === PNG)).toBe(true);
    expect(parts.some((p) => p.type === "text" && p.text === "What is in this image?")).toBe(true);
  });

  it("flattens to text for a text-only provider so the request stays valid", async () => {
    const body = await captureBody(new GroqAdapter("k", "llama-3.3-70b"), MESSAGES as never);

    const user = body.messages.find((m) => m.role === "user")!;
    expect(typeof user.content).toBe("string");
    expect(user.content as string).toContain("What is in this image?");
    expect(user.content as string).not.toContain("base64");
  });

  it("passes plain string content through unchanged", async () => {
    const body = await captureBody(new OpenRouterAdapter("k", "google/gemini-2.0-flash"), [
      { role: "user", content: "just text" },
    ] as never);

    expect(body.messages.find((m) => m.role === "user")!.content).toBe("just text");
  });
});
