/**
 * reliability/risk-tiering.ts — plan §7: review depth scaled to change risk.
 *
 * The audit (docs/reliability/AUDIT.md §2, Phase 7) found review depth was
 * NOT tiered at all: always one reviewer call, 8 files, 6000 chars, no
 * repro-test requirement — a 3-line auth change and a 900-line payments
 * rewrite got identical scrutiny. This module is the missing classifier: it
 * turns the change's shape into a tier, and the tier into how many reviewers
 * run, whether findings must carry executable repro evidence, and whether
 * mutation testing is required.
 *
 * Sensitive-path coverage: risk-classifier.ts's SENSITIVE_FILE regex
 * (risk-classifier.ts:76) is module-private, so its path fragments are
 * mirrored here by list (the audit's note that auth* files are missing from
 * that set is fixed here: auth/login/session/payment/… are first-class).
 *
 * Pure and deterministic. Consumed only under reliabilityRolesReviewEnabled()
 * (flags.ts; RELIABILITY_ROLES_REVIEW=1 on top of RELIABILITY_GATES=1).
 */

export type ChangeRiskTier = "trivial" | "standard" | "elevated" | "critical";

/**
 * Path families that raise review risk. Covers the plan-required set —
 * auth*, *auth*, login*, session*, payment*, billing*, checkout*, stripe*,
 * migration*, *.sql, middleware.ts — plus the path fragments of
 * risk-classifier.ts's SENSITIVE_FILE (that regex is not exported; its
 * fragments are mirrored here). The bare `ci` substring from SENSITIVE_FILE is
 * deliberately re-expressed as a path-component pattern `ci.<ext>`/`ci/` —
 * as a raw substring it matches "special.ts", which would over-elevate half
 * the workspace; the CI paths it meant to catch are also covered by the
 * `workflow` and `.github/` patterns below.
 */
export const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  // Plan-required families
  /auth/i, // auth*, *auth*, auth routes/dirs
  /login/i,
  /session/i,
  /payment/i,
  /billing/i,
  /checkout/i,
  /stripe/i,
  /migration/i, // migration*, prisma/migrations
  /\.sql$/i, // *.sql
  /(^|[\\/])middleware\.ts$/i, // middleware.ts
  // Mirrored from risk-classifier.ts:76 SENSITIVE_FILE
  /\.env/i,
  /\.npmrc/i,
  /\.ssh/i,
  /id_rsa/i,
  /credentials/i,
  /secret/i,
  /password/i,
  /docker-compose/i,
  /Dockerfile/i,
  /nginx/i,
  /(^|[\\/])ci(\.|$)/i, // ci.yml / ci/ — the component form of SENSITIVE_FILE's bare `ci`
  /workflow/i,
  /\.github\//i,
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /yarn\.lock$/i,
  /prisma\/migrations/i,
];

/** True when the path matches any sensitive-path family. Normalizes separators. */
export function isSensitivePath(path: string): boolean {
  const p = String(path ?? "").replace(/\\/g, "/");
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(p));
}

export interface RiskSignals {
  touchesAuth: boolean;
  touchesPayments: boolean;
  touchesMigrations: boolean;
}

const AUTH_PATH_RE = /auth|login|session/i;
const PAYMENT_PATH_RE = /payment|billing|checkout|stripe/i;
const MIGRATION_PATH_RE = /migration|\.sql$/i;

/**
 * Derive the three touch-signals from the changed files, for callers that do
 * not already know them. classifyChangeRisk ORs these with the caller's
 * explicit flags — a file name can only RAISE a change's risk, never lower it.
 */
export function deriveRiskSignals(changedFiles: string[]): RiskSignals {
  const files = (changedFiles ?? []).map((f) => String(f ?? "").replace(/\\/g, "/"));
  return {
    touchesAuth: files.some((f) => AUTH_PATH_RE.test(f)),
    touchesPayments: files.some((f) => PAYMENT_PATH_RE.test(f)),
    touchesMigrations: files.some((f) => MIGRATION_PATH_RE.test(f)),
  };
}

export interface ChangeRiskInput {
  changedFiles: string[];
  diffSizeLines: number;
  touchesAuth: boolean;
  touchesPayments: boolean;
  touchesMigrations: boolean;
  hasTests: boolean;
}

export interface ChangeRiskClassification {
  tier: ChangeRiskTier;
  reviewers: number;
  requireReproTest: boolean;
  requireMutationTesting: boolean;
}

/**
 * Classify the change and size the review:
 *   critical — auth AND payments, or migrations AND >500 lines → 4 reviewers,
 *              repro evidence AND mutation testing required;
 *   elevated — auth OR payments OR migrations OR >200 lines → 3 reviewers,
 *              repro evidence required;
 *   trivial  — ≤20 lines, no auth/payments/migrations, tests present →
 *              1 reviewer, no repro evidence required;
 *   standard — everything else → 2 reviewers.
 *
 * The touch flags are ORed with what the file names say (deriveRiskSignals):
 * an explicit false can never hide an auth file. A non-finite diffSizeLines
 * (unknown size) is treated as maximal — unknown is not an excuse for light
 * review.
 */
export function classifyChangeRisk(input: ChangeRiskInput): ChangeRiskClassification {
  const lines =
    typeof input.diffSizeLines === "number" && Number.isFinite(input.diffSizeLines)
      ? Math.max(0, input.diffSizeLines)
      : Number.MAX_SAFE_INTEGER;

  const derived = deriveRiskSignals(input.changedFiles ?? []);
  const touchesAuth = input.touchesAuth === true || derived.touchesAuth;
  const touchesPayments = input.touchesPayments === true || derived.touchesPayments;
  const touchesMigrations = input.touchesMigrations === true || derived.touchesMigrations;

  // critical — auth AND payments, or migrations AND >500 lines
  if ((touchesAuth && touchesPayments) || (touchesMigrations && lines > 500)) {
    return { tier: "critical", reviewers: 4, requireReproTest: true, requireMutationTesting: true };
  }
  // elevated — auth OR payments OR migrations OR >200 lines
  if (touchesAuth || touchesPayments || touchesMigrations || lines > 200) {
    return { tier: "elevated", reviewers: 3, requireReproTest: true, requireMutationTesting: false };
  }
  // trivial — ≤20 lines, nothing sensitive, tests present
  if (lines <= 20 && input.hasTests === true) {
    return { tier: "trivial", reviewers: 1, requireReproTest: false, requireMutationTesting: false };
  }
  // standard — everything else
  return { tier: "standard", reviewers: 2, requireReproTest: false, requireMutationTesting: false };
}
