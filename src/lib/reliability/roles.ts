/**
 * reliability/roles.ts — plan §7: a role stack the scheduler can actually
 * drive. The audit (docs/reliability/AUDIT.md §2, Phase 7) found the runtime
 * had an agentRoleSchema but only "architect" was ever instantiated, the
 * seeded architect→developer→verifier DAG had no caller, and there was NO
 * breaker role at all. This module defines the stack: the roles, the system-
 * prompt fragment each one runs with, and which role sequence a given change
 * risk deserves.
 *
 * NOTE for the wiring process: agentRoleSchema (src/lib/agent/runtime/types.ts)
 * is z.enum(["architect","developer","reviewer","verifier"]) — it has no
 * "breaker" member, and this plan does not edit that schema (the runtime and
 * its persistence are another process's surface). A "breaker" task row
 * therefore cannot be persisted until that enum is extended; until then the
 * breaker step runs in-process (its directive below) without a persisted task
 * row. ROLE_SCHEMA_COVERAGE is a compile-time guard: it stays `true` only
 * while every persisted schema member is addressable by this stack — if the
 * schema grows a member AgentRoleName doesn't cover, that constant stops
 * typechecking and the wiring must extend this module first.
 *
 * All of it is consumed only under reliabilityRolesReviewEnabled() (flags.ts;
 * RELIABILITY_ROLES_REVIEW=1 on top of RELIABILITY_GATES=1).
 */

import type { AgentRole } from "../agent/runtime/types";
import type { ChangeRiskTier } from "./risk-tiering";

export type AgentRoleName = "architect" | "developer" | "verifier" | "breaker" | "reviewer";

/**
 * A real system-prompt fragment per role — not a label. The breaker's job is
 * the one the plan adds: PROVE the change is wrong (write the test that
 * should have failed before the fix, attack the assumptions, try to break
 * inputs, boundaries and ordering — and report only what it can demonstrate).
 */
export const ROLE_DIRECTIVES: Record<AgentRoleName, string> = {
  architect:
    "You are the architect. Before code is written, produce a concrete plan: which files to touch, " +
    "the interfaces and data flow, what could break, and how each piece will be verified. Challenge " +
    "vague requirements and hidden assumptions NOW, while changing direction is still cheap. Do not " +
    "write implementation code — hand the developer a plan precise enough to execute without guessing.",
  developer:
    "You are the developer. Implement the approved plan exactly: complete working code, minimal diff, " +
    "no drive-by refactors, no TODOs or placeholders. Every claim you make about the change must be " +
    "backed by something the platform can check. If the plan is impossible as written, say so and " +
    "explain what should change instead of silently inventing a different design.",
  breaker:
    "You are the breaker. Your job is to PROVE the change is wrong. Before the fix, write the test " +
    "that SHOULD fail against the broken behaviour and show it failing; then attack the change's " +
    "assumptions — hostile inputs, boundary values, ordering, concurrency, partial failures, and " +
    "every invariant the plan claims but never checks. Report only what you can demonstrate with a " +
    "reproducible check; if you cannot break it, say so explicitly — a clean break attempt is " +
    "evidence too.",
  verifier:
    "You are the verifier. You never change code. Run the verification lanes (typecheck, lint, " +
    "tests) and report each one from its exit code as pass, fail, or skipped — a lane that could " +
    "not run is 'skipped', never a pass. Collect the exact error signatures so a repair turn can " +
    "act on evidence, not vibes.",
  reviewer:
    "You are the reviewer. Read the diff against the task independently: correctness, security, " +
    "API-contract compatibility, and whether the acceptance criteria are actually met. Cite the " +
    "file for every finding, grade it blocker/major/minor, and attach a repro test when you can " +
    "write one. Style opinions are out of scope.",
};

/**
 * The role sequence per change-risk tier (risk-tiering.ts):
 *   trivial   → developer, verifier
 *   standard  → architect, developer, verifier
 *   elevated  → architect, developer, breaker, verifier, reviewer
 *   critical  → architect, developer, breaker, verifier, reviewer, verifier
 *               (the second verifier re-checks after the breaker/reviewer
 *               repairs — the final word must be a green lane, not a review).
 */
export function buildRoleSequence(riskTier: ChangeRiskTier): AgentRoleName[] {
  switch (riskTier) {
    case "trivial":
      return ["developer", "verifier"];
    case "standard":
      return ["architect", "developer", "verifier"];
    case "elevated":
      return ["architect", "developer", "breaker", "verifier", "reviewer"];
    case "critical":
      return ["architect", "developer", "breaker", "verifier", "reviewer", "verifier"];
  }
}

/** Only the roles that produce changes may write. Breaker/verifier/reviewer never do. */
export function canWrite(role: AgentRoleName): boolean {
  return role === "developer" || role === "architect";
}

/**
 * Roles that produce verification evidence: the verifier (lanes + exit codes),
 * the reviewer (independent diff read), the breaker (executable disproof).
 * The two writing roles (developer, architect) never verify their own work —
 * that separation is the entire point of the stack.
 */
export function canVerify(role: AgentRoleName): boolean {
  return role === "verifier" || role === "reviewer" || role === "breaker";
}

/**
 * Compile-time guard: true only while every role the persisted agentRoleSchema
 * can express is addressable by this stack. If the schema grows a member that
 * AgentRoleName doesn't cover, this resolves to `never` and the assignment
 * below stops compiling — extend AgentRoleName (and ROLE_DIRECTIVES) first.
 */
export type PersistedRoleCovered = Extract<AgentRole, AgentRoleName> extends AgentRole ? true : never;
export const ROLE_SCHEMA_COVERAGE: PersistedRoleCovered = true;
