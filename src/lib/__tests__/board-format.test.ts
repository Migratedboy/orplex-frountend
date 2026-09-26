// board-format.test.ts — Pure presentation helpers: token formatting,
// scheduled-time labels, and human-readable event descriptions.
import { formatTokens, scheduledLabel, usageTotals, describeEvent, removeApprovalFromRuns, type RunWithApprovals } from "../board-format";

describe("formatTokens", () => {
  it("formats thousands and millions readably", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(2936)).toBe("2.9k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });

  it("treats null/undefined as 0", () => {
    expect(formatTokens(null)).toBe("0");
    expect(formatTokens(undefined)).toBe("0");
  });
});

describe("scheduledLabel", () => {
  it("renders future deltas in human units", () => {
    const now = Date.now();
    expect(scheduledLabel(new Date(now + 45_000).toISOString(), now)).toBe("in 45s");
    expect(scheduledLabel(new Date(now + 12 * 60_000).toISOString(), now)).toBe("in 12m");
    expect(scheduledLabel(new Date(now + 7 * 3600_000 + 12 * 60_000).toISOString(), now)).toBe("in 7h 12m");
    expect(scheduledLabel(new Date(now + 3 * 3600_000).toISOString(), now)).toBe("in 3h");
  });

  it("returns empty for past/absent/invalid times", () => {
    expect(scheduledLabel(new Date(Date.now() - 60_000).toISOString())).toBe("");
    expect(scheduledLabel(null)).toBe("");
    expect(scheduledLabel("not-a-date")).toBe("");
  });
});

describe("usageTotals", () => {
  it("accepts camelCase (executor) and snake_case (wire) payloads", () => {
    expect(usageTotals({ promptTokens: 100, completionTokens: 20 })).toEqual({ prompt: 100, completion: 20 });
    expect(usageTotals({ prompt_tokens: 100, completion_tokens: 20 })).toEqual({ prompt: 100, completion: 20 });
  });

  it("returns null for absent/empty payloads", () => {
    expect(usageTotals(null)).toBeNull();
    expect(usageTotals({})).toBeNull();
  });
});

describe("removeApprovalFromRuns", () => {
  const runs = [
    { id: "r1", pendingApprovalCount: 2, pendingApprovals: [{ id: "a1" }, { id: "a2" }] },
    { id: "r2", pendingApprovalCount: 0, pendingApprovals: [] },
  ];

  it("drops the decided card and decrements only that run", () => {
    const out = removeApprovalFromRuns(runs, "r1", "a1");
    expect(out[0].pendingApprovals).toEqual([{ id: "a2" }]);
    expect(out[0].pendingApprovalCount).toBe(1);
    expect(out[1]).toBe(runs[1]); // untouched run keeps identity
  });

  it("clamps the counter at zero and tolerates missing approval lists", () => {
    const input: RunWithApprovals[] = [{ id: "r1", pendingApprovalCount: 0 }];
    const out = removeApprovalFromRuns(input, "r1", "a1");
    expect(out[0].pendingApprovalCount).toBe(0);
    expect(out[0].pendingApprovals).toEqual([]);
    expect(out[0].id).toBe("r1");
  });

  it("does not mutate the input", () => {
    removeApprovalFromRuns(runs, "r1", "a1");
    expect(runs[0].pendingApprovalCount).toBe(2);
    expect(runs[0].pendingApprovals).toHaveLength(2);
  });
});

describe("describeEvent", () => {
  it("describes the executor lifecycle events", () => {
    expect(describeEvent("spawned", { via: "mcp" })).toEqual({ label: "spawned via mcp" });
    expect(describeEvent("claimed", { by: "server-executor" })).toEqual({ label: "claimed by server-executor" });
    expect(describeEvent("worktree-created", { branch: "orplex/run-x" })).toEqual({ label: "orplex/run-x" });
    expect(describeEvent("branch-pushed", { ref: "origin/orplex/run-x" })).toEqual({ label: "orplex/run-x" });
  });

  it("describes metering and failover", () => {
    expect(describeEvent("usage", { promptTokens: 2936, completionTokens: 287 })?.label).toContain("3.2k tok");
    expect(describeEvent("usage", { promptTokens: 2936, completionTokens: 287 })?.label).toContain("prompt 2.9k");
    expect(describeEvent("provider-failover", { from: "nvidia", to: "groq", reason: "429" })).toEqual({
      label: "nvidia → groq",
      detail: "429",
    });
  });

  it("describes resilience and queue events", () => {
    expect(describeEvent("requeued-after-restart", { requeue: 2 })?.label).toContain("attempt 2");
    expect(describeEvent("compacted", { tokensBefore: 5400 })?.label).toContain("5.4k");
    expect(describeEvent("run-finished", { changedFiles: 1, provider: "nvidia" })?.label).toBe("1 file(s) changed · nvidia");
  });

  it("returns null for unknown types and payload-less known types", () => {
    expect(describeEvent("mystery-event", {})).toBeNull();
    expect(describeEvent("spawned", {})).toBeNull();
    expect(describeEvent("claimed", "not-an-object")).toEqual({ label: "claimed by executor" });
  });
});
