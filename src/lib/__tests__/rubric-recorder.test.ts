/**
 * rubric-recorder.test.ts — The test-mode transcript recorder: deterministic
 * evidence-based grading of a finished run, JSONL history persistence, and
 * per-line regression detection vs the previous recorded run. Prompt
 * regressions must show up as a TREND, not a surprise.
 */
import {
  startRubricObservation,
  recordToolCall,
  recordLaneOutcome,
  finishRubricObservation,
  gradeRun,
  enableRubricRecording,
  disableRubricRecordingForTests,
  isRecordingEnabled,
  setHistoryFileForTests,
  readHistory,
  formatTrendReport,
  type RubricRecord,
} from "../rubric-recorder";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpDir = "";

describe("grading (deterministic, evidence-based)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-"));
    setHistoryFileForTests(path.join(tmpDir, "history.jsonl"));
    enableRubricRecording();
    startRubricObservation("t1", "build a dashboard", "code");
  });

  it("grades a clean write task straight A with full evidence", () => {
    recordToolCall("write_file", true, "index.html");
    recordLaneOutcome("typecheck", "pass");
    recordLaneOutcome("browser", "pass");
    const { lines, score } = gradeRun("done", "Report: **Verification** ran. tsc passed. no console errors", {
      modelCalls: 5,
      tokenSavingsPct: 80,
    });

    const byLine = Object.fromEntries(lines.map((l) => [l.line, l.grade]));
    expect(byLine["FILES, NOT FENCES"]).toBe("A");
    expect(byLine["PLAN BEFORE BUILD"]).toBe("B"); // no todo_list — docked one grade
    expect(byLine["VERIFY BEFORE DONE"]).toBe("A");
    expect(byLine["CLEAN REPORT (Output Contract)"]).toBe("A");
    expect(score).toBeGreaterThanOrEqual(90);
    expect(lines.every((l) => l.evidence.length > 0)).toBe(true);
  });

  it("docks FILES, NOT FENCES when fenced code ships next to written files", () => {
    recordToolCall("write_file", true, "index.html");
    const fenced = "Here is the code:\n```html\n<div>entire app</div>\n```\nDone.";
    const { lines } = gradeRun("done", fenced, { modelCalls: 2, tokenSavingsPct: 50 });
    expect(lines.find((l) => l.line === "FILES, NOT FENCES")!.grade).toBe("C");
  });

  it("fails VERIFY BEFORE DONE when files were written but no lane ran", () => {
    recordToolCall("write_file", true, "app.ts");
    const { lines } = gradeRun("done", "wrote it, looks good", { modelCalls: 2, tokenSavingsPct: 0 });
    expect(lines.find((l) => l.line === "VERIFY BEFORE DONE")!.grade).toBe("C");
  });

  it("fails the run when a lane reported a failure", () => {
    recordToolCall("write_file", true, "app.tsx");
    recordLaneOutcome("typecheck", "fail");
    const { lines, score } = gradeRun("done", "**Verification passed**", { modelCalls: 3, tokenSavingsPct: 60 });
    expect(lines.find((l) => l.line === "VERIFY BEFORE DONE")!.grade).toBe("F");
    expect(score).toBeLessThan(80);
  });

  it("detects the re-read loop pathology (4× → C, 3× → B)", () => {
    for (let i = 0; i < 4; i++) recordToolCall("read_file", true, "index.html");
    const { lines } = gradeRun("done", "done", { modelCalls: 4, tokenSavingsPct: 40 });
    expect(lines.find((l) => l.line === "READ BEFORE WRITE")!.grade).toBe("C");
    expect(lines.find((l) => l.line === "NEVER REPEAT A FAILING CALL")!.grade).toBe("A");
    const { lines: l3 } = (() => {
      startRubricObservation("t3x", "x", "code");
      for (let i = 0; i < 3; i++) recordToolCall("read_file", true, "b.html");
      return gradeRun("done", "done", { modelCalls: 3, tokenSavingsPct: 40 });
    })();
    expect(l3.find((l) => l.line === "READ BEFORE WRITE")!.grade).toBe("B");
  });

  it("docks NEVER REPEAT when a tool call failed without recovery", () => {
    startRubricObservation("t4x", "x", "code");
    recordToolCall("run_command", false);
    recordToolCall("write_file", true, "a.ts");
    const { lines } = gradeRun("done", "done", { modelCalls: 2, tokenSavingsPct: 40 });
    expect(lines.find((l) => l.line === "NEVER REPEAT A FAILING CALL")!.grade).toBe("B");
  });

  it("records an error run with an F for report/verify lines", () => {
    recordToolCall("write_file", true, "a.ts");
    const { lines, score } = gradeRun("error", "partial", { modelCalls: 1, tokenSavingsPct: null });
    expect(lines.find((l) => l.line === "VERIFY BEFORE DONE")!.grade).toBe("F");
    expect(lines.find((l) => l.line === "CLEAN REPORT (Output Contract)")!.grade).toBe("F");
    expect(score).toBeLessThan(60);
  });
});

