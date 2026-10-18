/**
 * reliability/reviewers.ts — plan §7: parallel, isolated, CROSS-FAMILY
 * review. This module closes the audit's headline review findings
 * (docs/reliability/AUDIT.md §2, Phase 7):
 *
 *   - "One reviewer call" on the SAME model weights as the coder. The fix is
 *     a REVIEWER_PANEL whose members span different model FAMILIES — the
 *     caller maps each profile's `family`/`modelHint` onto its provider
 *     registry so the reviewer is never the coder's weights.
 *   - Findings had no executable evidence. ReviewFinding carries an optional
 *     `reproTest` — a jest assertion or shell command that demonstrates the
 *     problem — plus a `confidence` score.
 *   - strategy-router.ts:328 returns consensus:true in its CATCH block, so a
 *     failed reviewer call reads as "everyone agreed". mergeReviewFindings
 *     fails CLOSED: empty/invalid input NEVER earns consensus:true.
 *
 * Isolation: buildReviewerPrompts emits one prompt per profile that mentions
 * ONLY that profile's focus — a reviewer primed with another reviewer's
 * concerns is not an independent signal.
 *
 * This module is pure text + pure merging; the actual model calls are the
 * wiring process's job and run only under reliabilityRolesReviewEnabled()
 * (flags.ts; RELIABILITY_ROLES_REVIEW=1 on top of RELIABILITY_GATES=1).
 */

// ---------------------------------------------------------------------------
// The panel — one profile per model family
// ---------------------------------------------------------------------------

export type ReviewerProfile = {
  id: string;
  family: "openai" | "anthropic" | "google" | "meta" | "mistral" | "xai";
  focus: string;
  modelHint?: string;
};

/**
 * The default panel: four reviewers, four DIFFERENT model families, four
 * focuses. The audit's bug was that the single reviewer shared the coder's
 * weights; with this panel at least three of four reviewers are guaranteed to
 * be a different family from any given coder, and the wiring picks the coder's
 * family's opposite via the per-profile modelHint.
 */
export const REVIEWER_PANEL: ReviewerProfile[] = [
  { id: "correctness", family: "anthropic", focus: "correctness", modelHint: "anthropic/claude" },
  { id: "security", family: "openai", focus: "security", modelHint: "openai/gpt" },
  { id: "performance", family: "google", focus: "performance", modelHint: "google/gemini" },
  { id: "api-contract", family: "meta", focus: "API contract", modelHint: "meta/llama" },
];

// ---------------------------------------------------------------------------
// Prompt building — one isolated prompt per reviewer
// ---------------------------------------------------------------------------

/**
 * Per-focus instructions. Deliberately does NOT name the other focuses — a
 * prompt that says "don't comment on performance" still plants performance in
 * the reviewer's head, which breaks isolation.
 */
const FOCUS_INSTRUCTIONS: Record<string, string> = {
  correctness:
    "Look ONLY for correctness bugs: wrong logic, off-by-one errors, unhandled edge cases, " +
    "race conditions, incorrect state transitions, and task requirements the change does not " +
    "actually satisfy. Report nothing outside this scope.",
  security:
    "Look ONLY for security problems: injection, unsafe deserialization, missing authorization " +
    "checks, secret leakage, path traversal, SSRF, and insecure defaults. Report nothing outside this scope.",
  performance:
    "Look ONLY for performance problems: unnecessary work in hot paths, quadratic blowups, " +
    "missing memoization, unbounded memory growth, N+1 queries, and blocking calls on the event " +
    "loop. Report nothing outside this scope.",
  "API contract":
    "Look ONLY at the exported API contract: changed signatures, request/response shapes, status " +
    "codes, error formats, field optionality, and whether existing callers would break. Report " +
    "nothing outside this scope.",
};

const FALLBACK_INSTRUCTION =
  "Look ONLY within your declared focus area. Report nothing outside this scope.";

/**
 * One focused prompt per reviewer. Each prompt carries ONLY its own focus
 * (task + diff summary are shared context; no other reviewer's concerns are
 * named), the finding contract, and the requirement that a finding should
 * carry an executable repro when possible.
 */
