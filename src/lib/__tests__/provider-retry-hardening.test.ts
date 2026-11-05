// provider-retry-hardening.test.ts — The chat provider ladder must fail fast
// on dead keys, respect a global deadline, and never hang the client; and
// modelVariants must be safe on junk input.

import {
  fetchWithProviderRetry,
  ladderDelayMs,
  modelVariants,
  type ProviderConfig,
} from "../chat-middleware";

// Deferred-response helpers --------------------------------------------------

let fetchMock: jest.Mock;

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(body)}\n\n`));
        c.close();
      },
    }),
  };
}

const provider: ProviderConfig = {
  name: "test-provider",
  url: "https://x.test/v1/chat/completions",
  apiKey: "k",
  model: "m",
};

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  delete (global as { fetch?: unknown }).fetch;
});

  // Fast pacing for ladder tests: production defaults are 20 attempts with a
  // 1s→30s exponential backoff — real waits would blow Jest's timeout. The
  // opts override that the code exposes for exactly this.
  const FAST = { baseDelayMs: 0, deadlineMs: 15_000 } as const;

  describe("fetchWithProviderRetry — hardening", () => {
    it("fails fast on 401 without burning retries", async () => {
      fetchMock.mockResolvedValue(jsonRes(401, { error: { message: "bad key" } }));
      const r = await fetchWithProviderRetry(provider, { model: "m" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/key rejected/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("fails fast on 403 without burning retries", async () => {
      fetchMock.mockResolvedValue(jsonRes(403, { error: { message: "forbidden" } }));
      const r = await fetchWithProviderRetry(provider, { model: "m" });
      expect(r.ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries 5xx then succeeds and returns a stream", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonRes(500, { error: { message: "boom" } }))
        .mockResolvedValueOnce(jsonRes(200, { choices: [{ message: { content: "ok" } }] }));
      const r = await fetchWithProviderRetry(provider, { model: "m" }, FAST);
      expect(r.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries a 408 (provider timed the request out) then succeeds", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonRes(408, { error: { message: "timeout" } }))
        .mockResolvedValueOnce(jsonRes(200, { choices: [{ message: { content: "ok" } }] }));
      const r = await fetchWithProviderRetry(provider, { model: "m" }, FAST);
      expect(r.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("gives up after max attempts with the last error", async () => {
      fetchMock.mockResolvedValue(jsonRes(500, { error: { message: "still down" } }));
      const r = await fetchWithProviderRetry(provider, { model: "m" }, { ...FAST, attempts: 8 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/still down|HTTP 500/);
      // Exactly the attempt ceiling — maxAttempts bounds the ladder, the
      // deadline is NOT what stops it here (15s of fast rungs is plenty).
      expect(fetchMock.mock.calls.length).toBe(8);
    });

    it("climbs the full 20-attempt default ladder and the deadline stops it", async () => {
      // Production pacing: every rung double the last (100, 200, 400, 800 …ms
      // here) until the wall-clock deadline calls the whole ladder off.
      fetchMock.mockResolvedValue(jsonRes(500, { error: { message: "down" } }));
      jest.useFakeTimers();
      const pending = fetchWithProviderRetry(provider, { model: "m" }, {
        baseDelayMs: 100,
        deadlineMs: 4_000,
      });
      // Drive the retry timers (each iterations fires one rung's wait).
      for (let i = 0; i < 50; i++) await jest.advanceTimersByTimeAsync(250);
      const r = await pending;
      jest.useRealTimers();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/attempt budget exhausted/);
      // Several rungs burned, but the request ceiling (20) was never the
      // binding constraint — the deadline was.
      expect(fetchMock.mock.calls.length).toBeGreaterThan(3);
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(20);
    });

    it("treats an empty body as a failure, not success", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => "",
        body: new ReadableStream({ start(c) { c.close(); } }),
      });
      const r = await fetchWithProviderRetry(provider, { model: "m" });
      expect(r.ok).toBe(false);
    });
  });

  describe("ladderDelayMs — the exponential shape", () => {
    it("doubles every rung, caps at the ceiling, and never stops growing early", () => {
      // Jitter frozen to 0 so the rungs are exact.
      const zero = jest.spyOn(Math, "random").mockReturnValue(0);
      try {
        // 1s → 2s → 4s → 8s → 16s: every retry waits LONGER, as required.
        expect([1, 2, 3, 4, 5].map((a) => ladderDelayMs(a, 1_000, 30_000)))
          .toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
        // From rung 6 doubling exceeds the ceiling: capped at 30s from then on.
        expect(ladderDelayMs(6, 1_000, 30_000)).toBe(30_000);
        expect(ladderDelayMs(99, 1_000, 30_000)).toBe(30_000);
      } finally {
        zero.mockRestore();
      }
    });

    it("a Retry-After hint can only push a rung LONGER, never shorter", () => {
      const zero = jest.spyOn(Math, "random").mockReturnValue(0);
      try {
        // A 60s hint on an early rung: honored, then capped at the 60s wall.
        expect(ladderDelayMs(3, 1_000, 30_000, 60)).toBe(60_000);
        // A SHORT hint (2s) on a late 30s rung must NOT shrink the ladder —
        // max(doubling, hint) keeps every rung at least its exponential size.
        expect(ladderDelayMs(10, 1_000, 30_000, 2)).toBe(30_000);
      } finally {
        zero.mockRestore();
      }
    });
  });

describe("modelVariants — edge cases", () => {
  it("returns [] for empty/whitespace ids", () => {
    expect(modelVariants("")).toEqual([]);
    expect(modelVariants("   ")).toEqual([]);
  });

  it("downgrades paid -> free but NEVER upgrades free -> paid without consent", () => {
    // Paid -> free is always allowed: it can only cost the user quota, never
    // money, and it keeps a paid id answering when the paid route is throttled.
    expect(modelVariants("openai/gpt-x")).toEqual(["openai/gpt-x", "openai/gpt-x:free"]);
    expect(modelVariants(" model-x ")).toEqual(["model-x", "model-x:free"]);

    // Free -> paid spends the USER'S OWN MONEY. It used to happen silently:
    // pick a `:free` model, hit OpenRouter's free capacity, and the ladder
    // quietly served the paid id and charged them.
    expect(modelVariants("openai/gpt-x:free")).toEqual(["openai/gpt-x:free"]);
  });

  it("allows the paid upgrade only when a caller explicitly opts in", () => {
    expect(modelVariants("openai/gpt-x:free", { allowPaidUpgrade: true })).toEqual([
      "openai/gpt-x:free",
      "openai/gpt-x",
    ]);
  });
});
