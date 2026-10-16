import { checkUserQuota, applyRateLimitHeaders, quotaDayKey, FREE_TIER_DAILY_LIMIT } from "../rate-limiter";

describe("rate-limiter", () => {
  // ---------------------------------------------------------------
  // checkUserQuota
  // ---------------------------------------------------------------
  describe("checkUserQuota", () => {
    it("allows requests when no quota exists", () => {
      const result = checkUserQuota("user-1");
      expect(result.allowed).toBe(true);
      // Single source of truth: signup, the Prisma @default and FREE_TIER all
      // say 1000. This used to silently enforce 50 for a brand-new user whose
      // quota row had not been materialised yet.
      expect(result.limit).toBe(FREE_TIER_DAILY_LIMIT);
      expect(result.remaining).toBe(FREE_TIER_DAILY_LIMIT);
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

describe("quotaDayKey", () => {
  it("rolls over on the UTC day, matching free-tier/quota-manager's today()", () => {
    // The enforcer used local toDateString() while the display/reset path used
    // UTC toISOString(). For any user not on UTC those are two different days,
    // so the daily cap reset twice and the dashboard disagreed with the
    // enforcer. Both must now derive from this one function.
    expect(quotaDayKey(new Date("2026-03-10T23:59:59.000Z"))).toBe("2026-03-10");
    expect(quotaDayKey(new Date("2026-03-11T00:00:00.000Z"))).toBe("2026-03-11");
  });

  it("resets the counter when the stored row is from an earlier UTC day", () => {
    const stale = checkUserQuota("user-2", {
      requestsToday: 999,
      dailyLimit: 1000,
      lastResetAt: new Date("2020-01-01T12:00:00.000Z"),
    });
    expect(stale.remaining).toBe(1000);
    expect(stale.allowed).toBe(true);
  });
});