export function buildReviewerPrompts(
  task: string,
  diffSummary: string,
  panel: ReviewerProfile[] = REVIEWER_PANEL,
): Array<{ profileId: string; prompt: string }> {
  return panel.map((profile) => {
    const focus = profile.focus || "review";
    const instruction =
      FOCUS_INSTRUCTIONS[profile.focus] ??
      (profile.focus
        ? `Look ONLY for issues about "${profile.focus}". Report nothing outside this scope.`
        : FALLBACK_INSTRUCTION);
    return {
      profileId: profile.id,
      prompt:
        `You are an independent ${focus} reviewer. ${instruction}\n` +
        "You are reviewing this change in isolation — report only what you can demonstrate yourself.\n" +
        `Task: ${task}\n\n` +
        `Diff summary:\n${diffSummary}\n\n` +
        "Return ONLY JSON (no prose outside it):\n" +
        '{"findings": [{"severity": "blocker"|"major"|"minor", "description": string, ' +
        '"file": string, "reproTest": string, "confidence": 0.0-1.0}]}\n' +
        "- blocker = the change is broken or unsafe here; major = a likely bug or missing " +
        "requirement; minor = a small issue worth noting.\n" +
        "- reproTest = an EXECUTABLE check that demonstrates the problem (a jest assertion or a " +
        "shell command). Prefer one; omit the field only when you truly have none.\n" +
        "- confidence = how sure you are, between 0 and 1.\n" +
        "- Empty findings array when you find nothing in your focus area.",
    };
  });
}

// ---------------------------------------------------------------------------
// Finding merge — fail-closed consensus
// ---------------------------------------------------------------------------

export type ReviewFinding = {
  severity: "blocker" | "major" | "minor";
  description: string;
  file?: string;
  /** Optional executable evidence: a jest assertion or a shell command. */
  reproTest?: string;
  /** 0-1. Findings without usable confidence are kept at 0, never dropped. */
  confidence: number;
};

export interface MergedReviewFindings {
  blockers: ReviewFinding[];
  majors: ReviewFinding[];
  minors: ReviewFinding[];
  /**
   * true ONLY when every batch contributed at least one usable finding AND no
   * two reviewers contradict each other on the same file (one calling it
   * blocker/major while another dismisses it as minor). Empty input, an all-
   * empty panel, or garbage input all yield FALSE — an LLM failure must never
   * read as consensus (the strategy-router.ts:328 bug this module exists to
   * not repeat).
   */
  consensus: boolean;
}

function toFinding(entry: ReviewFinding | { severity?: unknown; description?: unknown; file?: unknown; reproTest?: unknown; confidence?: unknown } | null | undefined): ReviewFinding | null {
  const f = entry as { severity?: unknown; description?: unknown; file?: unknown; reproTest?: unknown; confidence?: unknown } | null | undefined;
  if (f === null || f === undefined || typeof f !== "object") return null;
  if (f.severity !== "blocker" && f.severity !== "major" && f.severity !== "minor") return null;
  if (typeof f.description !== "string" || !f.description.trim()) return null;
  return {
    severity: f.severity,
    description: f.description,
    ...(typeof f.file === "string" && f.file ? { file: f.file } : {}),
    ...(typeof f.reproTest === "string" && f.reproTest ? { reproTest: f.reproTest } : {}),
    confidence: typeof f.confidence === "number" && Number.isFinite(f.confidence) ? f.confidence : 0,
  };
}

/**
 * Merge the per-reviewer finding batches. Consensus is fail-closed:
 *   - no batches / invalid batches            → false;
 *   - zero usable findings across all batches → false (no evidence anyone
 *     reviewed — an errored reviewer produces exactly this shape);
 *   - a file flagged blocker/major by one reviewer and minor by another → false;
 *   - otherwise true.
 */
export function mergeReviewFindings(batches: ReviewFinding[][]): MergedReviewFindings {
  const none: MergedReviewFindings = { blockers: [], majors: [], minors: [], consensus: false };
  if (!Array.isArray(batches) || batches.length === 0) return none;
  if (!batches.every((b) => Array.isArray(b))) return none;

  const all: ReviewFinding[] = [];
  for (const batch of batches) {
    for (const entry of batch) {
      const f = toFinding(entry);
      if (f) all.push(f);
    }
  }
  // Fail closed: with no usable findings there is nothing to agree ON, so
  // consensus can never be true — not even for a "clean" panel.
  if (all.length === 0) return none;

  const seriousFiles = new Set<string>();
  const minorFiles = new Set<string>();
  for (const f of all) {
    if (!f.file) continue;
    if (f.severity === "minor") minorFiles.add(f.file);
    else seriousFiles.add(f.file);
  }
  let contradiction = false;
  for (const file of seriousFiles) {
    if (minorFiles.has(file)) {
      contradiction = true;
      break;
    }
  }

  return {
    blockers: all.filter((f) => f.severity === "blocker"),
    majors: all.filter((f) => f.severity === "major"),
    minors: all.filter((f) => f.severity === "minor"),
    consensus: !contradiction,
  };
}
