// effort.ts — Complexity-based effort budgeting for the agent loops.
//
// Every loop constant used to be a single fixed value (MAX_TOOL_TURNS=120,
// TURN_LIMIT=60, one repair round, one verify round) regardless of whether
// the task is "fix this typo" or "build a three-page fullstack app". That
// wastes the free-tier TPM budget on trivial tasks and under-provisions
// genuinely complex ones.
//
// estimateComplexity scores the task prompt into a tier; effortForTier maps
// the tier onto per-loop constants. Pure + deterministic (no ML, no network)
// so both lanes and the tests can call it freely.

export type ComplexityTier = "trivial" | "standard" | "elevated" | "critical";

export interface ComplexityEstimate {
  /** 0–10 heuristic score. */
  score: number;
  tier: ComplexityTier;
  /** Signals that raised the score (max 4, terse) — surfaced in status. */
  reasons: string[];
}

export interface EffortBudget {
  /** Turn cap for the main tool loop. */
  maxTurns: number;
  /** Typecheck/self-review repair rounds after the loop. */
  repairRounds: number;
  /** How many verify→repair iterations the verification lane may run. */
  verifyRounds: number;
  /** Max read-only tool calls dispatched concurrently within one turn. */
  parallelToolLimit: number;
  /** Max concurrent subagents a run may spawn (spawn_subagent). */
  subagentLimit: number;
}

/** Scaled from the loop's own base constants so a lane can subclass. */
export function effortForTier(tier: ComplexityTier, base: EffortBudget): EffortBudget {
  switch (tier) {
    case "trivial":
      return {
        maxTurns: Math.max(8, Math.floor(base.maxTurns * 0.4)),
        // Two typecheck CYCLES (detect → repair → detect again) — the loop
        // treats the final cycle as check-only, so 1 would mean "verify and
        // fail without a repair", which regressed the auto-verify contract.
        repairRounds: 2,
        verifyRounds: 1,
        parallelToolLimit: 2,
        subagentLimit: 0,
      };
    case "standard":
      return base;
    case "elevated":
      return {
        maxTurns: Math.floor(base.maxTurns * 1.3),
        repairRounds: Math.max(base.repairRounds, 2),
        verifyRounds: Math.max(base.verifyRounds, 3),
        parallelToolLimit: Math.max(base.parallelToolLimit, 4),
        subagentLimit: Math.max(base.subagentLimit, 2),
      };
    case "critical":
      return {
        maxTurns: Math.floor(base.maxTurns * 1.6),
        repairRounds: Math.max(base.repairRounds, 3),
        verifyRounds: Math.max(base.verifyRounds, 3),
        parallelToolLimit: Math.max(base.parallelToolLimit, 4),
        subagentLimit: Math.max(base.subagentLimit, 3),
      };
  }
}

interface ComplexitySignals {
  /** Task prompt (user turn). */
  prompt: string;
  /** Number of files the task already touches (orchestrator writes / todos). */
  fileCount?: number;
  /** Optional model-side effort override string (e.g. "low"|"high"). */
  effortOverride?: string | null;
}

const FULLSTACK_WORDS =
  /\b(full[- ]?stack|authentication|auth system|database|schema|migration|payment|checkout|deploy(?:ment)?|api +layer|e2e|integration test|refactor (?:the |whole |entire)|monorepo|microservice)/i;
const MULTI_PART_WORDS =
  /\b(multiple files|several (?:files|pages|components|endpoints)|across (?:files|modules)|(?:every|each|all) (?:file|page|component)|step[- ]by[- ]step|phases)/i;

function clamp(n: number, lo = 0, hi = 10): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * Heuristic 0–10 complexity score. Deliberately generous to trivial: a
 * default that over-routes every task to "critical" would just burn the
 * free-tier window; under-provisioning is the rarer, recoverable direction
 * because the safety-continue gate can extend a run interactively.
 */
export function estimateComplexity(input: ComplexitySignals): ComplexityEstimate {
  const reasons: string[] = [];
  const prompt = (input.prompt || "").trim();
  let score = 1;

  if (prompt.length > 400) { score += 2; reasons.push("long prompt"); }
  else if (prompt.length > 120) { score += 1; }
  if (MULTI_PART_WORDS.test(prompt)) { score += 2; reasons.push("multi-part wording"); }
  if (FULLSTACK_WORDS.test(prompt)) { score += 3; reasons.push("fullstack-scale keywords"); }
  const fileHits = (prompt.match(/\b[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|css|html|md)\b/g) || []).length;
  if (fileHits >= 4) { score += 2; reasons.push("many named files"); }
  else if (fileHits >= 1) { score += 1; }
  if ((input.fileCount ?? 0) >= 3) { score += 1; reasons.push("pre-planned files"); }

  if (input.effortOverride) {
    const o = input.effortOverride.toLowerCase().trim();
    if (o === "low" || o === "min" || o === "minimal") return { score: 0, tier: "trivial", reasons: ["effort=low override"] };
    if (o === "high" || o === "max" || o === "maximum") return { score: 10, tier: "critical", reasons: ["effort=high override"] };
  }

  score = clamp(score);
  return {
    score,
    reasons: reasons.slice(0, 4),
    tier: score >= 8 ? "critical" : score >= 5 ? "elevated" : score >= 3 ? "standard" : "trivial",
  };
}