describe("history persistence + trend", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-"));
    setHistoryFileForTests(path.join(tmpDir, "history.jsonl"));
    enableRubricRecording();
  });

  it("appends a JSONL record per run and reads it back", () => {
    startRubricObservation("t1", "task one", "code");
    recordToolCall("write_file", true, "a.ts");
    recordLaneOutcome("typecheck", "pass");
    const rec = finishRubricObservation("done", "**Verification** clean", { modelCalls: 2, tokenSavingsPct: 50 });
    expect(rec).not.toBeNull();
    expect(rec!.finalStatus).toBe("done");
    const history = readHistory();
    expect(history).toHaveLength(1);
    expect(history[0].lines).toHaveLength(7);
    expect(typeof history[0].score).toBe("number");
  });

  it("flags a per-line regression vs the previous run", () => {
    // Run 1: everything green
    startRubricObservation("t1", "task one", "code");
    recordToolCall("write_file", true, "a.ts");
    recordLaneOutcome("typecheck", "pass");
    finishRubricObservation("done", "**Verification** ran, tsc passed", { modelCalls: 2, tokenSavingsPct: 50 });

    // Run 2: model starts shipping fences — regression on FILES, NOT FENCES
    startRubricObservation("t2", "task two", "code");
    recordToolCall("write_file", true, "b.ts");
    recordLaneOutcome("typecheck", "pass");
    const fenced = "code:\n```ts\nconst x = 1;\n```\ndone";
    const rec = finishRubricObservation("done", fenced, { modelCalls: 2, tokenSavingsPct: 50 })!;
    expect(rec.regressions).toContain("FILES, NOT FENCES: A → C");
  });

  it("produces a trend report with score trajectory", () => {
    const mk = (score: number): RubricRecord => ({
      at: new Date().toISOString(),
      task: "t",
      mode: "code",
      finalStatus: "done",
      lines: [],
      score,
      durationMs: 1000,
      modelCalls: 2,
      tokenSavingsPct: 50,
      regressions: [],
    });
    const report = formatTrendReport([mk(95), mk(92), mk(78)]);
    expect(report).toContain("3 recorded run(s)");
    expect(report).toContain("95 → 92 → 78");
    expect(report).toContain("Rolling 3-run average");
  });

  it("recording disabled by default — observation calls are no-ops", () => {
    disableRubricRecordingForTests();
    setHistoryFileForTests(path.join(tmpDir, "disabled.jsonl"));
    const before = readHistory().length;
    startRubricObservation("t9", "task", "code");
    recordToolCall("write_file", true, "x.ts");
    const rec = finishRubricObservation("done", "done", { modelCalls: 1, tokenSavingsPct: 0 });
    expect(rec).toBeNull();
    expect(readHistory().length).toBe(before);
    expect(isRecordingEnabled()).toBe(false);
  });
});
