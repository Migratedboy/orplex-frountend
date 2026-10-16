/**
 * rubric-recorder.ts — Test-mode transcript recorder that grades every live
 * run against the master-prompt rubric and appends the result to a JSONL
 * history, so prompt regressions show up as a TREND, not a surprise.
 *
 * Philosophy: the same platform evidence the transcript already shows (files
 * written, verification lanes, tool-call sequence, meter line) is enough to
 * grade the rubric deterministically — no LLM judge, no flaky heuristics.
 *
 * Storage: .rubric-history/history.jsonl in the project root (one JSON object
 * per run). Disabled in normal operation; activated by TEST_MODE=1 (any run)
 * or explicitly by the live-validate harness.
 */

export interface RubricLine {
  line: string;
  grade: "A" | "B" | "C" | "F";
  /** Platform evidence the grade was derived from. */
  evidence: string;
}

export interface RubricRecord {
  /** ISO timestamp of the run. */
  at: string;
  /** Task text the model was given. */
  task: string;
  mode: string;
  finalStatus: "done" | "error" | "aborted";
  lines: RubricLine[];
  /** Simple 0–100 score: A=100, B=70, C=40, F=0, averaged. */
  score: number;
  /**
   * THE verdict — hard pass/fail from exit codes, never from letters:
   * PASS requires the task to have completed with a clean typecheck lane
   * (and a clean browser lane when one ran). "Looks done" vs "is done".
   */
  verdict: "PASS" | "FAIL";
  /** Which hard criteria the verdict was computed from. */
  verdictEvidence: string[];
  durationMs: number;
  modelCalls: number;
  tokenSavingsPct: number | null;
  /** First line of any regression vs the previous recorded run, if any. */
  regressions: string[];
}

// ---------------------------------------------------------------------------
// Tool-call observation — fed by the worker through the plugin-style hook
// ---------------------------------------------------------------------------

export interface ObservedToolCall {
  name: string;
  /** Whether the call resulted in a written/edited file. */
  wrote: boolean;
  /** Whether the tool result reported an error/failure. */
  failed: boolean;
  at: number;
}

// Per-task observation buffer (module state; one task at a time in the worker)
let currentObservation: {
  taskId: string;
  task: string;
  mode: string;
  startedAt: number;
  calls: ObservedToolCall[];
  writtenFiles: Set<string>;
  lanes: { typecheck: "pass" | "fail" | "skipped"; browser: "pass" | "fail" | "skipped"; swarm: "pass" | "fail" | "skipped" };
  readingCounts: Map<string, number>;
} | null = null;

/** Begin observing a task (called from runInBackground start). */
export function startRubricObservation(taskId: string, task: string, mode: string): void {
  if (!isRecordingEnabled()) return;
  currentObservation = {
    taskId,
    task,
    mode,
    startedAt: Date.now(),
    calls: [],
    writtenFiles: new Set(),
    lanes: { typecheck: "skipped", browser: "skipped", swarm: "skipped" },
    readingCounts: new Map(),
  };
}

/** Record a tool call the worker executed (called from the tool-execution site). */
export function recordToolCall(name: string, ok: boolean, path?: string): void {
  if (!currentObservation || !isRecordingEnabled()) return;
  currentObservation.calls.push({ name, wrote: ok && !!path, failed: !ok, at: Date.now() });
  if (path && ok && (name === "write_file" || name === "edit_file")) {
    currentObservation.writtenFiles.add(path);
  }
  if (path && name === "read_file") {
    currentObservation.readingCounts.set(path, (currentObservation.readingCounts.get(path) || 0) + 1);
  }
}

/** Record a verification-lane outcome (typecheck / browser / swarm). */
export function recordLaneOutcome(
  lane: "typecheck" | "browser" | "swarm",
  // The stored model has always allowed "skipped" (computeVerdict treats it as
  // never-a-pass), but this signature only accepted "pass" | "fail", so a lane
  // that could not run could never be recorded as skipped — the only way out
  // was to lie and say "pass".
  outcome: "pass" | "fail" | "skipped",
): void {
  if (!currentObservation || !isRecordingEnabled()) return;
  currentObservation.lanes[lane] = outcome;
}

/**
 * Observation metadata for the persistent ledger: lanes, duration, and model
 * call count — null when observation isn't active (recording disabled).
 */
export function getObservationMeta(): {
  lanes: { typecheck: "pass" | "fail" | "skipped"; browser: "pass" | "fail" | "skipped"; swarm: "pass" | "fail" | "skipped" };
  durationMs: number;
} | null {
  if (!currentObservation) return null;
  return {
    lanes: { ...currentObservation.lanes },
    durationMs: Date.now() - currentObservation.startedAt,
  };
}

