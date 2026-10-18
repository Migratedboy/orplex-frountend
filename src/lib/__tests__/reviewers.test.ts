/**
 * reviewers.test.ts — Phase 7's parallel isolated cross-family review: the
 * panel spans different model families (the audit's bug was one reviewer on
 * the coder's own weights), prompts are focus-isolated, findings carry
 * executable repro evidence, and consensus fails CLOSED — never the
 * strategy-router.ts:328 "error reads as consensus" behaviour.
 */
import {
  REVIEWER_PANEL,
  buildReviewerPrompts,
  mergeReviewFindings,
  type ReviewerProfile,
  type ReviewFinding,
} from "../reliability/reviewers";

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

describe("REVIEWER_PANEL", () => {
  it("has at least 4 profiles spanning DIFFERENT model families", () => {
    expect(REVIEWER_PANEL.length).toBeGreaterThanOrEqual(4);
    const families = new Set(REVIEWER_PANEL.map((p) => p.family));
    expect(families.size).toBeGreaterThanOrEqual(4);
  });

  it("has unique ids and a non-empty focus per profile", () => {
    const ids = REVIEWER_PANEL.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(REVIEWER_PANEL.every((p) => p.focus.trim().length > 0)).toBe(true);
  });

  it("covers the four plan focuses: correctness, security, performance, API contract", () => {
    const focuses = REVIEWER_PANEL.map((p) => p.focus.toLowerCase()).join(" | ");
    expect(focuses).toContain("correctness");
    expect(focuses).toContain("security");
    expect(focuses).toContain("performance");
    expect(focuses).toContain("api contract");
  });
});

// ---------------------------------------------------------------------------
// Prompt building — isolation is the point
// ---------------------------------------------------------------------------

