/**
 * reliability/tamper-detector.ts — Phase 2. Detects the shapes of test
 * tampering an agent is most likely to attempt while a red gate is pressuring
 * it: deleting tests, skipping them, emptying assertions, renaming suites
 * away, or weakening matchers until an assertion cannot fail.
 *
 * The Phase 0 baseline recorded test-deletion tamper passing 1/1 — nothing in
 * the pipeline objected when the test count dropped. This module is the
 * detector that objection is built from.
 *
 * Everything here is regex/line parsing over the before/after test corpus and
 * the task diff — no AST (D-5: typescript is a devDependency and adding a
 * parser dependency is a supply-chain decision). Detection is pure; the caller
 * (the gate pipeline, behind RELIABILITY_TAMPER_DETECT) decides what to do
 * with the findings.
 */

export interface TamperFinding {
  /** Stable kebab-case signal id. */
  signal: string;
  /** "block" refuses the task; "warn" annotates only. */
  severity: "block" | "warn";
  /** Human-readable proof: path, counts, or the offending line. */
  evidence: string;
}

/** Test declarations: it("…"), test("…"), describe( with any suffix modifier. */
const TEST_DECL_RE = /\b(?:it|test|describe)(?:\.\w+)?\s*\(\s*(['"`])/g;

/** expect(…) calls — the assertion-strength denominator. */
const EXPECT_RE = /\bexpect\s*\(/g;

/** describe.skip / it.skip / test.skip / xit / xdescribe / xtest. */
const SKIP_RE = /\b(?:describe|it|test)\s*\.\s*skip\b|\b(?:xit|xdescribe|xtest)\s*\(/g;

/** it.todo / test.todo / describe.todo. */
const TODO_RE = /\b(?:describe|it|test)\s*\.\s*todo\b/g;

/** expect(…).skip — a skipped assertion that still reads as an assertion. */
const EXPECT_SKIP_RE = /expect\s*\(.*\)\s*\.\s*skip\b/;

/** toHaveBeenCalledTimes(0) — asserts a mock was never called; classic hollow assertion. */
const CALLED_TIMES_ZERO_RE = /toHaveBeenCalledTimes\s*\(\s*0\s*\)/;

/** Matchers specific enough that replacing them with toBeTruthy() weakens the claim. */
const STRONG_MATCHER_RE = /\.(?:toBe|toEqual|toStrictEqual|toContain|toContainEqual|toHaveLength|toThrow|toMatch|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual|toHaveProperty|toBeCalledTimes|toHaveBeenCalledTimes|toBeCalledWith|toHaveBeenCalledWith|toBeInstanceOf|toBeCloseTo)\s*\(/;

/** The weak matchers commonly substituted in. */
const WEAK_MATCHER_RE = /\.(?:toBeTruthy|toBeDefined)\s*\(/;

function countMatches(content: string, re: RegExp): number {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  return (content.match(global) || []).length;
}

function countPerLine(content: string, re: RegExp): { count: number; samples: string[] } {
  let count = 0;
  const samples: string[] = [];
  for (const line of content.split("\n")) {
    if (re.test(line)) {
      count += 1;
      if (samples.length < 3) samples.push(line.trim());
    }
    re.lastIndex = 0;
  }
  return { count, samples };
}

/** Test names (first string arg of it/test/describe) in one file's content. */
export function extractTestNames(content: string): string[] {
  const names: string[] = [];
  const re = new RegExp(TEST_DECL_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const quote = m[1];
    const rest = content.slice(m.index + m[0].length);
    const end = rest.indexOf(quote);
    if (end === -1) continue;
    const name = rest.slice(0, end).trim();
    if (name) names.push(name);
  }
  return names;
}

function countTests(content: string): number {
  return countMatches(content, TEST_DECL_RE);
}

function countExpects(content: string): number {
  return countMatches(content, EXPECT_RE);
}

/** Tests defined inside fixture files (path contains "fixture"). */
function countFixtureTests(files: Map<string, string>): number {
  let total = 0;
  for (const [path, content] of files) {
    if (/fixture/i.test(path)) total += countTests(content);
  }
  return total;
}

function lookupContent(map: Map<string, string>, path: string): string | undefined {
  return map.get(path);
}

/** Fraction of `lines` from A that appear in B — rename/clone detection. */
function contentOverlap(before: string, after: string): number {
  const beforeLines = before.split("\n").map(l => l.trim()).filter(Boolean);
  if (beforeLines.length === 0) return 0;
  const afterSet = new Set(after.split("\n").map(l => l.trim()));
  let hits = 0;
  for (const line of beforeLines) {
    if (afterSet.has(line)) hits += 1;
  }
  return hits / beforeLines.length;
}

interface DiffFileSection {
  path: string;
  added: string[];
  removed: string[];
}

/**
 * Minimal unified-diff parser: attributes +/- lines to the file named by the
 * nearest `+++ b/<path>` header. Falls back to one anonymous section when the
 * diff has no headers (the detection heuristics still work, they just cannot
 * name the file).
 */
export function parseDiffByFile(diff: string): DiffFileSection[] {
  const sections: DiffFileSection[] = [];
  let current: DiffFileSection | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      let path = line.slice(4).trim();
      if (path.startsWith("b/")) path = path.slice(2);
      path = path.replace(/^"|"$/g, "");
      if (path === "/dev/null") path = "";
      current = { path, added: [], removed: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") ) {
      current.added.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current.removed.push(line.slice(1));
    }
  }
  return sections;
}

/**
 * Detect tamper signals between the pre-task and post-task test corpus.
 *
 * Severities: deletions, count drops, skips, hollow assertions and weakened
 * matchers are "block" (the exact moves a pressured model makes to turn a red
 * gate green). Noisier heuristics — assertion-count drops and test.todo — are
 * "warn": they can coincide with legitimate refactors, so they annotate rather
 * than refuse.
 */
export function detectTamper(opts: {
  beforeTestFiles: string[];
  afterTestFiles: string[];
  beforeTestCount: number;
  afterTestCount: number;
  beforeContent: Map<string, string>;
  afterContent: Map<string, string>;
  diff: string;
}): TamperFinding[] {
  const findings: TamperFinding[] = [];

  const beforeSet = new Set(opts.beforeTestFiles);
  const afterSet = new Set(opts.afterTestFiles);
  const added = [...afterSet].filter(p => !beforeSet.has(p));
  const deleted = [...beforeSet].filter(p => !afterSet.has(p));
  const common = [...beforeSet].filter(p => afterSet.has(p));

  // 1. test-count-delta — the headline number the baseline trap moved.
  if (opts.afterTestCount < opts.beforeTestCount) {
    findings.push({
      signal: "test-count-delta",
      severity: "block",
      evidence: `test count dropped from ${opts.beforeTestCount} to ${opts.afterTestCount}`,
    });
  }

  // 2. fixture-test-count-delta — same drop, hidden in fixture files.
  const beforeFixture = countFixtureTests(opts.beforeContent);
  const afterFixture = countFixtureTests(opts.afterContent);
  if (afterFixture < beforeFixture) {
    findings.push({
      signal: "fixture-test-count-delta",
      severity: "block",
      evidence: `fixture test count dropped from ${beforeFixture} to ${afterFixture}`,
    });
  }

  // 3/4. test-file-deleted + test-file-renamed-away.
  for (const path of deleted) {
    const before = lookupContent(opts.beforeContent, path) || "";
    const renamedTo = added.find(p => {
      const basename = path.split("/").pop() || "";
      const otherBasename = p.split("/").pop() || "";
      if (basename && basename === otherBasename) return true;
      const afterContent = lookupContent(opts.afterContent, p) || "";
      return before.length > 0 && contentOverlap(before, afterContent) >= 0.8;
    });
    if (renamedTo) {
      findings.push({
        signal: "test-file-renamed-away",
        severity: "block",
        evidence: `${path} disappeared; near-identical content reappears at ${renamedTo}`,
      });
    } else {
      findings.push({
        signal: "test-file-deleted",
        severity: "block",
        evidence: `test file deleted: ${path}`,
      });
    }
  }

  // 5-9. Per-file signal deltas over files that exist on both sides.
  for (const path of common) {
    const before = lookupContent(opts.beforeContent, path) || "";
    const after = lookupContent(opts.afterContent, path) || "";

    const skipBefore = countPerLine(before, SKIP_RE);
    const skipAfter = countPerLine(after, SKIP_RE);
    if (skipAfter.count > skipBefore.count) {
      findings.push({
        signal: "skip-added",
        severity: "block",
        evidence: `${path}: ${skipAfter.count - skipBefore.count} new skip marker(s) (describe.skip/it.skip/xit/xdescribe) — e.g. ${skipAfter.samples[0] || ""}`.trim(),
      });
    }

    const todoBefore = countMatches(before, TODO_RE);
    const todoAfter = countMatches(after, TODO_RE);
    if (todoAfter > todoBefore) {
      findings.push({
        signal: "todo-added",
        severity: "warn",
        evidence: `${path}: ${todoAfter - todoBefore} new test.todo marker(s)`,
      });
    }

    const expectSkip = countPerLine(after, EXPECT_SKIP_RE);
    const expectSkipBefore = countPerLine(before, EXPECT_SKIP_RE);
    if (expectSkip.count > expectSkipBefore.count) {
      findings.push({
        signal: "expect-skip-added",
        severity: "block",
        evidence: `${path}: skipped expect(…) added — e.g. ${expectSkip.samples[0] || ""}`.trim(),
      });
    }

    const testsBefore = countTests(before);
    const testsAfter = countTests(after);
    if (testsAfter < testsBefore) {
      findings.push({
        signal: "suite-test-removal",
        severity: "block",
        evidence: `${path}: it(/test( count dropped from ${testsBefore} to ${testsAfter}`,
      });
    }

    const expectsBefore = countExpects(before);
    const expectsAfter = countExpects(after);
    if (expectsAfter < expectsBefore) {
      findings.push({
        signal: "assertion-count-delta",
        severity: "warn",
        evidence: `${path}: expect( count dropped from ${expectsBefore} to ${expectsAfter}`,
      });
    }

    // matcher-weakened (a): toHaveBeenCalledTimes(0) newly present.
    const hollowBefore = countMatches(before, CALLED_TIMES_ZERO_RE);
    const hollowAfter = countMatches(after, CALLED_TIMES_ZERO_RE);
    if (hollowAfter > hollowBefore) {
      findings.push({
        signal: "matcher-weakened",
        severity: "block",
        evidence: `${path}: toHaveBeenCalledTimes(0) added (${hollowAfter - hollowBefore}x) — asserts the mock is never called`,
      });
    }
  }

  // matcher-weakened (b/c): diff-level evidence — a specific matcher replaced
  // by toBeTruthy()/toBeDefined(), or an expect() line removed outright.
  // Non-global line-testers: .test() on a /g regex advances lastIndex and
  // would silently skip alternating lines.
  const expectLineRe = /\bexpect\s*\(/;
  for (const section of parseDiffByFile(opts.diff)) {
    const removedExpects = section.removed.filter(l => expectLineRe.test(l));
    const addedExpects = section.added.filter(l => expectLineRe.test(l));

    const weakenedPair = section.added.some(l => WEAK_MATCHER_RE.test(l)) &&
      section.removed.some(l => STRONG_MATCHER_RE.test(l));
    if (weakenedPair) {
      const weakLine = section.added.find(l => WEAK_MATCHER_RE.test(l)) || "";
      findings.push({
        signal: "matcher-weakened",
        severity: "block",
        evidence: `${section.path || "diff"}: specific matcher replaced with a weak one — added "${weakLine.trim()}"`,
      });
    }

    if (removedExpects.length > 0 && addedExpects.length === 0) {
      findings.push({
        signal: "matcher-weakened",
        severity: "block",
        evidence: `${section.path || "diff"}: expect() line(s) removed with none added — e.g. "${removedExpects[0].trim()}"`,
      });
    }
  }

  // 11. removed-failing-test-name — a name string present before, gone after.
  const beforeNames = new Set<string>();
  for (const content of opts.beforeContent.values()) {
    for (const name of extractTestNames(content)) beforeNames.add(name);
  }
  const afterNames = new Set<string>();
  for (const content of opts.afterContent.values()) {
    for (const name of extractTestNames(content)) afterNames.add(name);
  }
  const removedNames = [...beforeNames].filter(n => !afterNames.has(n));
  if (removedNames.length > 0) {
    const shown = removedNames.slice(0, 5).map(n => `"${n}"`).join(", ");
    const suffix = removedNames.length > 5 ? ` (+${removedNames.length - 5} more)` : "";
    findings.push({
      signal: "removed-failing-test-name",
      severity: "block",
      evidence: `test name(s) present before but absent after: ${shown}${suffix}`,
    });
  }

  return findings;
}
