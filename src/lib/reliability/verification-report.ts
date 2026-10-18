/**
 * reliability/verification-report.ts — plan §14's Verification Report, the
 * ONE artifact that answers "what was actually checked, what was not, and how
 * risky is what shipped?" for a finished task.
 *
 * The audit (docs/reliability/AUDIT.md §2, Phase 7) found this capability
 * "PARTIAL/fragmented": computeVerdict (rubric-recorder.ts:283) is a correct
 * hard gate, the audit-bundle carries a manifest, but there is NO unverified[]
 * list and NO residualRisk — the two things a human needs to decide whether to
 * trust a close. This module reuses computeVerdict for the verdict (exit-code
 * evidence only, never letter grades — D-6: extend, do not parallel) and adds
 * the missing parts:
 *
 *   - unverified[]  — every declared-but-unproven area, with a reason.
 *   - residualRisk  — a deterministic MAX over six rules (a)-(f), plus the
 *                     acceptance-first rule: anything unverified forces at
 *                     least medium.
 *
 * Everything here is pure and deterministic. It never runs lanes, never calls
 * a model, and never reads the filesystem — the caller (the worker) passes in
 * what the platform already observed. Wiring it at task close is gated on
 * reliabilityRolesReviewEnabled() (flags.ts; RELIABILITY_ROLES_REVIEW=1 on top
 * of RELIABILITY_GATES=1) so Phase 7 is inert by default.
 */

import { computeVerdict, type Lanes as RubricLanes } from "../rubric-recorder";
import type { LaneOutcome } from "./types";
import { evaluateAcceptance, type AcceptanceItem, type AcceptanceSpec } from "./acceptance-gate";

// ---------------------------------------------------------------------------
// The report shape (plan §14)
// ---------------------------------------------------------------------------

export type UnverifiedItem = { area: string; reason: string; files?: string[] };
export type ResidualRisk = "none" | "low" | "medium" | "high";

/** One verification lane's result as it appears in the report. */
export type GateSummary = {
  lane: string;
  outcome: string;
  durationMs: number;
  newErrors: string[];
  preExisting: boolean;
};

export type VerificationReport = {
  taskId: string;
  at: string;
  verdict: "PASS" | "FAIL";
  lanes: Record<string, "pass" | "fail" | "skipped">;
  gates: Array<{ lane: string; outcome: string; durationMs: number; newErrors: string[]; preExisting: boolean }>;
  unverified: UnverifiedItem[];
  residualRisk: ResidualRisk;
  residualRiskReasons: string[];
  tamperFindings?: unknown[];
  editLockRefused?: number;
  acceptance?: { verified: number; failed: number; unverified: number; complete: boolean };
};

/** The five verification lanes, in pipeline order. Missing = skipped = never a pass. */
export const VERIFICATION_LANES = ["typecheck", "lint", "test", "browser", "swarm"] as const;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeOutcome(v: unknown): LaneOutcome {
  return v === "pass" || v === "fail" || v === "skipped" ? v : "skipped";
}

/**
 * Merge the caller's lane map with the gate results into one lane map covering
 * all five verification lanes (plus any extra lanes the caller recorded).
 * Gate results WIN over the lane map when both name the same lane: they carry
 * the exit-code evidence. A lane nobody reported is "skipped" — never a pass,
 * exactly the rule gates.ts and rubric-recorder.ts already follow.
 */
function normalizeLanes(
  lanes: Record<string, LaneOutcome> | undefined,
  gates: GateSummary[] | undefined,
): Record<string, LaneOutcome> {
  const out: Record<string, LaneOutcome> = {};
  for (const key of VERIFICATION_LANES) {
    const gate = gates?.find((g) => g && g.lane === key);
    out[key] = gate ? normalizeOutcome(gate.outcome) : normalizeOutcome(lanes?.[key]);
  }
  for (const [k, v] of Object.entries(lanes ?? {})) {
    if (!(k in out)) out[k] = normalizeOutcome(v);
  }
  return out;
}

