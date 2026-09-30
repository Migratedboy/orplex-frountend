// tpm-pacer.test.ts — Token-bucket semantics: immediate spend under budget,
// FIFO queueing over budget, priority jumping ahead, and refill over time.
import { acquireTokens, reportUsage, getPacerState, resetPacer, estimateTokensOfMessages } from "@/lib/tpm-pacer";

beforeEach(() => {
  resetPacer(8_000);
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("acquireTokens", () => {
  it("spends immediately while the bucket has room (burst = half window)", async () => {
    await acquireTokens(2_000);
    const s = getPacerState();
    expect(s.available).toBe(8_000 / 2 - 2_000);
    expect(s.queueDepth).toBe(0);
  });

  it("queues requests beyond the burst and releases on refill", async () => {
    await acquireTokens(3_900); // burst nearly exhausted
    const second = acquireTokens(1_000); // must wait for refill
    let resolved = false;
    void second.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(getPacerState().queueDepth).toBe(1);

    // 20s of wall time → 8_000 * (20/60) ≈ 2_666 tokens refill.
    await jest.advanceTimersByTimeAsync(20_000);
    await second;

    expect(resolved).toBe(true);
    expect(getPacerState().queueDepth).toBe(0);
  });

  it("priority waiters are served before batch waiters", async () => {
    await acquireTokens(3_900);
    const order: string[] = [];
    const batch = acquireTokens(2_000).then(() => order.push("batch"));
    const prio = acquireTokens(2_000, true).then(() => order.push("priority"));

    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(30_000); // refill ~4_000 — enough for ONE waiter
    await Promise.all([batch, prio]);

    expect(order[0]).toBe("priority");
  });

  it("caps a single oversized request at the burst capacity (never deadlock)", async () => {
    await acquireTokens(999_999); // clamped to burst = budget/2
    const s = getPacerState();
    expect(s.queueDepth).toBe(0);
    expect(s.totalAcquired).toBe(4_000);
  });
});

describe("reportUsage", () => {
  it("reduces availability", () => {
    const before = getPacerState().available;
    reportUsage(500);
    expect(getPacerState().available).toBe(before - 500);
  });
});

describe("estimateTokensOfMessages", () => {
  it("uses chars/4 like the worker", () => {
    expect(estimateTokensOfMessages([{ content: "x".repeat(40) }, { content: "y".repeat(8) }])).toBe(12);
  });
});
