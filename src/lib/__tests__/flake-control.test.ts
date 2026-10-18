/**
 * flake-control.test.ts — Phase 2 outcome parsing, the rerun budget, and the
 * quarantine registry's fail-then-pass rule.
 */
import {
  FlakeRegistry,
  classifyTestOutcome,
  shouldRerun,
  FLAKE_MAX_RERUNS,
  type FlakeEntry,
} from "../reliability/flake-control";

describe("FLAKE_MAX_RERUNS", () => {
  it("is the plan's budget of 2", () => {
    expect(FLAKE_MAX_RERUNS).toBe(2);
  });
});

describe("classifyTestOutcome — jest text summary", () => {
  it("parses a clean run", () => {
    const raw = [
      "PASS src/lib/a.test.ts",
      "Tests:       0 failed, 12 passed, 12 total",
    ].join("\n");
    expect(classifyTestOutcome(raw, 0)).toEqual({ flaky: false, failures: 0, passes: 12 });
  });

  it("parses a failing run", () => {
    const raw = "Tests:       2 failed, 10 passed, 12 total";
    expect(classifyTestOutcome(raw, 0)).toEqual({ flaky: false, failures: 2, passes: 10 });
  });

  it("classifies fail-then-pass across rerun summaries as flaky", () => {
    const raw = [
      "Tests:       1 failed, 11 passed, 12 total",
      "Tests:       0 failed, 12 passed, 12 total",
    ].join("\n");
    expect(classifyTestOutcome(raw, 1)).toEqual({ flaky: true, failures: 0, passes: 12 });
  });

  it("classifies the same test name marked both ✕ and ✓ as flaky", () => {
    const raw = [
      "✕ computes total (3 ms)",
      "✓ computes total (1 ms)",
      "Tests:       0 failed, 1 passed, 1 total",
    ].join("\n");
    expect(classifyTestOutcome(raw, 1)).toEqual({ flaky: true, failures: 0, passes: 1 });
  });

  it("reports the latest attempt's counts once older attempts fall outside the budget", () => {
    const raw = [
      "Tests:       5 failed, 0 passed, 5 total", // stale, outside budget
      "Tests:       0 failed, 12 passed, 12 total",
      "Tests:       1 failed, 11 passed, 12 total", // latest
    ].join("\n");
    // reruns=1 → only the last 2 attempts count; latest has 1 failure.
    expect(classifyTestOutcome(raw, 1)).toEqual({ flaky: false, failures: 1, passes: 11 });
  });

  it("returns zeros for unparseable input (caller must treat as unknown)", () => {
    expect(classifyTestOutcome("segmentation fault", 0)).toEqual({ flaky: false, failures: 0, passes: 0 });
    expect(classifyTestOutcome("", 0)).toEqual({ flaky: false, failures: 0, passes: 0 });
  });
});

describe("classifyTestOutcome — jest --json", () => {
  it("parses the summary counters", () => {
    const raw = JSON.stringify({ numFailedTests: 1, numPassedTests: 9 });
    expect(classifyTestOutcome(raw, 0)).toEqual({ flaky: false, failures: 1, passes: 9 });
  });

  it("parses per-assertion statuses when summary counters are absent", () => {
    const raw = JSON.stringify({
      testResults: [
        {
          assertionResults: [
            { status: "passed" },
            { status: "failed" },
            { status: "passed" },
          ],
        },
      ],
    });
    expect(classifyTestOutcome(raw, 0)).toEqual({ flaky: false, failures: 1, passes: 2 });
  });

  it("parses an array of run attempts (original + rerun)", () => {
    const raw = JSON.stringify([
      { numFailedTests: 1, numPassedTests: 11 },
      { numFailedTests: 0, numPassedTests: 12 },
    ]);
    expect(classifyTestOutcome(raw, 1)).toEqual({ flaky: true, failures: 0, passes: 12 });
  });
});

