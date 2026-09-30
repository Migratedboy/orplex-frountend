import {
  validateRequestBody,
  buildMultipartMessages,
  fetchWithProviderRetry,
} from "../chat-middleware";

describe("chat-middleware", () => {
  // ---------------------------------------------------------------
  // validateRequestBody
  // ---------------------------------------------------------------
  describe("validateRequestBody", () => {
    it("accepts a valid chat request", () => {
      const result = validateRequestBody({
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.messages).toHaveLength(1);
        expect(result.data.messages[0].content).toBe("Hello");
      }
    });

    it("accepts request with mode", () => {
      const result = validateRequestBody({
        messages: [{ role: "user", content: "Build a component" }],
        mode: "code",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.mode).toBe("code");
      }
    });

    it("defaults mode to ask", () => {
      const result = validateRequestBody({
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.mode).toBe("ask");
      }
    });

    it("rejects empty messages array", () => {
      const result = validateRequestBody({ messages: [] });
      expect(result.ok).toBe(false);
    });

    it("rejects missing messages", () => {
      const result = validateRequestBody({});
      expect(result.ok).toBe(false);
    });

    it("accepts null conversationId", () => {
      const result = validateRequestBody({
        messages: [{ role: "user", content: "Hello" }],
        conversationId: null,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts valid images array", () => {
      const result = validateRequestBody({
        messages: [{ role: "user", content: "Analyze this" }],
        images: ["data:image/png;base64,abc123"],
      });
      expect(result.ok).toBe(true);
    });

    it("rejects invalid mode", () => {
      const result = validateRequestBody({
        messages: [{ role: "user", content: "Hello" }],
        mode: "invalid",
      });
      expect(result.ok).toBe(false);
    });

    it("rejects messages with content too long", () => {
      const result = validateRequestBody({
        messages: [{ role: "user", content: "x".repeat(500001) }],
      });
      expect(result.ok).toBe(false);
    });

    it("rejects too many messages", () => {
      const messages = Array.from({ length: 101 }, (_, i) => ({
        role: "user" as const,
        content: `Message ${i}`,
      }));
      const result = validateRequestBody({ messages });
      expect(result.ok).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // buildMultipartMessages
  // ---------------------------------------------------------------
  describe("buildMultipartMessages", () => {
    it("passes through text-only messages unchanged", () => {
      const messages = [{ role: "user", content: "Hello" }];
      const result = buildMultipartMessages(messages, []);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Hello");
    });

    it("converts message with images to multimodal format", () => {
      const messages = [
        { role: "user", content: "Analyze this", images: ["data:image/png;base64,abc"] },
      ];
      const result = buildMultipartMessages(messages, []);
      expect(result).toHaveLength(1);
      const content = result[0].content as any[];
      expect(Array.isArray(content)).toBe(true);
      expect(content[0].type).toBe("text");
      expect(content[0].text).toBe("Analyze this");
      expect(content[1].type).toBe("image_url");
    });

    it("prepends top-level images to first user message", () => {
      const messages = [{ role: "user", content: "What is this?" }];
      const topLevelImages = ["data:image/png;base64,abc"];
      const result = buildMultipartMessages(messages, topLevelImages);
      const content = result[0].content as any[];
      expect(Array.isArray(content)).toBe(true);
      expect(content).toHaveLength(2);
      expect(content[1].image_url.url).toContain("data:image/png;base64,abc");
    });

    it("adds data URL prefix to bare base64 images", () => {
      const messages = [
        { role: "user", content: "Analyze", images: ["abc123"] },
      ];
      const result = buildMultipartMessages(messages, []);
      const content = result[0].content as any[];
      expect(content[1].image_url.url).toBe("data:image/png;base64,abc123");
    });

    it("does not modify assistant messages", () => {
      const messages = [
        { role: "assistant", content: "Here is the code" },
        { role: "user", content: "Thanks" },
      ];
      const result = buildMultipartMessages(messages, []);
      expect(result[0].content).toBe("Here is the code");
      expect(result[1].content).toBe("Thanks");
    });

    it("handles multiple images in a single message", () => {
      const messages = [
        {
          role: "user",
          content: "Compare these",
          images: ["img1", "img2", "img3"],
        },
      ];
      const result = buildMultipartMessages(messages, []);
      const content = result[0].content as any[];
      expect(content).toHaveLength(4); // 1 text + 3 images
    });
  });

  // ---------------------------------------------------------------
  // fetchWithProviderRetry — degenerate cold-start flood guard
  // NVIDIA NIM cold-started reasoning models can stream dozens of
  // single-"!" deltas; the peek must reject them so the ladder
  // fails over (or surfaces a warming-up 503) instead of showing
  // "!!!!!!" to the user.
  // ---------------------------------------------------------------
  describe("fetchWithProviderRetry stream peek", () => {
    const sse = (deltas: Array<Record<string, unknown>>): ReadableStream<Uint8Array> => {
      const enc = new TextEncoder();
      const text = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`).join("") + "data: [DONE]\n\n";
      return new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(enc.encode(text)); c.close(); },
      });
    };

    it("rejects a degenerate single-char flood (cold-start kimi-k3)", async () => {
      global.fetch = jest.fn().mockResolvedValue(new Response(sse(Array.from({ length: 32 }, () => ({ reasoning_content: "!" }))), { status: 200 }));
      const result = await fetchWithProviderRetry({ name: "nvidia-test", url: "https://x/v1/chat/completions", apiKey: "k", model: "m" }, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/degenerate cold-start/);
    });

    it("rejects an in-stream provider error object", async () => {
      const enc = new TextEncoder();
      const text = `data: ${JSON.stringify({ error: { message: "ResourceExhausted: worker limit" } })}\n\ndata: [DONE]\n\n`;
      global.fetch = jest.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(text)); c.close(); } }), { status: 200 }));
      const result = await fetchWithProviderRetry({ name: "nvidia-test", url: "https://x/v1/chat/completions", apiKey: "k", model: "m" }, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/in-stream error/);
    });

    it("passes a healthy mixed stream through untouched", async () => {
      global.fetch = jest.fn().mockResolvedValue(new Response(sse([
        { reasoning_content: "The" },
        { reasoning_content: " user" },
        { reasoning_content: " greets" },
        { content: "Hello" },
        { content: "!" },
      ]), { status: 200 }));
      const result = await fetchWithProviderRetry({ name: "nvidia-test", url: "https://x/v1/chat/completions", apiKey: "k", model: "m" }, {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        const text = await new Response(result.stream).text();
        // The replayed window keeps every early delta.
        expect(text).toContain('"reasoning_content":"The"');
        expect(text).toContain('"content":"Hello"');
        expect(text).toContain("[DONE]");
      }
    });

    it("replays the full peek window before the passthrough tail", async () => {
      // Many separate chunks (simulating network chunking) — the peek reads
      // up to 8 and must re-attach ALL of them, not only the first.
      const enc = new TextEncoder();
      const chunks = Array.from({ length: 12 }, (_, i) => enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `c${i} ` } }] })}\n\n`));
      const src = new ReadableStream<Uint8Array>({
        start(c) { for (const ch of chunks) c.enqueue(ch); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); },
      });
      global.fetch = jest.fn().mockResolvedValue(new Response(src, { status: 200 }));
      const result = await fetchWithProviderRetry({ name: "nvidia-test", url: "https://x/v1/chat/completions", apiKey: "k", model: "m" }, {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        const text = await new Response(result.stream).text();
        expect(text).toContain("c0 ");
        expect(text).toContain("c11 ");
      }
    });
  });
});
