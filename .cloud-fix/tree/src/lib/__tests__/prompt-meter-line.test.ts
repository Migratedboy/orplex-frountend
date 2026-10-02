// prompt-meter-line.test.ts — The transcript meter line must roundtrip:
// formatSavingsSummary emits it, parseMeterLine reads it back for the
// designed strip. Recorded-task lines are checked against computeTaskSavings
// (the source of truth); hand-written literals pin the parser itself.

import {
  startTaskMeter,
  recordPromptCall,
  computeTaskSavings,
  formatSavingsSummary,
  parseMeterLine,
  resetPromptMeter,
} from "../prompt-meter";

beforeEach(() => {
  resetPromptMeter();
});

describe("parseMeterLine — all-full variant", () => {
  it("roundtrips a recorded single full-profile task", () => {
    startTaskMeter("t1", "code");
    recordPromptCall({
      taskId: "t1",
      turn: 1,
      profile: "full",
      mode: "code",
      systemChars: 20_000,
      contextChars: 2_000,
      why: "turn 1",
    });
    const line = formatSavingsSummary("t1");
    const parsed = parseMeterLine(line);
    const s = computeTaskSavings("t1");

    expect(line).toMatch(/^Prompt meter: 1 call\(s\), all full-profile — /);
    expect(parsed).not.toBeNull();
    expect(parsed!.calls).toBe(s!.calls);
    expect(parsed!.fullCalls).toBe(1);
    expect(parsed!.compactCalls).toBe(0);
    expect(parsed!.actualTokens).toBe(s!.grandTotalActual);
    expect(parsed!.allFull).toBe(true);
    expect(parsed!.savedTokens).toBeUndefined();
  });

  it("parses the hand-written example with separators", () => {
    const parsed = parseMeterLine("Prompt meter: 1 call(s), all full-profile — 2,509 prompt tokens.");
    expect(parsed).toEqual({
      calls: 1,
      fullCalls: 1,
      compactCalls: 0,
      actualTokens: 2509,
      allFull: true,
    });
  });
});

describe("parseMeterLine — savings variant", () => {
  it("roundtrips a recorded mixed full+compact task", () => {
    startTaskMeter("t2", "code");
    recordPromptCall({
      taskId: "t2",
      turn: 1,
      profile: "full",
      mode: "code",
      systemChars: 20_000,
      contextChars: 2_000,
      why: "turn 1",
    });
    recordPromptCall({
      taskId: "t2",
      turn: 2,
      profile: "compact",
      mode: "code",
      systemChars: 6_000,
      contextChars: 2_500,
      why: "repair turn",
    });
    const line = formatSavingsSummary("t2");
    const parsed = parseMeterLine(line);
    const s = computeTaskSavings("t2");

    expect(line).toMatch(/full \+ 1 compact →/);
    expect(parsed).not.toBeNull();
    expect(parsed!.calls).toBe(s!.calls);
    expect(parsed!.fullCalls).toBe(s!.fullCalls);
    expect(parsed!.compactCalls).toBe(s!.compactCalls);
    expect(parsed!.savedTokens).toBe(s!.tokensSaved);
    expect(parsed!.savedPct).toBe(s!.savedPct);
    expect(parsed!.actualTokens).toBe(s!.grandTotalActual);
    expect(parsed!.counterfactualTokens).toBe(s!.grandTotalCounterfactual);
    expect(parsed!.allFull).toBe(false);
  });

  it("parses the hand-written example with separators", () => {
    const parsed = parseMeterLine(
      "Prompt meter: 2 call(s) — 1 full + 1 compact → 4,200 tokens saved (70% of system-prompt cost). Actual 8,700 vs 12,900 if full-everywhere."
    );
    expect(parsed).toMatchObject({
      calls: 2,
      fullCalls: 1,
      compactCalls: 1,
      savedTokens: 4200,
      savedPct: 70,
      actualTokens: 8700,
      counterfactualTokens: 12900,
    });
  });
});

describe("parseMeterLine — rejection", () => {
  it("returns null for non-meter text", () => {
    expect(parseMeterLine("Just a normal paragraph about tokens.")).toBeNull();
    expect(parseMeterLine("")).toBeNull();
    expect(parseMeterLine("Prompt meter:")).toBeNull();
    expect(parseMeterLine("Prompt meter: banana")).toBeNull();
  });

  it("returns null when call counts are inconsistent", () => {
    const parsed = parseMeterLine(
      "Prompt meter: 3 call(s) — 1 full + 1 compact → 100 tokens saved (10% of system-prompt cost). Actual 900 vs 1,000 if full-everywhere."
    );
    expect(parsed).toBeNull();
  });
});