describe("shouldRerun", () => {
  it("reruns failures while budget remains", () => {
    expect(shouldRerun(1, 0, FLAKE_MAX_RERUNS)).toBe(true);
    expect(shouldRerun(1, 1, FLAKE_MAX_RERUNS)).toBe(true);
  });

  it("stops at the budget and never reruns a pass", () => {
    expect(shouldRerun(1, 2, FLAKE_MAX_RERUNS)).toBe(false);
    expect(shouldRerun(1, 3, FLAKE_MAX_RERUNS)).toBe(false);
    expect(shouldRerun(0, 0, FLAKE_MAX_RERUNS)).toBe(false);
  });
});

describe("FlakeRegistry", () => {
  const entry = (over: Partial<FlakeEntry>): FlakeEntry => ({
    testPath: "src/lib/a.test.ts",
    testName: "works",
    failures: 0,
    passes: 1,
    at: 1000,
    ...over,
  });

  it("does not quarantine a test that only ever passed or only ever failed", () => {
    const r = new FlakeRegistry();
    r.add(entry({}));
    expect(r.isQuarantined("src/lib/a.test.ts")).toBe(false);

    const r2 = new FlakeRegistry();
    r2.add(entry({ failures: 1, passes: 0 }));
    expect(r2.isQuarantined("src/lib/a.test.ts")).toBe(false);
    expect(r2.isQuarantined("never-seen.test.ts")).toBe(false);
  });

  it("quarantines a test that failed once and passed once (the flake signature)", () => {
    const r = new FlakeRegistry();
    r.add(entry({ failures: 1, passes: 0, at: 1 }));
    r.add(entry({ failures: 0, passes: 1, at: 2 }));
    expect(r.isQuarantined("src/lib/a.test.ts")).toBe(true);
    expect(r.quarantinedPaths()).toEqual(["src/lib/a.test.ts"]);
  });

  it("also quarantines a single mixed entry (aggregated rerun output)", () => {
    const r = new FlakeRegistry();
    r.add(entry({ failures: 1, passes: 1 }));
    expect(r.isQuarantined("src/lib/a.test.ts")).toBe(true);
  });

  it("accumulates counters across entries and keeps the latest timestamp", () => {
    const r = new FlakeRegistry();
    r.add(entry({ failures: 1, passes: 0, at: 5 }));
    r.add(entry({ failures: 0, passes: 2, at: 9 }));
    expect(r.stats("src/lib/a.test.ts")).toEqual({ failures: 1, passes: 2, lastAt: 9 });
    expect(r.size).toBe(2);
  });

  it("round-trips through toJSON/fromJSON (string and object payloads)", () => {
    const r = new FlakeRegistry();
    r.add(entry({ failures: 1, passes: 0, at: 1 }));
    r.add(entry({ failures: 0, passes: 1, at: 2 }));
    r.add(entry({ testPath: "src/b.test.ts", testName: "other", failures: 1, passes: 0, at: 3 }));

    const json = r.toJSON();
    expect(json.version).toBe(1);
    expect(json.entries).toHaveLength(3);

    const fromString = FlakeRegistry.fromJSON(JSON.stringify(json));
    expect(fromString.isQuarantined("src/lib/a.test.ts")).toBe(true);
    expect(fromString.isQuarantined("src/b.test.ts")).toBe(false);
    expect(fromString.toJSON()).toEqual(json);

    const fromObject = FlakeRegistry.fromJSON(json);
    expect(fromObject.toJSON()).toEqual(json);
  });

  it("skips malformed entries and rejects malformed payloads", () => {
    const partial = FlakeRegistry.fromJSON({
      version: 1,
      entries: [{ testPath: "ok.test.ts", testName: "n", failures: 1, passes: 1, at: 1 }, { nope: true }],
    });
    expect(partial.isQuarantined("ok.test.ts")).toBe(true);
    expect(partial.size).toBe(1);

    expect(() => FlakeRegistry.fromJSON('{"version":1}')).toThrow();
    expect(() => FlakeRegistry.fromJSON("not json")).toThrow();
  });
});
