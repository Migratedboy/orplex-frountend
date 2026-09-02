import { isModelAllowed, getTierLimits, FREE_TIER, PRO_TIER } from "../free-tier/quota-manager";

describe("quota-manager", () => {
  // ---------------------------------------------------------------
  // Tier constants
  // ---------------------------------------------------------------
  describe("FREE_TIER constants", () => {
    it("has correct daily limit", () => {
      expect(FREE_TIER.DAILY_LIMIT).toBe(50);
    });

    it("has correct max tokens per prompt", () => {
      expect(FREE_TIER.MAX_TOKENS_PER_PROMPT).toBe(4096);
    });

    it("only allows minimax-m3", () => {
      expect(FREE_TIER.ALLOWED_MODELS).toEqual(["minimax-m3"]);
    });

    it("has correct max file uploads", () => {
      expect(FREE_TIER.MAX_FILE_UPLOADS).toBe(5);
    });

    it("has correct max messages per conversation", () => {
      expect(FREE_TIER.MAX_MESSAGES_PER_CONVERSATION).toBe(50);
    });
  });

  describe("PRO_TIER constants", () => {
    it("has unlimited daily limit", () => {
      expect(PRO_TIER.DAILY_LIMIT).toBe(Infinity);
    });

    it("has higher max tokens", () => {
      expect(PRO_TIER.MAX_TOKENS_PER_PROMPT).toBe(16384);
    });

    it("allows all models", () => {
      expect(PRO_TIER.ALLOWED_MODELS).toEqual(["*"]);
    });
  });

  // ---------------------------------------------------------------
  // isModelAllowed
  // ---------------------------------------------------------------
  describe("isModelAllowed", () => {
    it("allows minimax-m3 on free tier", () => {
      expect(isModelAllowed("minimax-m3", "free")).toBe(true);
    });

    it("blocks other models on free tier", () => {
      expect(isModelAllowed("gpt-4o", "free")).toBe(false);
      expect(isModelAllowed("claude-sonnet-4-20250514", "free")).toBe(false);
    });

    it("allows all models on pro tier", () => {
      expect(isModelAllowed("gpt-4o", "pro")).toBe(true);
      expect(isModelAllowed("claude-sonnet-4-20250514", "pro")).toBe(true);
      expect(isModelAllowed("minimax-m3", "pro")).toBe(true);
    });

    it("allows all models on team tier", () => {
      expect(isModelAllowed("gpt-4o", "team")).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // getTierLimits
  // ---------------------------------------------------------------
  describe("getTierLimits", () => {
    it("returns FREE_TIER for free", () => {
      expect(getTierLimits("free")).toBe(FREE_TIER);
    });

    it("returns PRO_TIER for pro", () => {
      expect(getTierLimits("pro")).toBe(PRO_TIER);
    });

    it("returns PRO_TIER for team", () => {
      expect(getTierLimits("team")).toBe(PRO_TIER);
    });
  });
});
