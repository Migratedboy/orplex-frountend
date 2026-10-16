// format-tokens.test.ts — the "~210k → ~22k" labels on the compaction divider.
//
// These are ESTIMATES (the app sizes context with a chars/4 heuristic), so the
// contract that matters is that it never implies precision it does not have.

import { formatTokens, formatTokenDelta } from "../format-tokens";

describe("formatTokens", () => {
  it("matches the spec's examples exactly", () => {
    expect(formatTokens(210_000)).toBe("~210k");
    expect(formatTokens(22_000)).toBe("~22k");
    expect(formatTokens(1_200_000)).toBe("~1.2M");
  });

  it("keeps sub-1000 counts as plain numbers", () => {
    expect(formatTokens(0)).toBe("~0");
    expect(formatTokens(1)).toBe("~1");
    expect(formatTokens(842)).toBe("~842");
    expect(formatTokens(999)).toBe("~999");
  });

  it("rounds at the thousands boundary", () => {
    expect(formatTokens(1_000)).toBe("~1k");
    expect(formatTokens(1_049)).toBe("~1k");
    expect(formatTokens(1_500)).toBe("~2k");
  });

  it("uses thousands separators so 1.05M is not read as 1,200k", () => {
    expect(formatTokens(1_050_000)).toBe("~1.1M");
    expect(formatTokens(210_000)).toBe("~210k");
  });

  it("never emits a trailing .0", () => {
    expect(formatTokens(2_000_000)).toBe("~2M");
    expect(formatTokens(3_400_000)).toBe("~3.4M");
  });

  it("handles the millions range without floating-point noise", () => {
    expect(formatTokens(1_250_000)).toBe("~1.3M");
    expect(formatTokens(12_000_000)).toBe("~12M");
  });

  it("degrades safely on junk input", () => {
    expect(formatTokens(Number.NaN)).toBe("~0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("~0");
    expect(formatTokens(-500)).toBe("~0");
  });

  it("can drop the approximation marker when a count is exact", () => {
    expect(formatTokens(210_000, false)).toBe("210k");
    expect(formatTokens(842, false)).toBe("842");
  });
});

describe("formatTokenDelta", () => {
  it("renders real → after with the arrow", () => {
    expect(formatTokenDelta(210_000, 22_000)).toBe("~210k → ~22k");
  });
});