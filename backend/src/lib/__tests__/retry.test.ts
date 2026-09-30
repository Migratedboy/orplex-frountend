// retry.test.ts — Rate-limit classification, Retry-After extraction, and
// backoff behavior that honors server hints.
import { isRateLimitError, retryAfterMs, withRetry, isTransientError } from "../retry";

describe("isRateLimitError", () => {
  it("matches 429 and quota/TPM/RPM shapes", () => {
    expect(isRateLimitError(new Error("LLM API error: 429"))).toBe(true);
    expect(isRateLimitError(new Error("Groq HTTP 429: Rate limit reached ... TPM: Limit 8000"))).toBe(true);
    expect(isRateLimitError(new Error("quota exceeded for model"))).toBe(true);
    expect(isRateLimitError(new Error("Too Many Requests"))).toBe(true);
  });

  it("does not match other failures", () => {
    expect(isRateLimitError(new Error("LLM API error: 500"))).toBe(false);
    expect(isRateLimitError(new Error("invalid api key"))).toBe(false);
    expect(isRateLimitError(new Error("ECONNRESET"))).toBe(false);
  });
});

describe("isTransientError", () => {
  it("still treats 429 as transient (retry in place)", () => {
    expect(isTransientError(new Error("HTTP 429"))).toBe(true);
    expect(isTransientError(new Error("HTTP 503"))).toBe(true);
  });
});

describe("retryAfterMs", () => {
  it("extracts a seconds hint and caps it at 30s", () => {
    expect(retryAfterMs(new Error('429 {"error":{"retry-after":"7"}}'))).toBe(7000);
    expect(retryAfterMs(new Error("Retry-After: 120"))).toBe(30_000);
  });

  it("returns null when absent or garbage", () => {
    expect(retryAfterMs(new Error("plain 429"))).toBeNull();
    expect(retryAfterMs(new Error("retry-after: banana"))).toBeNull();
  });
});

describe("withRetry honors Retry-After", () => {
  it("waits roughly the hinted delay before the retry", async () => {
    let calls = 0;
    const start = Date.now();
    const out = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error('429 retry-after: "1"');
        return "ok";
      },
      { attempts: 2, baseDelayMs: 5000, silent: true },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(2);
    // Hint is 1s; without it, the 5s base with jitter would typically be ≥2.5s.
    expect(Date.now() - start).toBeLessThan(2500);
  }, 10_000);
});
