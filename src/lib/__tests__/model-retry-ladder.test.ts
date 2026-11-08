/**
 * model-retry-ladder.test.ts — pins the MODEL RESPONSE retry budget.
 *
 * LIVE FAIL this fixes: the worker retried a transient provider blip exactly
 * once (2 attempts, 1.5s apart) and then failed the turn — the UI showed
 * "The response failed" ~15s in, while the server-side provider ladder over
 * the same provider had 20 attempts available. The budget is now 20 and each
 * retry is labelled `[attempt N/20]`, so the counter must never drift back to
 * a single retry.
 */
import {
  MODEL_RESPONSE_ATTEMPTS,
  MODEL_RETRY_MAX_DELAY_MS,
  modelAttemptLabel,
  modelRetryCountdownSeconds,
  modelRetryDelayMs,
} from "../model-retry-ladder";

describe("MODEL_RESPONSE_ATTEMPTS", () => {
  it("allows 20 attempts per model turn, not the old 2", () => {
    expect(MODEL_RESPONSE_ATTEMPTS).toBe(20);
  });
});

describe("modelRetryDelayMs", () => {
  it("waits 2s longer on every attempt — the rate-limit window needs to roll over", () => {
    expect(modelRetryDelayMs(1)).toBe(2_000);
    expect(modelRetryDelayMs(2)).toBe(4_000);
    expect(modelRetryDelayMs(3)).toBe(6_000);
    expect(modelRetryDelayMs(4)).toBe(8_000);
  });

  it("is strictly increasing until the 30s ceiling", () => {
    for (let n = 2; n <= 15; n++) {
      expect(modelRetryDelayMs(n)).toBeGreaterThan(modelRetryDelayMs(n - 1));
    }
    expect(modelRetryDelayMs(15)).toBe(MODEL_RETRY_MAX_DELAY_MS);
    expect(modelRetryDelayMs(19)).toBe(MODEL_RETRY_MAX_DELAY_MS);
  });

  it("never returns a negative or NaN delay", () => {
    for (const n of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const ms = modelRetryDelayMs(n);
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
    }
  });
});

describe("modelRetryCountdownSeconds", () => {
  it("reports the whole seconds the UI counts down", () => {
    expect(modelRetryCountdownSeconds(1)).toBe(2);
    expect(modelRetryCountdownSeconds(2)).toBe(4);
    expect(modelRetryCountdownSeconds(3)).toBe(6);
    expect(modelRetryCountdownSeconds(15)).toBe(30);
    expect(modelRetryCountdownSeconds(20)).toBe(30);
  });
});

describe("modelAttemptLabel", () => {
  it("formats the counter the feed shows", () => {
    expect(modelAttemptLabel(1)).toBe("[attempt 1/20]");
    expect(modelAttemptLabel(2)).toBe("[attempt 2/20]");
    expect(modelAttemptLabel(20)).toBe("[attempt 20/20]");
  });

  it("never shows a 0th attempt", () => {
    expect(modelAttemptLabel(0)).toBe("[attempt 1/20]");
  });
});
