import {
  classifyTier,
  routeToModel,
  TIER_MODELS,
  logCost,
  getCostStats,
  type Tier,
} from "../model-router";

describe("model-router", () => {
  // ---------------------------------------------------------------
  // classifyTier
  // ---------------------------------------------------------------
  describe("classifyTier", () => {
    it("classifies simple greetings as Tier 1", () => {
      const signals = {
        wordCount: 2,
        hasCodeKeywords: false,
        hasMultiFileKeywords: false,
        hasArchitectureKeywords: false,
        hasSecurityKeywords: false,
        hasToolCalls: false,
        messageCount: 1,
        hasExistingCode: false,
      };
      expect(classifyTier(signals)).toBe(1);
    });

    it("classifies code keywords as Tier 2", () => {
      const signals = {
        wordCount: 10,
        hasCodeKeywords: true,
        hasMultiFileKeywords: false,
        hasArchitectureKeywords: false,
        hasSecurityKeywords: false,
        hasToolCalls: false,
        messageCount: 1,
        hasExistingCode: false,
      };
      expect(classifyTier(signals)).toBe(2);
    });

    it("classifies architecture keywords as Tier 3", () => {
      const signals = {
        wordCount: 20,
        hasCodeKeywords: true,
        hasMultiFileKeywords: false,
        hasArchitectureKeywords: true,
        hasSecurityKeywords: false,
        hasToolCalls: false,
        messageCount: 1,
        hasExistingCode: false,
      };
      expect(classifyTier(signals)).toBe(3);
    });

    it("classifies security + multi-file keywords as Tier 3", () => {
      const signals = {
        wordCount: 20,
        hasCodeKeywords: false,
        hasMultiFileKeywords: true,
        hasArchitectureKeywords: false,
        hasSecurityKeywords: true,
        hasToolCalls: false,
        messageCount: 1,
        hasExistingCode: false,
      };
      expect(classifyTier(signals)).toBe(3);
    });

    it("classifies long code conversations as Tier 3", () => {
      const signals = {
        wordCount: 10,
        hasCodeKeywords: true,
        hasMultiFileKeywords: false,
        hasArchitectureKeywords: false,
        hasSecurityKeywords: false,
        hasToolCalls: false,
        messageCount: 11,
        hasExistingCode: false,
      };
      expect(classifyTier(signals)).toBe(3);
    });

    it("classifies tool calls as Tier 2", () => {
      const signals = {
        wordCount: 5,
        hasCodeKeywords: false,
        hasMultiFileKeywords: false,
        hasArchitectureKeywords: false,
        hasSecurityKeywords: false,
        hasToolCalls: true,
        messageCount: 1,
        hasExistingCode: false,
      };
      expect(classifyTier(signals)).toBe(2);
    });

    it("classifies existing code in messages as Tier 2", () => {
      const signals = {
        wordCount: 5,
        hasCodeKeywords: false,
        hasMultiFileKeywords: false,
        hasArchitectureKeywords: false,
        hasSecurityKeywords: false,
        hasToolCalls: false,
        messageCount: 1,
        hasExistingCode: true,
      };
      expect(classifyTier(signals)).toBe(2);
    });

    it("classifies long prompts as Tier 2", () => {
      const signals = {
        wordCount: 35,
        hasCodeKeywords: false,
        hasMultiFileKeywords: false,
        hasArchitectureKeywords: false,
        hasSecurityKeywords: false,
        hasToolCalls: false,
        messageCount: 1,
        hasExistingCode: false,
      };
      expect(classifyTier(signals)).toBe(2);
    });
  });

  // ---------------------------------------------------------------
  // routeToModel
  // ---------------------------------------------------------------
  describe("routeToModel", () => {
    it("routes simple messages to Tier 1", () => {
      const result = routeToModel("hello");
      expect(result.tier).toBe(1);
      expect(result.model).toBe(TIER_MODELS[1]);
      expect(result.estimatedCost).toBe(0);
    });

    it("routes code messages to Tier 2", () => {
      const result = routeToModel("implement a React component");
      expect(result.tier).toBe(2);
      expect(result.model).toBe(TIER_MODELS[2]);
    });

    it("routes architecture messages to Tier 3", () => {
      const result = routeToModel(
        "Design the architecture for a microservice event-driven system",
      );
      expect(result.tier).toBe(3);
      expect(result.model).toBe(TIER_MODELS[3]);
    });

    it("forces a specific tier when forceTier is provided", () => {
      const result = routeToModel("hello", [], 3);
      expect(result.tier).toBe(3);
      expect(result.model).toBe(TIER_MODELS[3]);
    });

    it("includes reasoning in the result", () => {
      const result = routeToModel("implement a new API route");
      expect(result.reason).toContain("Tier");
      expect(result.reason).toContain("code keywords");
    });

    it("handles empty messages array", () => {
      const result = routeToModel("hello", []);
      expect(result.tier).toBe(1);
    });

    it("handles messages with tool_call content", () => {
      const messages = [
        { role: "assistant", content: '{"tool_call": "write_file"}' },
      ];
      const result = routeToModel("continue", messages);
      expect(result.tier).toBe(2);
    });
  });

  // ---------------------------------------------------------------
  // Cost tracking
  // ---------------------------------------------------------------
  describe("cost tracking", () => {
    it("logs costs and returns stats", () => {
      // logCost is append-only; just verify it doesn't throw
      logCost(1, 100, "test task");
      logCost(2, 200, "code generation");

      const stats = getCostStats();
      expect(stats.totalCost).toBe(0); // All models are free tier
      expect(stats.byTier[1].calls).toBeGreaterThanOrEqual(1);
      expect(stats.byTier[2].calls).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------
  // TIER_MODELS config
  // ---------------------------------------------------------------
  describe("TIER_MODELS", () => {
    it("has all three tiers defined", () => {
      expect(TIER_MODELS[1]).toBeDefined();
      expect(TIER_MODELS[2]).toBeDefined();
      expect(TIER_MODELS[3]).toBeDefined();
    });

    it("each tier has required fields", () => {
      for (const tier of [1, 2, 3] as Tier[]) {
        const model = TIER_MODELS[tier];
        expect(model.tier).toBe(tier);
        expect(model.name).toBeTruthy();
        expect(model.model).toBeTruthy();
        expect(model.baseUrl).toBeTruthy();
        expect(model.maxTokens).toBeGreaterThan(0);
        expect(model.temperature).toBeGreaterThan(0);
        expect(model.temperature).toBeLessThanOrEqual(1);
      }
    });

    it("tiers increase in temperature", () => {
      expect(TIER_MODELS[1].temperature).toBeLessThanOrEqual(
        TIER_MODELS[2].temperature,
      );
    });
  });
});
