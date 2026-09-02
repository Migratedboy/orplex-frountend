import {
  validateRequestBody,
  buildMultipartMessages,
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
});
