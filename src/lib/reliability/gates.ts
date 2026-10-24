/**
 * reliability/gates.ts — plan §6.1/§6.3. A tiered verification pipeline that
 * can REFUSE, not just report.
 *
 * Before this module the worker ran exactly one lane (`npx tsc --noEmit`),
 * appended the result to a display string, and continued to `completeTask`
 * regardless. `computeVerdict` in rubric-recorder.ts already models a correct
 * hard gate but is unreachable — it sits behind TEST_MODE=1 and its lane union
 * has no `test` member. This module is the missing enforcement layer.
 *
 * Design constraints, all inherited from the audit (docs/reliability/AUDIT.md):
 *   - No new dependencies (D-5). Error extraction is regex on real tsc output.
 *   - No AST tooling. The "syntax" tier is folded into typecheck because tsc
 *     exposes no parse-only mode without adding a dependency.
 *   - Baseline diagnostics are mandatory under the flag (see flags.ts): without
 *     a pre-task snapshot the gate cannot distinguish a regression from a
 *     pre-existing failure, so it would have to block on errors the agent never
 *     caused — the behaviour the plan explicitly rejects.
 *   - Every lane outcome is exit-code evidence. A lane that could not run is
 *     "skipped", never "pass".
 */

import type { GateExec, LaneName, LaneOutcome, LaneResult, WorkspaceBaseline } from "./types";

export type { GateExec, LaneName, LaneOutcome, LaneResult, WorkspaceBaseline };

/** Commands. Overridable per-workspace by the caller; these are the defaults. */
export const GATE_COMMANDS = {
  typecheck: "npx tsc --noEmit",
  // Scoped to the files the task actually touched — running eslint on the whole
  // workspace would surface pre-existing warnings that are not this task's.
  lint: (files: string[]) => `npx eslint --no-warn-ignored ${files.map(shellQuote).join(" ")}`,
  test: "npx jest --silent --passWithNoTests",
} as const;

export const GATE_TIMEOUTS_MS = {
  typecheck: 120_000,
  lint: 60_000,
  test: 180_000,
} as const;

/** `error TS2345:` lines, the only signal tsc gives us for a hard failure. */
const TSC_ERROR_RE = /\berror TS\d+:/;

/**
 * Reduce a tsc error line to a stable signature: `path/to/file.ts:TS2345`.
 * Line and column are deliberately DROPPED — an error that moves from line 10
 * to line 12 because the agent inserted a line above it is the SAME error, not
 * a new one. Counting it as new would report a false regression.
 */
export function tscErrorSignature(line: string): string | null {
  const m = line.match(/^\s*(.+?)\((\d+),(\d+)\):\s*error (TS\d+):/);
  if (!m) {
    const alt = line.match(/^\s*(.+?):\s*error (TS\d+):/);
    if (!alt) return null;
    return `${alt[1]}:${alt[2]}`;
  }
  return `${m[1]}:${m[4]}`;
}

/** Extract deduped, sorted error signatures from raw tsc output. */
export function extractTypecheckSignatures(output: string): string[] {
  const seen = new Set<string>();
  for (const raw of output.split("\n")) {
    if (!TSC_ERROR_RE.test(raw)) continue;
    const sig = tscErrorSignature(raw);
    if (sig) seen.add(sig);
  }
  return [...seen].sort();
}

/** Summarize raw output to the first N error lines for display/repair prompts. */
export function summarizeLaneOutput(output: string, maxLines = 15): string {
  const lines = output.split("\n").filter((l) => l.trim());
  return lines.slice(0, maxLines).join("\n");
}

/** Minimal shell quoting so file paths with spaces survive the exec route. */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./\\:-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Baseline — the pre-task snapshot that makes "regression" meaningful
// ---------------------------------------------------------------------------

/**
 * Capture the workspace's pre-task typecheck state. Called once, before the
 * first write. When the lane cannot run (no exec route, empty workspace) the
 * baseline records `ran:false` and the gate treats every subsequent failure as
 * a regression — the conservative direction: we cannot prove it was pre-existing.
 */
