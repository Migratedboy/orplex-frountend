import { estimateCost, estimateCostFromTotal, formatCost, MODEL_COST_RATES } from "../cost-estimator";

describe("estimateCost", () => {
  it("returns 0 for zero tokens", () => {
    expect(estimateCost(0, 0)).toBe(0);
  });

  it("weights output tokens more heavily than input for the default model", () => {
    const inputOnly = estimateCost(1_000_000, 0);
    const outputOnly = estimateCost(0, 1_000_000);
    expect(outputOnly).toBeGreaterThan(inputOnly);
    expect(inputOnly).toBeCloseTo(MODEL_COST_RATES.default.input);
    expect(outputOnly).toBeCloseTo(MODEL_COST_RATES.default.output);
  });

  it("uses the named model's rates when available", () => {
    const cost = estimateCost(1_000_000, 0, "meta/llama-3.1-8b-instruct");
    expect(cost).toBeCloseTo(MODEL_COST_RATES["meta/llama-3.1-8b-instruct"].input);
  });

  it("falls back to default rates for unknown models", () => {
    const known = estimateCost(500_000, 500_000, "made-up/model");
    const fallback = estimateCost(500_000, 500_000);
    expect(known).toBeCloseTo(fallback);
  });
});

describe("estimateCostFromTotal", () => {
  it("splits a total into 70/30 and stays consistent with estimateCost", () => {
    const total = 100_000;
    const fromTotal = estimateCostFromTotal(total);
    const split = estimateCost(total * 0.7, total * 0.3);
    expect(fromTotal).toBeCloseTo(split, 10);
  });

  it("scales linearly", () => {
    const small = estimateCostFromTotal(10_000);
    const large = estimateCostFromTotal(100_000);
    expect(large).toBeCloseTo(small * 10, 10);
  });
});

describe("formatCost", () => {
  it("formats zero as $0", () => {
    expect(formatCost(0)).toBe("$0");
  });

  it("uses 4 decimals for sub-cent costs", () => {
    expect(formatCost(0.0042)).toBe("$0.0042");
  });

  it("uses 2 decimals at a cent and above", () => {
    expect(formatCost(1.256)).toBe("$1.26");
  });
});
