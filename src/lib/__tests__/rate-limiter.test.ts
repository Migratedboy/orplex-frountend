import { checkUserQuota, applyRateLimitHeaders } from "../rate-limiter";

describe("rate-limiter", () => {
  // ---------------------------------------------------------------
  // checkUserQuota
  // ---------------------------------------------------------------
  describe("checkUserQuota", () => {
    it("allows requests when no quota exists", () => {
      const result = checkUserQuota("user-1");
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(50);
      expect(result.remaining).toBe(50);
    });

    it("allows requests within daily limit", () => {
      const result = checkUserQuota("user-1", {
        requestsToday: 10,
        dailyLimit: 50,
        lastResetAt: new Date(),
      });
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(40);
    });

    it("blocks requests when daily limit is reached", () => {
      const result = checkUserQuota("user-1", {
        requestsToday: 50,
        dailyLimit: 50,
        lastResetAt: new Date(),
      });
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("resets counter on a new day", () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const result = checkUserQuota("user-1", {
        requestsToday: 50,
        dailyLimit: 50,
        lastResetAt: yesterday,
      });
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(50);
    });

    it("allows requests with custom daily limit", () => {
      const result = checkUserQuota("user-1", {
        requestsToday: 99,
        dailyLimit: 100,
        lastResetAt: new Date(),
      });
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });

    it("blocks when custom limit is exactly reached", () => {
      const result = checkUserQuota("user-1", {
        requestsToday: 100,
        dailyLimit: 100,
        lastResetAt: new Date(),
      });
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // applyRateLimitHeaders
  // ---------------------------------------------------------------
  describe("applyRateLimitHeaders", () => {
    it("adds rate limit headers to response", () => {
      const originalResponse = new Response("ok", { status: 200 });
      const result = applyRateLimitHeaders(originalResponse, {
        remaining: 15,
        resetAt: Date.now() + 60000,
      });

      expect(result.headers.get("X-RateLimit-Remaining")).toBe("15");
      expect(result.headers.get("X-RateLimit-Reset")).toBeTruthy();
    });

    it("preserves original response status", () => {
      const originalResponse = new Response("error", { status: 404 });
      const result = applyRateLimitHeaders(originalResponse, {
        remaining: 0,
        resetAt: Date.now() + 60000,
      });

      expect(result.status).toBe(404);
      expect(result.headers.get("X-RateLimit-Remaining")).toBe("0");
    });
  });
});
