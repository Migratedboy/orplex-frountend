/**
 * acceptance-gate.test.ts — plan §7 acceptance-first: a task is only done
 * when every declared acceptance item's `verifiedBy` lane has actually
 * passed. Verified / failed / unverified are three distinct buckets: a known
 * red is not an unknown, and an unknown is never silently promoted to done.
 */
import {
  evaluateAcceptance,
  tallyAcceptance,
  verifyAcceptanceFirst,
  type AcceptanceItem,
} from "../reliability/acceptance-gate";
import type { LaneOutcome } from "../reliability/types";

const LANES: Record<string, LaneOutcome> = {
  typecheck: "pass",
  lint: "pass",
  test: "skipped",
  browser: "pass",
  swarm: "pass",
};

const SPEC: AcceptanceItem[] = [
  { description: "types compile", verifiedBy: "typecheck" },
  { description: "login flow works", verifiedBy: "test", files: ["src/login.test.ts"] },
];

describe("verifyAcceptanceFirst", () => {
  it("passes only when EVERY declared item's lane passed", () => {
    const r = verifyAcceptanceFirst(SPEC, { ...LANES, test: "pass" });
    expect(r.pass).toBe(true);
    expect(r.unverified).toEqual([]);
  });

  it("fails and lists the item when its lane was skipped", () => {
    const r = verifyAcceptanceFirst(SPEC, LANES);
    expect(r.pass).toBe(false);
    expect(r.unverified).toHaveLength(1);
    expect(r.unverified[0].area).toBe("login flow works");
    expect(r.unverified[0].reason).toContain('"test" lane was skipped');
    expect(r.unverified[0].files).toEqual(["src/login.test.ts"]);
  });

  it("fails when a declared lane never ran at all (no result recorded)", () => {
    const r = verifyAcceptanceFirst([{ description: "e2e passes", verifiedBy: "browser" }], {});
    expect(r.pass).toBe(false);
    expect(r.unverified[0].reason).toContain("never ran");
  });

  it("does NOT list a failed lane as unverified — a known failure is carried by the lanes", () => {
    const r = verifyAcceptanceFirst(
      [{ description: "tests pass", verifiedBy: "test" }],
      { test: "fail" },
    );
    expect(r.pass).toBe(false);
    expect(r.unverified).toEqual([]);
  });

  it("an item with no declared lane is unverified — it cannot be proven done", () => {
    const r = verifyAcceptanceFirst([{ description: "mystery criterion", verifiedBy: "" }], LANES);
    expect(r.pass).toBe(false);
    expect(r.unverified[0].reason).toContain("no verification lane was declared");
  });

  it("an unknown outcome value fails closed into unverified", () => {
    const r = verifyAcceptanceFirst(
      [{ description: "x", verifiedBy: "test" }],
      { test: "probably-fine" as unknown as LaneOutcome },
    );
    expect(r.pass).toBe(false);
    expect(r.unverified).toHaveLength(1);
  });

  it("accepts a spec object ({items}) as well as a bare array", () => {
    const r = verifyAcceptanceFirst({ items: [{ description: "types compile", verifiedBy: "typecheck" }] }, LANES);
    expect(r.pass).toBe(true);
  });

  it("an empty/absent spec declares nothing, so nothing is unverified", () => {
    expect(verifyAcceptanceFirst([], LANES)).toEqual({ pass: true, unverified: [] });
    expect(verifyAcceptanceFirst(undefined, LANES)).toEqual({ pass: true, unverified: [] });
    expect(verifyAcceptanceFirst(null, LANES)).toEqual({ pass: true, unverified: [] });
  });

  it("fails CLOSED when a non-empty spec meets missing lanes", () => {
    // No lane data at all + declared items → every item is unverified.
    const r = verifyAcceptanceFirst(SPEC, undefined);
    expect(r.pass).toBe(false);
    expect(r.unverified).toHaveLength(2);
  });
});

describe("tallyAcceptance / evaluateAcceptance", () => {
  it("counts the three buckets and marks completion correctly", () => {
    const spec: AcceptanceItem[] = [
      { description: "a", verifiedBy: "typecheck" },
      { description: "b", verifiedBy: "test" },
      { description: "c", verifiedBy: "browser" },
    ];
    expect(tallyAcceptance(spec, { typecheck: "pass", test: "fail", browser: "skipped" })).toEqual({
      verified: 1,
      failed: 1,
      unverified: 1,
      complete: false,
    });
  });

  it("complete is true only when every item verified", () => {
    const spec: AcceptanceItem[] = [{ description: "a", verifiedBy: "typecheck" }];
    expect(tallyAcceptance(spec, { typecheck: "pass" }).complete).toBe(true);
    expect(tallyAcceptance(spec, { typecheck: "fail" }).complete).toBe(false);
  });

  it("drops malformed items (no description) instead of inventing acceptance", () => {
    const spec = [null, { verifiedBy: "test" }, { description: "real", verifiedBy: "typecheck" }] as unknown as AcceptanceItem[];
    const r = evaluateAcceptance(spec, { typecheck: "pass" });
    expect(r.verified).toBe(1);
    expect(r.unverified).toBe(0);
    expect(r.complete).toBe(true);
  });

  it("keeps the file list on unverified items for the report", () => {
    const r = evaluateAcceptance(
      [{ description: "refunds work", verifiedBy: "test", files: ["src/refund.ts", "src/refund.test.ts"] }],
      { test: "skipped" },
    );
    expect(r.unverifiedItems[0].files).toEqual(["src/refund.ts", "src/refund.test.ts"]);
    // No files → the field stays absent, not an empty list.
    const bare = evaluateAcceptance([{ description: "x", verifiedBy: "test" }], { test: "skipped" });
    expect(bare.unverifiedItems[0].files).toBeUndefined();
  });
});