function normalizeGate(g: GateSummary): GateSummary {
  return {
    lane: String(g.lane),
    outcome: String(g.outcome),
    durationMs: Number.isFinite(g.durationMs) ? g.durationMs : 0,
    newErrors: Array.isArray(g.newErrors) ? g.newErrors.map((e) => String(e)) : [],
    preExisting: g.preExisting === true,
  };
}

function hasBlockSeverity(f: unknown): boolean {
  if (typeof f !== "object" || f === null) return false;
  return (f as { severity?: unknown }).severity === "block";
}

// ---------------------------------------------------------------------------
// Residual risk — deterministic rules (a)-(f), plus acceptance-first
// ---------------------------------------------------------------------------

export interface ResidualRiskInput {
  /** Lane map. Missing lanes count as skipped. */
  lanes?: Record<string, LaneOutcome>;
  /** Gate results — the source for "failed with NEW errors" (rule a). */
  gates?: GateSummary[];
  /** Files this task wrote/edited — drives rule (c). */
  filesWritten?: string[];
  /** Items that were declared but never proven (acceptance-first rule). */
  unverified?: UnverifiedItem[];
  /** Tamper-detector findings (Phase 2); a "block" severity forces HIGH (rule b). */
  tamperFindings?: unknown[];
}

const RISK_RANK: Record<ResidualRisk, number> = { none: 0, low: 1, medium: 2, high: 3 };

function higher(a: ResidualRisk, b: ResidualRisk): ResidualRisk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

/**
 * Compute the residual risk as the MAXIMUM over these rules:
 *   (a) HIGH   — any lane failed WITH new errors (this task's regression);
 *   (b) HIGH   — tamperFindings contains a "block"-severity finding;
 *   (c) MEDIUM — files were written but NO verification lane ran
 *       (the rubric-recorder "files written but NO verification lane ran —
 *       task closed unverified" condition);
 *   (d) MEDIUM — the test lane is skipped while lint/typecheck passed
 *       (untested code shipped);
 *   (d') MEDIUM — acceptance items were declared but never verified
 *       (the plan's acceptance-first rule);
 *   (e) LOW    — any verification lane was skipped;
 *   (f) NONE   — otherwise.
 * `reasons` lists the reasons AT the final (maximum) level only.
 */