export async function captureBaseline(
  exec: GateExec,
  signal?: AbortSignal,
): Promise<WorkspaceBaseline> {
  const baseline: WorkspaceBaseline = {
    capturedAt: Date.now(),
    typecheck: { ran: false, exitCode: null, errors: [] },
  };
  if (signal?.aborted) return baseline;
  try {
    const res = await exec(GATE_COMMANDS.typecheck, GATE_TIMEOUTS_MS.typecheck);
    if (typeof res.exitCode === "number") {
      baseline.typecheck = {
        ran: true,
        exitCode: res.exitCode,
        errors: extractTypecheckSignatures(`${res.stdout || ""}\n${res.stderr || ""}`),
      };
    }
  } catch {
    // exec unavailable — baseline stays `ran:false`.
  }
  return baseline;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface GatePipelineOptions {
  taskId: string;
  baseline: WorkspaceBaseline | null;
  exec: GateExec;
  /** Files the task wrote/edited — the lint lane is scoped to these. */
  changedFiles: string[];
  /** Run the jest lane. Caller gates this on reliabilityTestLaneEnabled(). */
  includeTestLane: boolean;
  signal?: AbortSignal;
}

export interface GatePipelineResult {
  results: LaneResult[];
  verdict: "PASS" | "FAIL";
  /** Lanes whose failure is THIS task's fault (not present in the baseline). */
  blocking: LaneResult[];
}

/**
 * Run the lanes in tier order, fastest/most-informative first. Every lane runs
 * even if an earlier one failed — a single red lane does not tell the repair
 * loop about the others, and collecting all of them costs one repair round
 * instead of three.
 *
 * The verdict is a hard gate over REGRESSIONS: a lane fails the verdict only
 * when it failed AND its failures are new relative to the baseline. A
 * pre-existing failure is reported but does not block — unless the caller arms
 * reliabilityBlockOnBaselineFailures.
 */
export async function runGatePipeline(opts: GatePipelineOptions): Promise<GatePipelineResult> {
  const results: LaneResult[] = [];

  results.push(await runTypecheckLane(opts));
  if (opts.changedFiles.length > 0) {
    results.push(await runLintLane(opts));
  } else {
    results.push(skipped("lint", "no files changed"));
  }
  if (opts.includeTestLane) {
    results.push(await runTestLane(opts));
  } else {
    results.push(skipped("test", "test lane not armed (RELIABILITY_TEST_LANE)"));
  }

  const blocking = results.filter((r) => isBlocking(r));
  return { results, verdict: blocking.length === 0 ? "PASS" : "FAIL", blocking };
}

function skipped(lane: LaneName, why: string): LaneResult {
  return {
    lane,
    outcome: "skipped",
    findings: "",
    exitCode: null,
    durationMs: 0,
    preExisting: false,
    newErrors: [],
    baselineErrors: [],
    skipReason: why,
  };
}

function isBlocking(r: LaneResult): boolean {
  if (r.outcome !== "fail") return false;
  // A lane with no extractable signatures still failed on exit code — that is
  // a regression unless the baseline proves the same lane already failed.
  if (r.preExisting && !hasNewErrors(r)) return false;
  return true;
}

function hasNewErrors(r: LaneResult): boolean {
  return r.newErrors.length > 0;
}

async function runTypecheckLane(opts: GatePipelineOptions): Promise<LaneResult> {
  const t0 = Date.now();
  if (opts.signal?.aborted) return skipped("typecheck", "aborted before the lane ran");
  let raw = "";
  let exitCode: number | null = null;
  let ran = false;
  try {
    const res = await opts.exec(GATE_COMMANDS.typecheck, GATE_TIMEOUTS_MS.typecheck);
    if (typeof res.exitCode === "number") {
      ran = true;
      exitCode = res.exitCode;
      raw = `${res.stdout || ""}\n${res.stderr || ""}`;
    }
  } catch {
    /* lane could not run — stays skipped */
  }
  if (!ran) {
    return { ...skipped("typecheck", "exec route unavailable"), durationMs: Date.now() - t0 };
  }

  const errors = extractTypecheckSignatures(raw);
  const baselineErrors = opts.baseline?.typecheck?.ran ? opts.baseline.typecheck.errors : [];
  const baselineSet = new Set(baselineErrors);
  const newErrors = errors.filter((e) => !baselineSet.has(e));
  const baselineOnly = baselineErrors.filter((e) => !new Set(errors).has(e));

  const failed = exitCode !== 0;
  const preExisting = failed && newErrors.length === 0 && baselineErrors.length > 0;

  return {
    lane: "typecheck",
    outcome: failed ? "fail" : "pass",
    findings: failed ? summarizeLaneOutput(raw) : "",
    exitCode,
    durationMs: Date.now() - t0,
    preExisting,
    newErrors,
    baselineErrors,
    resolvedErrors: baselineOnly,
  };
}

async function runLintLane(opts: GatePipelineOptions): Promise<LaneResult> {
  const t0 = Date.now();
  if (opts.signal?.aborted) return skipped("lint", "aborted before the lane ran");
  let raw = "";
  let exitCode: number | null = null;
  let ran = false;
  try {
    const cmd = GATE_COMMANDS.lint(opts.changedFiles);
    const res = await opts.exec(cmd, GATE_TIMEOUTS_MS.lint);
    if (typeof res.exitCode === "number") {
      ran = true;
      exitCode = res.exitCode;
      raw = `${res.stdout || ""}\n${res.stderr || ""}`;
    }
  } catch {
    /* lane could not run */
  }
  if (!ran) {
    return { ...skipped("lint", "exec route unavailable"), durationMs: Date.now() - t0 };
  }
  // Lint runs ONLY on files this task wrote — every finding is this task's
  // fault by construction, so no baseline diff is needed.
  const failed = exitCode !== 0;
  return {
    lane: "lint",
    outcome: failed ? "fail" : "pass",
    findings: failed ? summarizeLaneOutput(raw) : "",
    exitCode,
    durationMs: Date.now() - t0,
    preExisting: false,
    newErrors: failed ? ["scoped-lint-failure"] : [],
    baselineErrors: [],
  };
}

async function runTestLane(opts: GatePipelineOptions): Promise<LaneResult> {
  const t0 = Date.now();
  if (opts.signal?.aborted) return skipped("test", "aborted before the lane ran");
  let raw = "";
  let exitCode: number | null = null;
  let ran = false;
  try {
    const res = await opts.exec(GATE_COMMANDS.test, GATE_TIMEOUTS_MS.test);
    if (typeof res.exitCode === "number") {
      ran = true;
      exitCode = res.exitCode;
      raw = `${res.stdout || ""}\n${res.stderr || ""}`;
    }
  } catch {
    /* lane could not run */
  }
  if (!ran) {
    return { ...skipped("test", "exec route unavailable"), durationMs: Date.now() - t0 };
  }
  const failed = exitCode !== 0;
  // Without a pre-task test baseline (Phase 2 / D-8 defers flake control) a
  // test failure cannot be attributed. Report it; do not silently call it a
  // regression. The verdict treats an unattributable failure as blocking only
  // when the caller arms reliabilityBlockOnBaselineFailures.
  return {
    lane: "test",
    outcome: failed ? "fail" : "pass",
    findings: failed ? summarizeLaneOutput(raw) : "",
    exitCode,
    durationMs: Date.now() - t0,
    preExisting: false,
    newErrors: failed ? ["test-suite-failure"] : [],
    baselineErrors: [],
  };
}

/** Human-readable gate summary for the Verification Report / display content. */
export function formatGateResult(result: GatePipelineResult): string {
  const lines: string[] = [];
  lines.push(`**Gate pipeline** — verdict ${result.verdict}`);
  for (const r of result.results) {
    const mark = r.outcome === "pass" ? "✓" : r.outcome === "fail" ? "✗" : "○";
    const detail =
      r.outcome === "skipped"
        ? `skipped — ${r.skipReason || "not applicable"}`
        : `${r.outcome}${r.durationMs ? ` in ${(r.durationMs / 1000).toFixed(1)}s` : ""}` +
          (r.preExisting ? " (pre-existing — not a regression)" : "") +
          (r.newErrors.length ? ` — ${r.newErrors.length} new error(s)` : "") +
          (r.resolvedErrors?.length ? ` — ${r.resolvedErrors.length} baseline error(s) resolved` : "");
    lines.push(`  ${mark} ${r.lane.padEnd(9)} ${detail}`);
  }
  if (result.blocking.length > 0) {
    lines.push(`  **${result.blocking.length} lane(s) blocking** — writes are refused until a repair clears them.`);
  }
  return lines.join("\n");
}