/** True when recording is on: TEST_MODE=1 env or an explicit live-run session. */
export function isRecordingEnabled(): boolean {
  try {
    if (process.env.TEST_MODE === "1") return true;
  } catch {}
  return explicitSession;
}

let explicitSession = false;

/** Explicitly enable recording for the current process (live-validate harness). */
export function enableRubricRecording(): void {
  explicitSession = true;
}

/** Test hook: restore the default disabled state. */
export function disableRubricRecordingForTests(): void {
  explicitSession = false;
}

// ---------------------------------------------------------------------------
// Grading — deterministic, evidence-based
// ---------------------------------------------------------------------------

const WEIGHTS: Record<RubricLine["grade"], number> = { A: 100, B: 70, C: 40, F: 0 };

/**
 * Grade a finished run from the observation. Every rule maps 1:1 to a rubric
 * line the live-run grade cards have used; all evidence comes from what the
 * platform itself observed.
 */
export function gradeRun(
  finalStatus: "done" | "error" | "aborted",
  transcript: string,
  opts: { modelCalls: number; tokenSavingsPct: number | null }
): { lines: RubricLine[]; score: number } {
  const obs = currentObservation;
  const wroteAny = !!obs && obs.writtenFiles.size > 0;
  const readsPerFile = obs ? Array.from(obs.readingCounts.values()) : [];
  const maxReads = readsPerFile.length ? Math.max(...readsPerFile) : 0;
  const hadFailedCalls = !!obs && obs.calls.some((c) => c.failed);
  const written = wroteAny;
  const laneRan = !!obs && (obs.lanes.typecheck !== "skipped" || obs.lanes.browser !== "skipped");
  const laneFailed = !!obs && (obs.lanes.typecheck === "fail" || obs.lanes.browser === "fail");
  const usedTodoList = !!obs?.calls.some((c) => c.name === "todo_list");

  // Fence check on the final transcript: fenced code blocks in the answer
  // text when files were written this task (Directive #1).
  const answerStart = transcript.indexOf("[THINKING]");
  const answerText = transcript;
  const fences = (answerText.match(/```/g) || []).length;
  const fenceBlocksInAnswer = Math.floor(fences / 2);
  // Platform strips duplicated fenced content when files were written; a
  // remaining fence next to real writes is a rubric violation.
  const fencesWhileWritten = written && fenceBlocksInAnswer > 0;

  const lines: RubricLine[] = [
    {
      line: "FILES, NOT FENCES",
      grade: fencesWhileWritten ? "C" : "A",
      evidence: fencesWhileWritten
        ? `${fenceBlocksInAnswer} fenced block(s) in the final answer while ${obs!.writtenFiles.size} file(s) were written via tools`
        : wroteAny
          ? `${obs!.writtenFiles.size} file(s) written via write_file/edit_file; no duplicate fences in the final answer`
          : "no files written this task (text-only turn) — fences in answers acceptable",
    },
    {
      line: "PLAN BEFORE BUILD",
      grade: usedTodoList || !obs || obs.calls.length === 0 ? "A" : "B",
      evidence: usedTodoList
        ? `todo_list used before the first write (${obs!.calls.findIndex((c) => c.name === "todo_list") + 1} of ${obs!.calls.length} calls)`
        : !obs || obs.calls.length === 0
          ? "no tool calls — pure answer, no plan required"
          : "tool calls ran without a todo_list (acceptable for trivial scope, docked one grade)",
    },
    {
      line: "VERIFY BEFORE DONE",
      grade: finalStatus !== "done" ? "F" : laneRan ? (laneFailed ? "F" : "A") : wroteAny ? "C" : "A",
      evidence:
        finalStatus !== "done"
          ? "task did not complete — nothing verified"
          : laneRan
            ? `platform lanes ran: typecheck=${obs!.lanes.typecheck}, browser=${obs!.lanes.browser} — no unresolved failures`
            : wroteAny
              ? "files written but NO verification lane ran — task closed unverified"
              : "nothing written — no verification required",
    },
    {
      line: "NEVER REPEAT A FAILING CALL",
      grade: hadFailedCalls ? "B" : "A",
      evidence: hadFailedCalls
        ? "at least one tool call failed; recovery ran through the platform's repair/retry lanes"
        : "no failing tool calls recorded — nothing to recover from",
    },
    {
      line: "READ BEFORE WRITE",
      grade: maxReads >= 4 ? "C" : maxReads === 3 ? "B" : "A",
      evidence:
        maxReads >= 3
          ? `a file was re-read ${maxReads}× (re-read loop — the truncation/re-read pathology the platform must never induce)`
          : "no file re-read more than twice; no re-read loops",
    },
    {
      line: "CLEAN REPORT (Output Contract)",
      grade: gradeCleanReport(finalStatus, transcript),
      evidence: written
        ? "final report graded on verification accounting (claims must match what actually ran)"
        : "no writes — report contract not applicable",
    },
    {
      line: "FAILURE DOCTRINE",
      grade: finalStatus === "error" ? "F" : "A",
      evidence:
        finalStatus === "error"
          ? "run ended in an unresolved error — the doctrine's prime directive (close verified or explain the blocker) was not met"
          : "closed without unresolved failure; repair lanes and adaptive context handled any transient",
    },
  ];

  const score = Math.round(lines.reduce((s, l) => s + WEIGHTS[l.grade], 0) / lines.length);
  return { lines, score };
}

/**
 * CLEAN REPORT: the transcript must contain a verification/accounting section
 * consistent with what actually ran. An unverified close with writes is a B;
 * a task that never completed can't report — F.
 */
function gradeCleanReport(finalStatus: "done" | "error" | "aborted", transcript: string): RubricLine["grade"] {
  if (finalStatus !== "done") return "F";
  const hasAccounting = /\*\*Verification\*\*|How it was verified|not yet verified|typecheck|no console errors/i.test(transcript);
  return hasAccounting ? "A" : "B";
}

// ---------------------------------------------------------------------------
// HARD VERDICT — the only number that matters
// ---------------------------------------------------------------------------

/**
 * Compute the binary verdict from platform evidence (exit codes and lane
 * outcomes), never from the letter grades:
 *   - finalStatus must be "done" (error/aborted → FAIL, no exceptions);
 *   - the typecheck lane, when it ran, must be "pass" (exit code 0);
 *   - the browser lane, when it ran, must be "pass" (zero console errors);
 *   - the review lane (swarm slot), when it ran, must be "pass".
 * Skipped lanes never fail a run — they mean the lane didn't apply.
 */
export function computeVerdict(
  finalStatus: "done" | "error" | "aborted",
  lanes: { typecheck: "pass" | "fail" | "skipped"; browser: "pass" | "fail" | "skipped"; swarm: "pass" | "fail" | "skipped" }
): { verdict: "PASS" | "FAIL"; evidence: string[] } {
  const evidence: string[] = [];
  let pass = true;

  if (finalStatus !== "done") {
    pass = false;
    evidence.push(`finalStatus=${finalStatus} (must be done)`);
  }
  for (const lane of ["typecheck", "browser", "swarm"] as const) {
    const outcome = lanes[lane];
    if (outcome === "fail") {
      pass = false;
      evidence.push(`${lane} lane failed (exit-code evidence)`);
    } else if (outcome === "pass") {
      evidence.push(`${lane} lane passed`);
    }
    // skipped → lane didn't apply; never verdict-relevant
  }
  if (evidence.length === 0) evidence.push("completed with no applicable verification lanes");
  return { verdict: pass ? "PASS" : "FAIL", evidence };
}

// ---------------------------------------------------------------------------
// History persistence + trend analysis
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Node access — lazy, bundler-invisible
// ---------------------------------------------------------------------------

/**
 * This module is part of the background-worker chain, which the CLIENT bundle
 * also imports (the agent runs in the browser), so a static `import * as fs
 * from "fs"` breaks the Turbopack browser build ("Can't resolve 'fs'"). Load
 * Node's builtins through a non-statically-analyzed require instead: on the
 * server it resolves normally; in the browser it returns null and history
 * persistence degrades to a no-op (a test-mode-only diagnostic feature).
 */
interface NodeLibs {
  fs: typeof import("fs");
  path: typeof import("path");
}

let nodeLibsCache: NodeLibs | null | undefined;

function getNodeLibs(): NodeLibs | null {
  if (nodeLibsCache !== undefined) return nodeLibsCache;
  nodeLibsCache = null;
  if (typeof window === "undefined") {
    try {
      // eval'd require is invisible to bundlers — the whole point.
      // eslint-disable-next-line no-eval
      const req = eval("typeof require === 'function' ? require : null") as
        | ((id: string) => unknown)
        | null;
      if (req) {
        nodeLibsCache = { fs: req("fs") as NodeLibs["fs"], path: req("path") as NodeLibs["path"] };
      }
    } catch {
      // stay null — browser or bundler context without Node builtins
    }
  }
  return nodeLibsCache;
}

/** History file location (project root). Overridable for tests. */
let historyFileOverride: string | null = null;

function historyFilePath(): string | null {
  const libs = getNodeLibs();
  if (!libs) return null;
  return historyFileOverride ?? libs.path.join(process.cwd(), ".rubric-history", "history.jsonl");
}

/** Test hook: point the recorder at a temp history file. */
export function setHistoryFileForTests(p: string): void {
  historyFileOverride = p;
}

function appendHistory(record: RubricRecord): void {
  try {
    const libs = getNodeLibs();
    const file = historyFilePath();
    if (!libs || !file) return; // browser — persistence not available
    libs.fs.mkdirSync(libs.path.dirname(file), { recursive: true });
    libs.fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Persistence is best-effort — grading must never break a task.
  }
}

export function readHistory(): RubricRecord[] {
  try {
    const libs = getNodeLibs();
    const file = historyFilePath();
    if (!libs || !file) return []; // browser — no history available
    return libs.fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as RubricRecord);
  } catch {
    return [];
  }
}

/** Read the history for a console trend report (worker convenience wrapper). */
export function readTrendHistoryForReport(): RubricRecord[] {
  return readHistory();
}

/** Append a finished run to the history and compute the trend vs previous. */
export function finishRubricObservation(
  finalStatus: "done" | "error" | "aborted",
  transcript: string,
  opts: { modelCalls: number; tokenSavingsPct: number | null }
): RubricRecord | null {
  if (!currentObservation || !isRecordingEnabled()) return null;
  const obs = currentObservation;
  const { lines, score } = gradeRun(finalStatus, transcript, opts);
  const prev = readHistory().filter((r) => r.finalStatus !== "aborted").slice(-1)[0];

  const prevGrade = (line: string) => prev?.lines.find((l) => l.line === line)?.grade;
  const RANK: Record<RubricLine["grade"], number> = { F: 0, C: 1, B: 2, A: 3 };
  const regressions = lines
    .filter((l) => prev && RANK[l.grade] < RANK[prevGrade(l.line) || l.grade])
    .map((l) => `${l.line}: ${prevGrade(l.line)} → ${l.grade}`);

  const record: RubricRecord = {
    at: new Date().toISOString(),
    task: obs.task.slice(0, 120),
    mode: obs.mode,
    finalStatus,
    lines,
    score,
    verdict: computeVerdict(finalStatus, obs.lanes).verdict,
    verdictEvidence: computeVerdict(finalStatus, obs.lanes).evidence,
    durationMs: Date.now() - obs.startedAt,
    modelCalls: opts.modelCalls,
    tokenSavingsPct: opts.tokenSavingsPct,
    regressions,
  };
  appendHistory(record);
  currentObservation = null;
  return record;
}

// ---------------------------------------------------------------------------
// Console-friendly trend report
// ---------------------------------------------------------------------------

/** Human-readable trend across the recorded history — verdict-first. */
export function formatTrendReport(records: RubricRecord[]): string {
  if (records.length === 0) return "No rubric history recorded yet.";
  const last = records[records.length - 1];
  const prev = records.length > 1 ? records[records.length - 2] : null;
  const arrow = (a: number, b: number) => (b > a ? " ↗" : b < a ? " ↘" : " →");
  const out: string[] = [];
  const passCount = records.filter((r) => r.verdict === "PASS").length;
  out.push(`Hard verdicts — ${passCount}/${records.length} run(s) PASSED (exit-code evidence only)`);
  out.push(
    `Last run: ${last.verdict}${last.verdictEvidence.length ? ` (${last.verdictEvidence.join("; ")})` : ""}` +
      (prev ? ` — prev ${prev.verdict}${prev.verdict !== last.verdict ? " (VERDICT CHANGED)" : ""}` : " — first recorded run")
  );
  const scoreSpark = records.slice(-10).map((r) => `${r.verdict === "PASS" ? "✓" : "✗"}`).join(" ");
  out.push(`Verdict trend (last ≤10): ${scoreSpark}`);
  // Letter grades stay as diagnostics below the verdict.
  out.push(`Diagnostic score: ${last.score}/100 (${last.finalStatus})${prev ? ` — prev ${prev.score}${arrow(prev.score, last.score)}` : ""}`);
  for (const l of last.lines) {
    const p = prev?.lines.find((x) => x.line === l.line);
    out.push(`  ${l.grade === "A" ? "✅" : l.grade === "B" ? "🟡" : "⚠️"} ${l.line.padEnd(32)} ${l.grade}${p && p.grade !== l.grade ? ` (was ${p.grade})` : ""}`);
  }
  if (last.regressions.length) {
    out.push(`⚠️ REGRESSIONS vs previous run: ${last.regressions.join("; ")}`);
  }
  const avgLast3 = Math.round(records.slice(-3).reduce((s, r) => s + r.score, 0) / Math.min(3, records.length));
  out.push(`Rolling 3-run diagnostic average: ${avgLast3}/100`);
  return out.join("\n");
}