describe("buildReviewerPrompts", () => {
  const TASK = "add a retry helper";
  const DIFF = "created src/retry.ts with backoff logic";

  it("emits one prompt per panel profile, keyed by profileId", () => {
    const prompts = buildReviewerPrompts(TASK, DIFF);
    expect(prompts.map((p) => p.profileId)).toEqual(REVIEWER_PANEL.map((p) => p.id));
  });

  it("each prompt carries its focus, the task, the diff, and the finding contract", () => {
    for (const { profileId, prompt } of buildReviewerPrompts(TASK, DIFF)) {
      const profile = REVIEWER_PANEL.find((p) => p.id === profileId)!;
      expect(prompt.toLowerCase()).toContain(profile.focus.toLowerCase());
      expect(prompt).toContain(`Task: ${TASK}`);
      expect(prompt).toContain(DIFF);
      expect(prompt).toContain('"findings"');
      expect(prompt).toContain("reproTest");
      expect(prompt).toContain("confidence");
    }
  });

  it("ISOLATED: a prompt never mentions another reviewer's focus", () => {
    const prompts = buildReviewerPrompts(TASK, DIFF);
    for (const me of prompts) {
      for (const other of REVIEWER_PANEL) {
        if (other.id === me.profileId) continue;
        // Other focuses must not appear anywhere in my prompt — not even as a
        // "don't look at X" instruction, which would still prime the reviewer.
        expect(me.prompt.toLowerCase()).not.toContain(other.focus.toLowerCase());
      }
    }
  });

  it("respects an explicit panel argument (risk tiering picks the count)", () => {
    const panel: ReviewerProfile[] = REVIEWER_PANEL.slice(0, 3);
    const prompts = buildReviewerPrompts(TASK, DIFF, panel);
    expect(prompts).toHaveLength(3);
    expect(prompts.map((p) => p.profileId)).toEqual(panel.map((p) => p.id));
  });

  it("handles an unknown focus with a generic scoped instruction", () => {
    const prompts = buildReviewerPrompts(TASK, DIFF, [{ id: "docs", family: "xai", focus: "documentation" }]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain("documentation");
    expect(prompts[0].prompt).toContain("Report nothing outside this scope");
  });

  it("is deterministic — same inputs, same prompts", () => {
    expect(buildReviewerPrompts(TASK, DIFF)).toEqual(buildReviewerPrompts(TASK, DIFF));
  });
});

// ---------------------------------------------------------------------------
// mergeReviewFindings — fail-closed consensus
// ---------------------------------------------------------------------------

const finding = (partial: Partial<ReviewFinding>): ReviewFinding => ({
  severity: "major",
  description: "something",
  confidence: 0.8,
  ...partial,
});

describe("mergeReviewFindings", () => {
  it("buckets findings by severity across batches", () => {
    const merged = mergeReviewFindings([
      [finding({ severity: "blocker", description: "broken", file: "a.ts" })],
      [
        finding({ severity: "major", description: "likely bug", file: "b.ts" }),
        finding({ severity: "minor", description: "nit", file: "c.ts" }),
      ],
    ]);
    expect(merged.blockers.map((f) => f.description)).toEqual(["broken"]);
    expect(merged.majors.map((f) => f.description)).toEqual(["likely bug"]);
    expect(merged.minors.map((f) => f.description)).toEqual(["nit"]);
  });

  it("keeps executable evidence (reproTest) on the merged findings", () => {
    const merged = mergeReviewFindings([
      [finding({ severity: "blocker", reproTest: "expect(fn()).toThrow()", file: "a.ts" })],
    ]);
    expect(merged.blockers[0].reproTest).toBe("expect(fn()).toThrow()");
    expect(merged.consensus).toBe(true);
  });

  it("consensus is FALSE when reviewers contradict each other on the same file", () => {
    const merged = mergeReviewFindings([
      [finding({ severity: "major", file: "auth.ts", description: "auth bypass" })],
      [finding({ severity: "minor", file: "auth.ts", description: "looks fine to me" })],
    ]);
    expect(merged.consensus).toBe(false);
    // Both sides still surface — nothing is hidden by the disagreement.
    expect(merged.majors).toHaveLength(1);
    expect(merged.minors).toHaveLength(1);
  });

  it("serious + serious on the same file is agreement, not contradiction", () => {
    const merged = mergeReviewFindings([
      [finding({ severity: "blocker", file: "a.ts" })],
      [finding({ severity: "major", file: "a.ts" })],
    ]);
    expect(merged.consensus).toBe(true);
  });

  it("serious on one file + minor on ANOTHER file is not a contradiction", () => {
    const merged = mergeReviewFindings([
      [finding({ severity: "blocker", file: "a.ts" })],
      [finding({ severity: "minor", file: "b.ts" })],
    ]);
    expect(merged.consensus).toBe(true);
  });

  it("findings without a file cannot create a same-file contradiction", () => {
    const merged = mergeReviewFindings([
      [finding({ severity: "blocker" })],
      [finding({ severity: "minor" })],
    ]);
    expect(merged.consensus).toBe(true);
  });

  it("NEVER defaults consensus to true on empty input (the strategy-router:328 bug)", () => {
    expect(mergeReviewFindings([]).consensus).toBe(false);
    // A panel that produced NOTHING is not a panel that agreed.
    expect(mergeReviewFindings([[], []]).consensus).toBe(false);
    expect(mergeReviewFindings([[]]).consensus).toBe(false);
  });

  it("garbage input fails closed instead of crashing or agreeing", () => {
    const garbage = [[{ nope: true }, "not a finding", null]] as unknown as ReviewFinding[][];
    const merged = mergeReviewFindings(garbage);
    expect(merged.consensus).toBe(false);
    expect(merged.blockers).toEqual([]);
    expect(merged.majors).toEqual([]);
    expect(merged.minors).toEqual([]);
  });

  it("filters malformed entries but keeps the usable ones — no false consensus", () => {
    const mixed = [
      [
        finding({ severity: "major", file: "a.ts" }),
        { severity: "critical", description: "wrong severity union" },
        { severity: "minor", description: "   " },
      ] as unknown as ReviewFinding[],
    ];
    const merged = mergeReviewFindings(mixed);
    expect(merged.majors).toHaveLength(1);
    expect(merged.minors).toEqual([]);
    expect(merged.consensus).toBe(true);
  });

  it("a reviewer whose call failed (empty batch) cannot manufacture consensus by absence", () => {
    // One reviewer returned a finding, the other's call errored (empty batch).
    // There is at least evidence, and no contradiction → consensus, but ONLY
    // because a real finding exists; the all-empty case above stays false.
    const merged = mergeReviewFindings([[finding({ severity: "major", file: "a.ts" })], []]);
    expect(merged.consensus).toBe(true);
    expect(merged.majors).toHaveLength(1);
  });
});
