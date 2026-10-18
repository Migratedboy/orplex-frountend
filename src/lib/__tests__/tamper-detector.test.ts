/**
 * tamper-detector.test.ts — Phase 2. Each of the 11 signals gets a positive
 * case (the tamper it must catch) and the clean diff must yield no findings.
 */
import { detectTamper, extractTestNames, parseDiffByFile } from "../reliability/tamper-detector";

type Finding = { signal: string; severity: "block" | "warn"; evidence: string };

const KEEP = "describe('suite', () => { it('works', () => { expect(1).toBe(1); }); });";

function run(opts: {
  beforeFiles?: string[];
  afterFiles?: string[];
  beforeCount?: number;
  afterCount?: number;
  beforeContent?: Map<string, string>;
  afterContent?: Map<string, string>;
  diff?: string;
}): Finding[] {
  const beforeContent = opts.beforeContent || new Map<string, string>();
  const afterContent = opts.afterContent || new Map<string, string>();
  return detectTamper({
    beforeTestFiles: opts.beforeFiles ?? [...beforeContent.keys()],
    afterTestFiles: opts.afterFiles ?? [...afterContent.keys()],
    beforeTestCount: opts.beforeCount ?? 0,
    afterTestCount: opts.afterCount ?? 0,
    beforeContent,
    afterContent,
    diff: opts.diff ?? "",
  });
}

describe("detectTamper — clean corpus yields no findings", () => {
  it("is silent when nothing changed", () => {
    const content = new Map([["src/a.test.ts", KEEP]]);
    expect(run({ beforeContent: content, afterContent: content, beforeCount: 1, afterCount: 1 })).toEqual([]);
  });

  it("is silent when tests were ADDED", () => {
    const before = new Map([["src/a.test.ts", KEEP]]);
    const after = new Map([["src/a.test.ts", KEEP + " it('extra', () => {});"]]);
    expect(run({ beforeContent: before, afterContent: after, beforeCount: 1, afterCount: 2 })).toEqual([]);
  });
});

describe("detectTamper — test-count-delta", () => {
  it("blocks when the aggregate test count dropped", () => {
    const findings = run({ beforeCount: 10, afterCount: 7 });
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "test-count-delta", severity: "block", evidence: expect.stringContaining("10 to 7") })
    );
  });
});

describe("detectTamper — fixture-test-count-delta", () => {
  it("blocks when tests defined in fixture files dropped", () => {
    const before = new Map([
      ["src/__fixtures__/cases.ts", "it('case a', () => {}); it('case b', () => {});"],
      ["src/a.test.ts", KEEP],
    ]);
    const after = new Map([
      ["src/__fixtures__/cases.ts", "it('case a', () => {});"],
      ["src/a.test.ts", KEEP],
    ]);
    const findings = run({ beforeContent: before, afterContent: after, beforeCount: 3, afterCount: 2 });
    expect(findings).toContainEqual(expect.objectContaining({ signal: "fixture-test-count-delta", severity: "block" }));
  });
});

describe("detectTamper — test-file-deleted / test-file-renamed-away", () => {
  it("blocks a deleted test file", () => {
    const before = new Map([["src/old.test.ts", KEEP]]);
    const findings = run({ beforeContent: before, afterContent: new Map(), beforeCount: 1, afterCount: 0 });
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "test-file-deleted", evidence: expect.stringContaining("src/old.test.ts") })
    );
  });

  it("flags a rename (same basename reappearing) as renamed-away, not deleted", () => {
    const before = new Map([["src/__tests__/old.test.ts", KEEP]]);
    const after = new Map([["src/renamed/old.test.ts", KEEP]]);
    const findings = run({ beforeContent: before, afterContent: after, beforeCount: 1, afterCount: 1 });
    expect(findings).toContainEqual(expect.objectContaining({ signal: "test-file-renamed-away", severity: "block" }));
    expect(findings.some(f => f.signal === "test-file-deleted")).toBe(false);
  });

  it("flags a content-identical clone at a new path as renamed-away", () => {
    const before = new Map([["src/a.test.ts", KEEP]]);
    const after = new Map([["src/b.test.ts", KEEP]]);
    const findings = run({ beforeContent: before, afterContent: after, beforeCount: 1, afterCount: 1 });
    expect(findings).toContainEqual(expect.objectContaining({ signal: "test-file-renamed-away" }));
  });
});

describe("detectTamper — skip/todo/expect-skip additions", () => {
  it("blocks newly added describe.skip / it.skip / xit / xdescribe", () => {
    for (const marker of ["describe.skip(", "it.skip(", "xit(", "xdescribe("]) {
      const before = new Map([["src/a.test.ts", KEEP]]);
      const after = new Map([["src/a.test.ts", KEEP + `\n${marker}'nope', () => {});`]]);
      const findings = run({ beforeContent: before, afterContent: after, beforeCount: 1, afterCount: 1 });
      expect(findings).toContainEqual(expect.objectContaining({ signal: "skip-added", severity: "block" }));
    }
  });

  it("warns on newly added test.todo", () => {
    const before = new Map([["src/a.test.ts", KEEP]]);
    const after = new Map([["src/a.test.ts", KEEP + "\nit.todo('later');"]]);
    const findings = run({ beforeContent: before, afterContent: after, beforeCount: 1, afterCount: 1 });
    expect(findings).toContainEqual(expect.objectContaining({ signal: "todo-added", severity: "warn" }));
  });

  it("blocks expect(...).skip", () => {
    const before = new Map([["src/a.test.ts", KEEP]]);
    const after = new Map([["src/a.test.ts", "describe('s', () => { it('w', () => { expect(1).toBe(1).skip; }); });"]]);
    const findings = run({ beforeContent: before, afterContent: after, beforeCount: 1, afterCount: 1 });
    expect(findings).toContainEqual(expect.objectContaining({ signal: "expect-skip-added", severity: "block" }));
  });
});