export function computeResidualRisk(input: ResidualRiskInput): { risk: ResidualRisk; reasons: string[] } {
  const lanes = normalizeLanes(input.lanes, input.gates);
  const triggers: Array<{ risk: ResidualRisk; reason: string }> = [];

  // (a) failed lane with NEW errors
  const newErrorLanes = (input.gates ?? []).filter(
    (g) => g && normalizeOutcome(g.outcome) === "fail" && Array.isArray(g.newErrors) && g.newErrors.length > 0,
  );
  if (newErrorLanes.length > 0) {
    const total = newErrorLanes.reduce((s, g) => s + g.newErrors.length, 0);
    triggers.push({
      risk: "high",
      reason: `the ${newErrorLanes.map((g) => g.lane).join(", ")} lane(s) failed with ${total} new error(s) this task introduced`,
    });
  }

  // (b) blocking tamper finding
  const blockingTamper = (input.tamperFindings ?? []).filter(hasBlockSeverity).length;
  if (blockingTamper > 0) {
    triggers.push({ risk: "high", reason: `tamper detection raised ${blockingTamper} blocking finding(s)` });
  }

  // (c) files written but no verification lane ran
  const wroteFiles = (input.filesWritten ?? []).length > 0;
  const laneRan = VERIFICATION_LANES.some((k) => lanes[k] !== "skipped");
  if (wroteFiles && !laneRan) {
    triggers.push({
      risk: "medium",
      reason: "files were written but no verification lane ran — the task closed unverified",
    });
  }

  // (d) untested code shipped: test lane skipped while lint/typecheck passed
  if (lanes.test === "skipped" && (lanes.typecheck === "pass" || lanes.lint === "pass")) {
    triggers.push({
      risk: "medium",
      reason: "the test lane was skipped while lint/typecheck passed — untested code shipped",
    });
  }

  // (d') acceptance-first: anything declared but not proven forces >= medium
  const unverified = (input.unverified ?? []).filter((u) => !!u);
  if (unverified.length > 0) {
    triggers.push({ risk: "medium", reason: `${unverified.length} declared acceptance item(s) were never verified` });
  }

  // (e) any verification lane skipped
  const skipped = VERIFICATION_LANES.filter((k) => lanes[k] === "skipped");
  if (skipped.length > 0) {
    triggers.push({ risk: "low", reason: `lane(s) never run: ${skipped.join(", ")}` });
  }

  // (f) none otherwise
  const risk = triggers.reduce<ResidualRisk>((max, t) => higher(max, t.risk), "none");
  const reasons = triggers.filter((t) => t.risk === risk).map((t) => t.reason);
  return { risk, reasons };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface VerificationReportInput {
  taskId: string;
  finalStatus: "done" | "error" | "aborted";
  /** ISO timestamp; defaults to now. */
  at?: string;
  /** Lane outcomes observed this task (missing lanes = skipped). */
  lanes?: Record<string, LaneOutcome>;
  /** Gate pipeline results (reliability/gates.ts LaneResult is assignable). */
  gates?: GateSummary[];
  /** Files this task wrote/edited — drives residual-risk rule (c). */
  filesWritten?: string[];
  /** Extra unverified items from outside acceptance (merged into the report). */
  unverified?: UnverifiedItem[];
  /** Acceptance spec (plan §7). Declared items whose lane did not pass are unverified. */
  acceptanceSpec?: AcceptanceSpec;
  /** Tamper-detector findings; a "block" severity forces HIGH residual risk. */
  tamperFindings?: unknown[];
  /** How many writes the edit lock refused this task. */
  editLockRefused?: number;
}

/**
 * Build THE Verification Report for one finished task.
 *
 * Verdict: reused from rubric-recorder's computeVerdict — a hard pass/fail from
 * finalStatus + lane outcomes only. Skipped lanes never fail the verdict (they
 * mean "did not apply"); they raise residualRisk instead. Acceptance
 * completeness rides in `acceptance.complete` + residualRisk, so an unverified
 * close can never look like a clean one even while the lane verdict is PASS.
 */
export function buildVerificationReport(input: VerificationReportInput): VerificationReport {
  const lanes = normalizeLanes(input.lanes, input.gates);
  const gates = (input.gates ?? []).map(normalizeGate);

  const rubricLanes: RubricLanes = {
    typecheck: lanes.typecheck,
    lint: lanes.lint,
    test: lanes.test,
    browser: lanes.browser,
    swarm: lanes.swarm,
  };
  const { verdict } = computeVerdict(input.finalStatus, rubricLanes);

  const acceptance = input.acceptanceSpec !== undefined && input.acceptanceSpec !== null
    ? evaluateAcceptance(input.acceptanceSpec, lanes)
    : null;

  const unverified: UnverifiedItem[] = [
    ...(input.unverified ?? []).filter((u) => !!u),
    ...(acceptance?.unverifiedItems ?? []),
  ];

  const risk = computeResidualRisk({
    lanes,
    gates,
    filesWritten: input.filesWritten,
    unverified,
    tamperFindings: input.tamperFindings,
  });

  const report: VerificationReport = {
    taskId: input.taskId,
    at: input.at ?? new Date().toISOString(),
    verdict,
    lanes,
    gates,
    unverified,
    residualRisk: risk.risk,
    residualRiskReasons: risk.reasons,
  };
  if (input.tamperFindings !== undefined) report.tamperFindings = input.tamperFindings;
  if (typeof input.editLockRefused === "number") report.editLockRefused = input.editLockRefused;
  if (acceptance) {
    report.acceptance = {
      verified: acceptance.verified,
      failed: acceptance.failed,
      unverified: acceptance.unverified,
      complete: acceptance.complete,
    };
  }
  return report;
}

// ---------------------------------------------------------------------------
// Human-readable formatting — this block is what a user actually reads
// ---------------------------------------------------------------------------

const LANE_LABEL: Record<LaneOutcome, string> = { pass: "passed", fail: "FAILED", skipped: "not run" };

const RISK_GLOSS: Record<ResidualRisk, string> = {
  none: "everything that shipped was checked",
  low: "some checks were skipped; nothing failed",
  medium: "parts of this change were never checked",
  high: "this change introduced failures or a blocking finding",
};

/**
 * A compact, plain-language block suitable for appending to a task's final
 * transcript: verdict, every lane in plain words, the unverified items
 * explicitly, and the residual risk with its reasons. No jargon where a plain
 * word exists ("not run" for skipped, "FAILED" for fail).
 */
export function formatVerificationReport(report: VerificationReport): string {
  const lines: string[] = [];
  lines.push(`VERIFICATION REPORT — task ${report.taskId} (${report.at})`);
  lines.push(
    report.verdict === "PASS"
      ? "Result: PASS — every check that ran came back clean"
      : "Result: FAIL — at least one check failed",
  );
  lines.push("");
  lines.push("Checks:");
  for (const [lane, outcome] of Object.entries(report.lanes)) {
    lines.push(`  ${lane.padEnd(11)} ${LANE_LABEL[outcome] || String(outcome)}`);
  }

  const failing = report.gates.filter((g) => g.outcome === "fail");
  if (failing.length > 0) {
    lines.push("");
    lines.push("Failed checks:");
    for (const g of failing) {
      const errs =
        g.newErrors.length > 0
          ? ` — ${g.newErrors.length} new error(s): ${g.newErrors.slice(0, 3).join(", ")}${g.newErrors.length > 3 ? ", …" : ""}`
          : "";
      const pre = g.preExisting ? " (pre-existing — not caused by this task)" : "";
      lines.push(`  ${g.lane}: FAILED${errs}${pre}`);
    }
  }

  if (report.acceptance) {
    const a = report.acceptance;
    lines.push("");
    lines.push(
      `Acceptance: ${a.verified} verified, ${a.failed} failed, ${a.unverified} not verified — ${a.complete ? "complete" : "INCOMPLETE"}`,
    );
  }

  if (report.unverified.length > 0) {
    lines.push("");
    lines.push(`Not verified (${report.unverified.length}):`);
    for (const u of report.unverified) {
      lines.push(`  - ${u.area}: ${u.reason}`);
      if (u.files && u.files.length > 0) {
        lines.push(`      files: ${u.files.slice(0, 5).join(", ")}${u.files.length > 5 ? ", …" : ""}`);
      }
    }
  } else {
    lines.push("");
    lines.push("Not verified: nothing — every declared check was accounted for.");
  }

  if (report.tamperFindings && report.tamperFindings.length > 0) {
    lines.push(`Tamper signals: ${report.tamperFindings.length} finding(s) — a blocking one forces HIGH residual risk.`);
  }
  if (typeof report.editLockRefused === "number" && report.editLockRefused > 0) {
    lines.push(`Writes refused while a check was red: ${report.editLockRefused}.`);
  }

  lines.push("");
  lines.push(`Residual risk: ${report.residualRisk.toUpperCase()} — ${RISK_GLOSS[report.residualRisk]}`);
  if (report.residualRiskReasons.length > 0) {
    for (const r of report.residualRiskReasons) lines.push(`  - ${r}`);
  } else {
    lines.push("  - nothing was left unchecked");
  }
  return lines.join("\n");
}
