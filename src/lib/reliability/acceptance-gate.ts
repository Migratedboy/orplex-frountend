/**
 * reliability/acceptance-gate.ts — plan §7's acceptance-first rule, made
 * checkable: a task is only DONE when every acceptance item's declared
 * `verifiedBy` lane has actually PASSED (exit-code evidence). Anything whose
 * lane did not pass lands in `unverified[]`, and the Verification Report
 * forces residualRisk >= medium for it (see verification-report.ts).
 *
 * The three buckets are deliberately distinct, mirroring the gate pipeline's
 * semantics (gates.ts / types.ts):
 *   verified   — the declared lane ran and passed.   Item is done.
 *   failed     — the declared lane ran and failed.   Known failure, carried by
 *                the lanes map / gate results — NOT an unknown, so it is NOT
 *                listed as unverified (a known red is worse than an unknown
 *                but it is not hidden).
 *   unverified — the lane was skipped, missing, or never declared. The plan's
 *                target state is unverified_checks = 0; these are the items
 *                that keep it nonzero.
 *
 * An EMPTY/absent spec declares nothing, so nothing is unverified — the
 * verification lanes still gate the verdict, and a caller that wants a
 * mandatory spec must supply one. A non-empty spec with missing lanes fails
 * CLOSED: every item whose lane cannot be found is unverified, never verified.
 *
 * No LLM is involved. Every answer here is platform evidence.
 */

import type { UnverifiedItem } from "./verification-report";
import type { LaneOutcome } from "./types";

/** One declared acceptance item. `verifiedBy` names the lane that must pass. */
export interface AcceptanceItem {
  /** Stable id; the description is the fallback label when absent. */
  id?: string;
  /** What "done" means for this item, in plain language. */
  description: string;
  /** The verification lane (typecheck/lint/test/browser/swarm/…) that must PASS. */
  verifiedBy: string;
  /** Files this item is about — surfaced in the unverified list. */
  files?: string[];
}

/** Either the bare list of items or a spec object that carries them. */
export type AcceptanceSpec = AcceptanceItem[] | { items?: AcceptanceItem[] } | null | undefined;

export interface AcceptanceTally {
  verified: number;
  failed: number;
  unverified: number;
  /** True only when every declared item's lane passed (vacuously true for an empty spec). */
  complete: boolean;
}

export interface AcceptanceEvaluation extends AcceptanceTally {
  pass: boolean;
  unverifiedItems: UnverifiedItem[];
}

function specItems(spec: AcceptanceSpec): AcceptanceItem[] {
  if (Array.isArray(spec)) return spec.filter((i) => !!i && typeof i.description === "string");
  if (spec && Array.isArray(spec.items)) return spec.items.filter((i) => !!i && typeof i.description === "string");
  return [];
}

function laneOutcome(
  lanes: Record<string, LaneOutcome> | null | undefined,
  key: string,
): LaneOutcome | undefined {
  const v = lanes?.[key];
  return v === "pass" || v === "fail" || v === "skipped" ? v : undefined;
}

/**
 * The single classifier: every declared item is sorted into verified / failed /
 * unverified from the lane map. The two public wrappers below both read this
 * result so the buckets can never disagree with each other.
 */
export function evaluateAcceptance(
  spec: AcceptanceSpec,
  lanes: Record<string, LaneOutcome> | null | undefined,
): AcceptanceEvaluation {
  const items = specItems(spec);
  const unverifiedItems: UnverifiedItem[] = [];
  let verified = 0;
  let failed = 0;

  for (const item of items) {
    const label = (item.description || "").trim() || item.id || "acceptance item";
    const key = typeof item.verifiedBy === "string" ? item.verifiedBy.trim() : "";
    if (!key) {
      unverifiedItems.push({
        area: label,
        reason: "no verification lane was declared for this acceptance item — it cannot be proven done",
        ...(item.files?.length ? { files: item.files } : {}),
      });
      continue;
    }
    const outcome = laneOutcome(lanes, key);
    if (outcome === "pass") {
      verified += 1;
    } else if (outcome === "fail") {
      failed += 1;
    } else {
      unverifiedItems.push({
        area: label,
        reason:
          outcome === "skipped"
            ? `the "${key}" lane was skipped — this was never checked`
            : `the "${key}" lane never ran (no result recorded) — this was never checked`,
        ...(item.files?.length ? { files: item.files } : {}),
      });
    }
  }

  const complete = verified === items.length;
  return {
    verified,
    failed,
    unverified: unverifiedItems.length,
    complete,
    pass: complete && failed === 0,
    unverifiedItems,
  };
}

/**
 * THE acceptance-first gate (plan §7): `pass` is true only when every declared
 * acceptance item's `verifiedBy` lane actually passed. Every not-verified item
 * comes back in `unverified[]` so the caller can feed it straight into the
 * Verification Report's unverified list (which forces residualRisk >= medium).
 */
export function verifyAcceptanceFirst(
  spec: AcceptanceSpec,
  lanes: Record<string, LaneOutcome> | null | undefined,
): { pass: boolean; unverified: UnverifiedItem[] } {
  const r = evaluateAcceptance(spec, lanes);
  return { pass: r.pass, unverified: r.unverifiedItems };
}

/** Counts for the Verification Report's `acceptance` field. */
export function tallyAcceptance(
  spec: AcceptanceSpec,
  lanes: Record<string, LaneOutcome> | null | undefined,
): AcceptanceTally {
  const r = evaluateAcceptance(spec, lanes);
  return { verified: r.verified, failed: r.failed, unverified: r.unverified, complete: r.complete };
}
