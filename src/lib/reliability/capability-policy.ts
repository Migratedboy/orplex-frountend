/**
 * reliability/capability-policy.ts — Phase 4: the capability gate
 * (AUDIT.md §Phase4 "Taint policy: ABSENT — zero hits for `taint` repo-wide";
 * the plan clause "the pipeline detects, reports, annotates, and remembers.
 * It does not gate" is exactly what this module breaks).
 *
 * Inputs are the pure ledgers this phase builds: the call's Provenance (where
 * the tool call came from — provenance.ts), the task's TaintStore (which
 * paths/strings were produced by risky content), and the egress policy
 * (egress-policy.ts). Output is a decision the DISPATCH SITE can enforce
 * mechanically: blocked → the call never runs; requiresApproval → the call
 * runs only after the existing (risk-classifier / plan-gate) approval flow
 * says yes; reasons[] is the human-readable evidence trail for both.
 *
 * Default OFF: every decision here is conditional on the
 * RELIABILITY_CAPABILITY_POLICY flag (which itself requires the
 * RELIABILITY_GATES master switch). With the flag off the evaluation returns
 * a not-blocked result carrying a note — call sites keep wiring through this
 * module (so the annotations still happen) but nothing refuses until a user
 * opts in, per plan §15 / the flags.ts header rule.
 */
import { classifyEgress } from "./egress-policy";
import { reliabilityCapabilityPolicyEnabled } from "./flags";
import type { Provenance, TaintStore } from "./provenance";

export interface CallCapabilityInput {
  /** Tool name as dispatched ("write_file", "run_command", …). */
  tool: string;
  /** Target path for write-shaped tools. */
  path?: string;
  /** Shell command for run_command. */
  command?: string;
  /** Provenance of the CALL ITSELF (who asked for it). */
  provenance: Provenance;
  /** The task's taint ledger (paths/values produced by risky content). */
  taint: TaintStore;
}

export interface CallCapability {
  tool: string;
  path?: string;
  command?: string;
  provenance: Provenance;
  requiresApproval: boolean;
  blocked: boolean;
  /** Human-readable evidence, one entry per rule hit. */
  reasons: string[];
}

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "batch_edit",
  "write_file_chunk",
  "apply_edit_ops",
]);

const COMMAND_TOOLS = new Set(["run_command", "run_in_sandbox", "terminal_exec"]);

/** Provenances that mean "the model, in prose, made this up" or worse. */
const PROSE_LEVEL: readonly Provenance[] = ["prose_tool", "bare_json", "orchestrator", "directive", "repair"];

/** A path carrying this provenance came through content the scanner flagged. */
const TAINTED_WRITE_PROVENANCES: readonly Provenance[] = [
  "read_file",
  "tool_output",
  "prose_tool",
  "bare_json",
  "orchestrator",
  "directive",
  "repair",
];

/**
 * Evaluate one tool call against the capability policy. Pure (no env reads
 * beyond the flag), synchronous, throws nothing: invalid input degrades to
 * a not-blocked result with a note — a broken policy must never wedge the
 * tool loop, it annotates instead.
 */
export function evaluateCallCapability(input: CallCapabilityInput): CallCapability {
  const tool = input.tool;
  const path = input.path;
  const command = input.command;
  const provenance = input.provenance;
  const taint = input.taint;

  const noop: CallCapability = {
    tool,
    path,
    command,
    provenance,
    requiresApproval: false,
    blocked: false,
    reasons: [],
  };

  if (!reliabilityCapabilityPolicyEnabled()) {
    return { ...noop, reasons: ["capability-policy flag is off — evaluation is annotation-only"] };
  }

  const policy = "capability-policy";
  const reasons: string[] = [];
  let blocked = false;
  let requiresApproval = false;

  // (a) write/edit shapes whose call provenance reads as undecipherable
  // model prose or worse must never edit a file without a human in the loop.
  if (WRITE_TOOLS.has(tool) && PROSE_LEVEL.includes(provenance)) {
    blocked = true;
    reasons.push(
      `${policy}: ${tool} carries provenance "${provenance}" — write-shaped calls from model-prose, bare-JSON, orchestrator, directive or repair origins are blocked (rule a)`,
    );
  }

  // (b) same for command execution, plus the directive origin: a
  // prompt-injected instruction must not be able to reach the shell.
  if (COMMAND_TOOLS.has(tool) && PROSE_LEVEL.includes(provenance)) {
    blocked = true;
    reasons.push(
      `${policy}: ${tool} carries provenance "${provenance}" — command execution from model-prose, bare-JSON, orchestrator, directive or repair origins is blocked (rule b)`,
    );
  }

  // (c) egress allowlist (including the network-to-shell pipe that egress
  // treats as always-denied).
  if (COMMAND_TOOLS.has(tool) && command) {
    const verdict = classifyEgress(command);
    if (!verdict.allowed) {
      blocked = true;
      reasons.push(`${policy}: egress denial — ${verdict.reason} (rule c)`);
    }
    if (verdict.destinations.length > 0 && !blocked) {
      reasons.push(
        `${policy}: egress destinations ${verdict.destinations.join(", ")} are allowlisted (pass)`,
      );
    }
  }

  // (d) writing over a path tainted by previously-read untrusted content
  // requires the normal approval flow (WARN, not BLOCK — the human decides).
  if (WRITE_TOOLS.has(tool) && path && TAINTED_WRITE_PROVENANCES.includes(provenance) && taint.isTainted(path)) {
    requiresApproval = true;
    reasons.push(
      `${policy}: ${tool} targets "${path}" which is tainted as "${taint.get(path)}" — approval required before overwrite (rule d)`,
    );
  }

  return {
    tool,
    path,
    command,
    provenance,
    requiresApproval,
    blocked,
    reasons,
  };
}
