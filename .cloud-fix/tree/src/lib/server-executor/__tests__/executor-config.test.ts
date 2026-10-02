// executor-config.test.ts — Pure executor config: concurrency clamp and the
// AI_FAILOVER chain parser (primary excluded, unknown providers excluded,
// keyless providers excluded — a chain entry without a key is a lie).
import { maxConcurrentRuns, parseFailoverChain, FAILOVER_KEY_ENV } from "../executor-config";

describe("maxConcurrentRuns", () => {
  it("auto-sizes when unset: ≤10GB → 2, ≤16GB → 3, else 5 (CI hosts are big)", () => {
    // CI/dev machines in this suite report their real totalmem; assert the
    // contract rather than a fixed number.
    const gb = require("os").totalmem() / 1024 ** 3;
    const expected = gb <= 10 ? 2 : gb <= 16 ? 3 : 5;
    expect(maxConcurrentRuns(undefined)).toBe(expected);
    expect(maxConcurrentRuns("")).toBe(expected);
  });

  it("accepts the opt-in 2-3 range", () => {
    expect(maxConcurrentRuns("2")).toBe(2);
    expect(maxConcurrentRuns("3")).toBe(3);
  });

  it("hard-clamps above 3 — 8GB RAM ceiling, not a suggestion", () => {
    expect(maxConcurrentRuns("8")).toBe(3);
    expect(maxConcurrentRuns("100")).toBe(3);
  });

  it("falls back to the auto-sized default on garbage", () => {
    const gb = require("os").totalmem() / 1024 ** 3;
    const expected = gb <= 10 ? 2 : gb <= 16 ? 3 : 5;
    expect(maxConcurrentRuns("zero")).toBe(expected);
    expect(maxConcurrentRuns("0")).toBe(expected);
    expect(maxConcurrentRuns("-2")).toBe(expected);
    expect(maxConcurrentRuns("2.9")).toBe(2); // explicit decimals still floor
  });
});

describe("parseFailoverChain", () => {
  const env = { NVIDIA_API_KEY: "k", GROQ_API_KEY: "k" };

  it("returns empty for unset/empty chain", () => {
    expect(parseFailoverChain(undefined, "nvidia", env)).toEqual([]);
    expect(parseFailoverChain("", "nvidia", env)).toEqual([]);
  });

  it("keeps order and skips the primary", () => {
    expect(parseFailoverChain("groq,openrouter", "nvidia", env)).toEqual(["groq"]);
    expect(parseFailoverChain("groq", "groq", env)).toEqual([]);
  });

  it("skips providers without keys configured", () => {
    expect(parseFailoverChain("groq,openrouter", "nvidia", env)).toEqual(["groq"]);
  });

  it("skips unknown provider names", () => {
    expect(parseFailoverChain("together,groq", "nvidia", env)).toEqual(["groq"]);
  });

  it("handles whitespace and dedupes nothing silently", () => {
    expect(parseFailoverChain(" groq , groq ", "nvidia", env)).toEqual(["groq", "groq"]);
  });

  it("exposes the key env map for docs/tests", () => {
    expect(FAILOVER_KEY_ENV.groq).toBe("GROQ_API_KEY");
  });
});
