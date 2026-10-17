/**
 * reliability/flags.ts — the single source of truth for every reliability
 * feature flag. Plan §15: every phase ships behind a flag that defaults OFF,
 * so the existing behaviour is byte-for-byte unchanged until a user opts in.
 *
 * Pre-audit the repo read ~19 behavioural flags as scattered `process.env`
 * literals. This module centralises the RELIABILITY_* set so the defaults are
 * greppable in one place and the gating logic cannot drift.
 *
 * Enabling any sub-flag requires RELIABILITY_GATES=1 first — a lock that is
 * armed without a pipeline to enforce it is worse than no lock at all, because
 * it would refuse writes while nothing can ever clear the lock.
 */

/** Master switch. Every other flag is a no-op unless this is "1". */
export function reliabilityGatesEnabled(): boolean {
  try {
    return process.env.RELIABILITY_GATES === "1";
  } catch {
    return false;
  }
}

/**
 * Refuse further writes while a gate lane is red (see edit-lock.ts). Requires
 * the master switch: a lock without a pipeline that can clear it would wedge a
 * task permanently.
 */
export function reliabilityEditLockEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_EDIT_LOCK === "1";
  } catch {
    return false;
  }
}

/**
 * Run the jest lane. Off by default even under the master switch because it is
 * the slowest tier (tens of seconds on a full suite); a user who wants the
 * test gate arms it explicitly.
 */
export function reliabilityTestLaneEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_TEST_LANE === "1";
  } catch {
    return false;
  }
}

/**
 * Treat pre-existing baseline failures as blocking. Off by default: the whole
 * point of baseline diagnostics is to distinguish "the agent broke this" from
 * "it was already broken", so a pre-existing failure must not block a task by
 * default — only a regression must.
 */
export function reliabilityBlockOnBaselineFailures(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_BLOCK_BASELINE === "1";
  } catch {
    return false;
  }
}

/**
 * Snapshot the workspace before writes (baseline.ts). On whenever the master
 * switch is on: without a baseline the gate cannot tell a regression from a
 * pre-existing failure, so the gate would have to block on every pre-existing
 * error — which is the behaviour the plan explicitly rejects.
 */
export function reliabilityBaselineEnabled(): boolean {
  return reliabilityGatesEnabled();
}
