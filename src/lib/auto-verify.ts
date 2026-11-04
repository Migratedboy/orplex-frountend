/**
 * auto-verify.ts — the auto-verification contract (closed-loop autonomy),
 * extracted verbatim from background-worker.ts (Operation Modularity).
 *
 * After the tool loop + self-review, the worker compile-checks the workspace
 * (npx tsc --noEmit via /api/agent/exec) and feeds failures back to the model
 * for repair — up to MAX_REPAIR_ROUNDS rounds — so tasks end VERIFIED, not
 * just written. Code/plan mode only, and only when a workspace folder is open
 * (otherwise exec would typecheck Orplex's own directory).
 *
 * The verification LOOP itself (exec + repair rounds + browser verify lane)
 * stays in background-worker.ts; this module owns the pure contract: the
 * constants, the tsc-output summarizer, and the repair-prompt builder.
 */
import { verificationRepairDirective } from "./master-prompt";

// === Auto-verification (closed-loop autonomy) ===============================
// After the tool loop + self-review, the worker compile-checks the workspace
// (npx tsc --noEmit via /api/agent/exec) and feeds failures back to the model
// for repair — up to MAX_REPAIR_ROUNDS rounds — so tasks end VERIFIED, not
// just written. Code/plan mode only, and only when a workspace folder is open
// (otherwise exec would typecheck Orplex's own directory).

export const VERIFY_COMMAND = "npx tsc --noEmit";
export const VERIFY_TIMEOUT_MS = 120_000;
export const MAX_REPAIR_ROUNDS = 2;

const TYPECHECK_ERROR_RE = /\berror TS\d+:/;

/** Extract deduped `error TSxxxx` lines from tsc output. "" when clean. */
export function summarizeTypecheckOutput(raw: string, maxErrors = 8): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of (raw || "").split("\n")) {
    // No tsconfig / no TS inputs — this project has nothing to typecheck.
    if (/TS18003/.test(line)) continue;
    if (!TYPECHECK_ERROR_RE.test(line)) continue;
    const trimmed = line.trimEnd();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxErrors) break;
  }
  return out.join("\n");
}

/** Repair prompt fed back to the model after a failed verification round. */
export function buildVerificationRepairPrompt(findings: string, files: string[]): string {
  // Text lives in the master prompt (single source of truth).
  return verificationRepairDirective(findings, files);
}