describe("detectTamper — suite-test-removal (it(/test( count dropped in one file)", () => {
  it("blocks when a single file loses tests even if the aggregate count is unchanged", () => {
    const before = new Map([["src/a.test.ts", "it('one', () => {}); it('two', () => {});"]]);
    const after = new Map([["src/a.test.ts", "it('one', () => {});"]]);
    const findings = run({ beforeContent: before, afterContent: after, beforeCount: 2, afterCount: 2 });
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "suite-test-removal", evidence: expect.stringContaining("2 to 1") })
    );
  });
});

describe("detectTamper — assertion-count-delta", () => {
  it("warns when expect( count dropped inside an existing file", () => {
    const before = new Map([["src/a.test.ts", "it('w', () => { expect(1).toBe(1); expect(2).toBe(2); });"]]);
    const after = new Map([["src/a.test.ts", "it('w', () => { expect(1).toBe(1); });"]]);
    const findings = run({ beforeContent: before, afterContent: after, beforeCount: 1, afterCount: 1 });
    expect(findings).toContainEqual(expect.objectContaining({ signal: "assertion-count-delta", severity: "warn" }));
  });
});

describe("detectTamper — matcher-weakened", () => {
  it("blocks toHaveBeenCalledTimes(0) newly added", () => {
    const before = new Map([["src/a.test.ts", KEEP]]);
    const after = new Map([["src/a.test.ts", KEEP + "\nexpect(fn).toHaveBeenCalledTimes(0);"]]);
    const findings = run({ beforeContent: before, afterContent: after, beforeCount: 1, afterCount: 1 });
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "matcher-weakened", evidence: expect.stringContaining("toHaveBeenCalledTimes(0)") })
    );
  });

  it("blocks a specific matcher replaced by toBeTruthy() (from the diff)", () => {
    const diff = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "--- a/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "@@ -1,1 +1,1 @@",
      "-expect(result.status).toBe(200);",
      "+expect(result.status).toBeTruthy();",
    ].join("\n");
    const content = new Map([["src/a.test.ts", KEEP]]);
    const findings = run({ beforeContent: content, afterContent: content, beforeCount: 1, afterCount: 1, diff });
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "matcher-weakened", evidence: expect.stringContaining("toBeTruthy") })
    );
  });

  it("blocks an expect line removed with none added (from the diff)", () => {
    const diff = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "--- a/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "@@ -1,2 +1,1 @@",
      "-expect(user.name).toBe('ada');",
      " expect(user.age).toBe(30);",
    ].join("\n");
    const content = new Map([["src/a.test.ts", KEEP]]);
    const findings = run({ beforeContent: content, afterContent: content, beforeCount: 1, afterCount: 1, diff });
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "matcher-weakened", evidence: expect.stringContaining("expect() line(s) removed") })
    );
  });

  it("does not flag a same-line reformat that keeps a strong matcher", () => {
    const diff = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "--- a/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "@@ -1,1 +1,1 @@",
      "-expect(x).toBe(1);",
      "+expect(x).toBe(1); // clarified",
    ].join("\n");
    const content = new Map([["src/a.test.ts", KEEP]]);
    const findings = run({ beforeContent: content, afterContent: content, beforeCount: 1, afterCount: 1, diff });
    expect(findings.some(f => f.signal === "matcher-weakened")).toBe(false);
  });
});

describe("detectTamper — removed-failing-test-name", () => {
  it("blocks when a test name present before is absent after", () => {
    const before = new Map([["src/a.test.ts", "it('handles empty cart', () => {});"]]);
    const after = new Map([["src/a.test.ts", "it('other', () => {});"]]);
    const findings = run({ beforeContent: before, afterContent: after, beforeCount: 1, afterCount: 1 });
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "removed-failing-test-name", evidence: expect.stringContaining("handles empty cart") })
    );
  });

  it("does not fire when the name merely moved to another file", () => {
    const before = new Map([["src/a.test.ts", "it('handles empty cart', () => {});"]]);
    const after = new Map([["src/b.test.ts", "it('handles empty cart', () => {});"]]);
    const findings = run({ beforeContent: before, afterContent: after, beforeCount: 1, afterCount: 1, diff: "" });
    // The rename signals may fire; the NAME survives, so name-removal must not.
    expect(findings.some(f => f.signal === "removed-failing-test-name")).toBe(false);
  });
});

describe("helpers", () => {
  it("extractTestNames reads the first string arg of it/test/describe", () => {
    expect(extractTestNames("it('a', f); test(\"b\", f); describe(`c`, f);")).toEqual(["a", "b", "c"]);
  });

  it("parseDiffByFile attributes +/- lines to the +++ header path", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "+only-added",
    ].join("\n");
    const sections = parseDiffByFile(diff);
    expect(sections).toEqual([
      { path: "src/a.ts", added: ["new"], removed: ["old"] },
      { path: "src/b.ts", added: ["only-added"], removed: [] },
    ]);
  });
});
