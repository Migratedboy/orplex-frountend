/**
 * prompt-meter.test.ts — The token meter must make compact-profile savings
 * visible and verifiable per task: records carry the actual profile sent plus
 * the counterfactual full-profile cost, savings math is exact, tasks are
 * isolated, and the summary line formats correctly for every case.
 */
import {
  calibratePromptSizes,
  getPromptSizes,
  startTaskMeter,
  recordPromptCall,
  computeTaskSavings,
  formatSavingsSummary,
  getTaskMeter,
  resetPromptMeter,
} from "../prompt-meter";
import { buildSystemPrompt } from "../master-prompt";

beforeEach(async () => {
  resetPromptMeter();
  // Real master-prompt sizes so the math reflects the live prompts
  calibratePromptSizes(
    (await buildSystemPrompt({ mode: "code" })).length,
    (await buildSystemPrompt({ mode: "code", profile: "compact" })).length
  );
});

describe("calibration", () => {
  it("captures the real full and compact sizes from the master prompt", () => {
    const { full, compact } = getPromptSizes();
    expect(full).toBeGreaterThan(5000); // ten-section doctrine
    expect(compact).toBeGreaterThan(500);
    expect(compact).toBeLessThan(full * 0.5); // compact is genuinely smaller
  });
});

describe("recording calls", () => {
  it("records a full-profile call with correct token math", () => {
    const taskId = "t1";
    startTaskMeter(taskId, "code");
    const rec = recordPromptCall({
      taskId, turn: 0, profile: "full", mode: "code",
      systemChars: getPromptSizes().full, contextChars: 4000, why: "initial",
    })!;
    expect(rec).not.toBeNull();
    expect(rec.systemTokens).toBe(Math.ceil(getPromptSizes().full / 4));
    expect(rec.contextTokens).toBe(1000);
    // Full profile: counterfactual equals actual
    expect(rec.fullSystemTokens).toBe(rec.systemTokens);
  });

  it("records the counterfactual for compact calls (what full would have cost)", () => {
    startTaskMeter("t2", "code");
    const rec = recordPromptCall({
      taskId: "t2", turn: 1, profile: "compact", mode: "code",
      systemChars: getPromptSizes().compact, contextChars: 8000, why: "tool-loop turn 2",
    })!;
    expect(rec.fullSystemTokens).toBe(Math.ceil(getPromptSizes().full / 4));
    expect(rec.systemTokens).toBeLessThan(rec.fullSystemTokens);
  });

  it("returns null for unknown tasks (never throws)", () => {
    expect(recordPromptCall({
      taskId: "nope", turn: 0, profile: "full", mode: "code", systemChars: 10, contextChars: 10, why: "x",
    })).toBeNull();
  });
});

describe("savings math", () => {
  it("computes exact savings for a realistic task: 1 full + 3 compact calls", () => {
    const taskId = "t3";
    startTaskMeter(taskId, "code");
    const full = getPromptSizes().full;
    const compact = getPromptSizes().compact;
    recordPromptCall({ taskId, turn: 0, profile: "full", mode: "code", systemChars: full, contextChars: 12000, why: "initial" });
    for (let turn = 1; turn <= 3; turn++) {
      recordPromptCall({ taskId, turn, profile: "compact", mode: "code", systemChars: compact, contextChars: 15000, why: `turn ${turn + 1}` });
    }
    const s = computeTaskSavings(taskId)!;
    expect(s.calls).toBe(4);
    expect(s.fullCalls).toBe(1);
    expect(s.compactCalls).toBe(3);

    const expectedSpent = Math.ceil(full / 4) + 3 * Math.ceil(compact / 4);
    const expectedFull = 4 * Math.ceil(full / 4);
    expect(s.systemTokensSpent).toBe(expectedSpent);
    expect(s.systemTokensFullCounterfactual).toBe(expectedFull);
    expect(s.tokensSaved).toBe(expectedFull - expectedSpent);
    expect(s.savedPct).toBe(Math.round(((expectedFull - expectedSpent) / expectedFull) * 100));
    // Grand totals include identical context costs in both
    expect(s.grandTotalActual).toBe(expectedSpent + Math.ceil((12000 + 3 * 15000) / 4));
    expect(s.grandTotalCounterfactual).toBe(expectedFull + Math.ceil((12000 + 3 * 15000) / 4));
  });

  it("reports zero savings when every call was full-profile", () => {
    startTaskMeter("t4", "code");
    recordPromptCall({ taskId: "t4", turn: 0, profile: "full", mode: "code", systemChars: 20000, contextChars: 1000, why: "initial" });
    const s = computeTaskSavings("t4")!;
    expect(s.tokensSaved).toBe(0);
    expect(s.savedPct).toBe(0);
  });

  it("returns null for a task with no calls", () => {
    startTaskMeter("t5", "code");
    expect(computeTaskSavings("t5")).toBeNull();
  });
});

describe("summary formatting", () => {
  it("formats the mixed-profile case with token counts", () => {
    const taskId = "t6";
    startTaskMeter(taskId, "code");
    recordPromptCall({ taskId, turn: 0, profile: "full", mode: "code", systemChars: 20000, contextChars: 12000, why: "initial" });
    recordPromptCall({ taskId, turn: 1, profile: "compact", mode: "code", systemChars: 6000, contextChars: 15000, why: "repair" });
    const line = formatSavingsSummary(taskId);
    expect(line).toContain("1 full + 1 compact");
    expect(line).toContain("tokens saved");
    expect(line).toContain("%");
  });

  it("formats the all-full case without claiming savings", () => {
    startTaskMeter("t7", "code");
    recordPromptCall({ taskId: "t7", turn: 0, profile: "full", mode: "code", systemChars: 20000, contextChars: 1000, why: "initial" });
    const line = formatSavingsSummary("t7");
    expect(line).toContain("all full-profile");
    expect(line).not.toContain("saved");
  });

  it("is empty when the task made no calls", () => {
    expect(formatSavingsSummary("missing")).toBe("");
  });
});

describe("task isolation and caps", () => {
  it("keeps tasks separate", () => {
    startTaskMeter("a", "code");
    startTaskMeter("b", "code");
    recordPromptCall({ taskId: "a", turn: 0, profile: "full", mode: "code", systemChars: 100, contextChars: 0, why: "a-call" });
    expect(getTaskMeter("b")!.calls).toHaveLength(0);
    expect(getTaskMeter("a")!.calls).toHaveLength(1);
  });

  it("drops the oldest task beyond the cap", () => {
    for (let i = 0; i < 25; i++) startTaskMeter(`cap-${i}`, "code");
    expect(getTaskMeter("cap-0")).toBeNull();
    expect(getTaskMeter("cap-24")).not.toBeNull();
  });
});
