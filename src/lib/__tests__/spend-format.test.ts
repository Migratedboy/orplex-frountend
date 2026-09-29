import {
  chartScale,
  dailySpendBars,
  sortSpendRuns,
  spendAggregates,
  spendRunCostUsd,
  splitIsPartial,
  summarizeUptime,
  uptimeHealth,
  SpendRun,
  UptimeEvent,
} from "../spend-format";

function run(overrides: Partial<SpendRun> = {}): SpendRun {
  return {
    id: "r1",
    createdAt: "2026-09-25T10:00:00Z",
    totalTokens: 0,
    promptTokens: null,
    completionTokens: null,
    provider: null,
    model: "",
    status: "done",
    ...overrides,
  };
}

describe("sortSpendRuns", () => {
  it("drops zero-token runs and sorts oldest to newest", () => {
    const sorted = sortSpendRuns([
      run({ id: "late", createdAt: "2026-09-25T12:00:00Z", totalTokens: 100 }),
      run({ id: "zero", totalTokens: 0 }),
      run({ id: "early", createdAt: "2026-09-24T08:00:00Z", totalTokens: 50 }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["early", "late"]);
  });

  it("pushes malformed timestamps last instead of NaN-sorting them away", () => {
    const sorted = sortSpendRuns([
      run({ id: "bad", createdAt: "not-a-date", totalTokens: 10 }),
      run({ id: "good", createdAt: "2026-09-25T10:00:00Z", totalTokens: 10 }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["good", "bad"]);
  });
});

describe("spendRunCostUsd", () => {
  it("uses the shared estimator and grows with tokens", () => {
    expect(spendRunCostUsd({ totalTokens: 0, model: "" })).toBe(0);
    const small = spendRunCostUsd({ totalTokens: 10_000, model: "" });
    const large = spendRunCostUsd({ totalTokens: 100_000, model: "" });
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });
});

describe("spendAggregates", () => {
  it("sums tokens, split, and cost across runs", () => {
    const agg = spendAggregates([
      run({ totalTokens: 1000, promptTokens: 700, completionTokens: 300 }),
      run({ totalTokens: 500, promptTokens: 350, completionTokens: 150 }),
    ]);
    expect(agg.runCount).toBe(2);
    expect(agg.totalTokens).toBe(1500);
    expect(agg.promptTokens).toBe(1050);
    expect(agg.completionTokens).toBe(450);
    expect(agg.estimatedCostUsd).toBeCloseTo(
      spendRunCostUsd({ totalTokens: 1000, model: "" }) + spendRunCostUsd({ totalTokens: 500, model: "" }),
      10,
    );
  });

  it("treats runs without a split as unknown-split (partial)", () => {
    const agg = spendAggregates([run({ totalTokens: 2000, promptTokens: null, completionTokens: null })]);
    expect(agg.totalTokens).toBe(2000);
    expect(agg.promptTokens).toBe(0);
    expect(splitIsPartial(agg)).toBe(true);
  });

  it("reports a complete split as not partial", () => {
    const agg = spendAggregates([run({ totalTokens: 1000, promptTokens: 700, completionTokens: 300 })]);
    expect(splitIsPartial(agg)).toBe(false);
  });

  it("handles empty history", () => {
    const agg = spendAggregates([]);
    expect(agg).toEqual({ runCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 });
    expect(splitIsPartial(agg)).toBe(false);
  });
});

describe("dailySpendBars", () => {
  it("groups runs per day and emits zero rows for gap days", () => {
    const bars = dailySpendBars(
      sortSpendRuns([
        run({ id: "a", createdAt: "2026-09-23T10:00:00Z", totalTokens: 300, promptTokens: 210, completionTokens: 90 }),
        run({ id: "b", createdAt: "2026-09-25T11:00:00Z", totalTokens: 500 }),
      ]),
    );
    expect(bars.map((b) => b.day)).toEqual(["2026-09-23", "2026-09-24", "2026-09-25"]);
    expect(bars[0].tokens).toBe(300);
    expect(bars[0].runCount).toBe(1);
    expect(bars[1]).toMatchObject({ tokens: 0, costUsd: 0, runCount: 0 });
    expect(bars[2].tokens).toBe(500);
  });

  it("sums multiple runs on the same day", () => {
    const bars = dailySpendBars(
      sortSpendRuns([
        run({ id: "a", createdAt: "2026-09-25T08:00:00Z", totalTokens: 100 }),
        run({ id: "b", createdAt: "2026-09-25T09:00:00Z", totalTokens: 250 }),
      ]),
    );
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ tokens: 350, runCount: 2 });
  });

  it("returns [] for empty input", () => {
    expect(dailySpendBars([])).toEqual([]);
  });
});

describe("chartScale", () => {
  const bars = [{ tokens: 100 }, { tokens: 300 }, { tokens: 0 }];

  it("maps the max bar to peak height and scales proportionally", () => {
    const scale = chartScale(bars, 120);
    expect(scale.maxTokens).toBe(300);
    expect(scale.heightFor(300)).toBe(120);
    expect(scale.heightFor(100)).toBe(40);
  });

  it("keeps zero-token bars at zero and nonzero bars at >= 1px", () => {
    const scale = chartScale(bars, 120);
    expect(scale.heightFor(0)).toBe(0);
    expect(scale.heightFor(1)).toBeGreaterThanOrEqual(1);
  });

  it("is flat-safe: all-zero or empty data yields height 0, never NaN", () => {
    expect(chartScale([], 100).heightFor(50)).toBe(0);
    expect(chartScale([{ tokens: 0 }], 100).heightFor(0)).toBe(0);
  });
});

describe("summarizeUptime", () => {
  const NOW = Date.parse("2026-09-29T12:00:00Z");

  function ev(overrides: Partial<UptimeEvent> = {}): UptimeEvent {
    return {
      lane: "chat",
      provider: "nvidia",
      model: "nvidia/m1",
      outcome: "ok",
      errorKind: null,
      createdAt: "2026-09-29T10:00:00Z",
      ...overrides,
    };
  }

  it("aggregates per provider and per model with success rate", () => {
    const s = summarizeUptime(
      [
        ev(),
        ev({ outcome: "error", errorKind: "rate_limit", model: "nvidia/m2" }),
        ev({ model: "nvidia/m2" }),
        ev({ provider: "openrouter", model: "or/x:free", lane: "server_run" }),
      ],
      7,
      NOW,
    );
    const nvidia = s.providers.find((p) => p.provider === "nvidia");
    expect(nvidia).toBeDefined();
    expect(nvidia!.ok).toBe(2);
    expect(nvidia!.errors).toBe(1);
    expect(nvidia!.successPct).toBe(67);
    const m2 = nvidia!.models.find((m) => m.model === "nvidia/m2");
    expect(m2).toMatchObject({ ok: 1, errors: 1, errorKinds: { rate_limit: 1 } });
    expect(s.totalOk).toBe(3);
    expect(s.totalErrors).toBe(1);
  });

  it("drops events older than the window and malformed timestamps", () => {
    const s = summarizeUptime(
      [
        ev({ createdAt: "2026-09-01T10:00:00Z" }), // 28 days old
        ev({ createdAt: "garbage" }),
        ev({ createdAt: "2026-09-28T10:00:00Z" }), // in window
      ],
      7,
      NOW,
    );
    expect(s.providers).toHaveLength(1);
    expect(s.totalOk).toBe(1);
    expect(s.totalErrors).toBe(0);
  });

  it("counts error kinds with the most frequent first", () => {
    const s = summarizeUptime(
      [
        ev({ outcome: "error", errorKind: "server" }),
        ev({ outcome: "error", errorKind: "rate_limit" }),
        ev({ outcome: "error", errorKind: "rate_limit" }),
        ev({ outcome: "error", errorKind: null }), // falls back to "error"
      ],
      7,
      NOW,
    );
    const kinds = Object.keys(s.providers[0].models[0].errorKinds);
    expect(kinds).toEqual(["rate_limit", "server", "error"]);
    expect(s.providers[0].successPct).toBe(0);
  });

  it("sorts providers healthiest-first (fewest errors, then busiest, then name)", () => {
    const s = summarizeUptime(
      [
        ev({ provider: "zeta" }),
        ev({ provider: "alpha", outcome: "error" }),
        ev({ provider: "mid", outcome: "error" }),
        ev({ provider: "mid" }),
        ev({ provider: "mid" }),
      ],
      7,
      NOW,
    );
    expect(s.providers.map((p) => p.provider)).toEqual(["zeta", "mid", "alpha"]);
  });

  it("handles empty and all-outside-window input", () => {
    expect(summarizeUptime([], 7, NOW)).toEqual({ providers: [], windowDays: 7, totalOk: 0, totalErrors: 0 });
    const s = summarizeUptime([ev({ createdAt: "2020-01-01T00:00:00Z" })], 7, NOW);
    expect(s.providers).toEqual([]);
  });
});

describe("uptimeHealth", () => {
  it("maps success rates to traffic lights", () => {
    expect(uptimeHealth(100)).toBe("green");
    expect(uptimeHealth(95)).toBe("green");
    expect(uptimeHealth(94)).toBe("amber");
    expect(uptimeHealth(80)).toBe("amber");
    expect(uptimeHealth(79)).toBe("red");
    expect(uptimeHealth(0)).toBe("red");
    expect(uptimeHealth(null)).toBe("none");
  });
});
