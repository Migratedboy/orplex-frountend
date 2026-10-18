/**
 * reliability/protected-paths.ts — Phase 2. The single source of truth for
 * which paths the agent must never silently rewrite: test files, test
 * directories, CI configuration, and test infrastructure.
 *
 * Why this exists: risk-classifier.ts used to list "test/", "tests/" and
 * "__tests__/" inside SAFE_WRITE_PREFIXES, i.e. the approval tier treated test
 * writes as the *safest* writes in the repo. That is exactly backwards — a
 * model that can silently edit tests can make any gate green (the Phase 0
 * baseline's test-deletion trap passed for precisely this reason). These
 * patterns invert that: matching paths classify as high risk in
 * classifyRisk() unless the user sets RELIABILITY_PROTECTED_WRITE_OVERRIDE=1.
 *
 * Matching rules:
 *   - Paths are normalised to posix separators ("\" -> "/") and a leading
 *     "./" is stripped before matching.
 *   - Basename patterns (*.test.*, *.spec.*, jest.config.*, Jenkinsfile, …)
 *     match at ANY depth: src/lib/__tests__/foo.test.ts matches just as
 *     foo.test.ts does.
 *   - Directory patterns (test/, tests/, __tests__/, e2e/, playwright/,
 *     coverage/, .nyc_output/, .github/workflows/) match as whole path
 *     segments only, so src/test-utils/… does NOT match "test/".
 *   - Matching is case-insensitive: on a case-insensitive filesystem the
 *     protection must still hold.
 */

/** One protected-path rule: a stable id, a human label, and its regex. */
export interface ProtectedPathPattern {
  /** Stable machine id (greppable, used by tests). */
  id: string;
  /** Human description surfaced in approval dialogs / reason strings. */
  label: string;
  /** Tested against the normalised posix path. */
  pattern: RegExp;
}

/**
 * Every protected path class, plan Phase 2: test files (*.test.*, *.spec.*),
 * test dirs (__tests__/, test/, tests/, e2e/, playwright/), CI config
 * (.github/workflows/*, .gitlab-ci.yml, Jenkinsfile) and test infra
 * (jest.config.*, vitest.config.*, playwright.config.*, coverage/,
 * .nyc_output/). First match wins; see matchProtectedPath.
 */
export const PROTECTED_PATH_PATTERNS: readonly ProtectedPathPattern[] = [
  {
    id: "test-file",
    label: "test file (*.test.* / *.spec.*)",
    pattern: /(^|\/)[^/]+\.(test|spec)\./i,
  },
  {
    id: "dunder-tests-dir",
    label: "test directory (__tests__/)",
    pattern: /(^|\/)__tests__(\/|$)/i,
  },
  {
    id: "test-dir",
    label: "test directory (test/)",
    pattern: /(^|\/)test(\/|$)/i,
  },
  {
    id: "tests-dir",
    label: "test directory (tests/)",
    pattern: /(^|\/)tests(\/|$)/i,
  },
  {
    id: "e2e-dir",
    label: "e2e directory (e2e/)",
    pattern: /(^|\/)e2e(\/|$)/i,
  },
  {
    id: "playwright-dir",
    label: "playwright directory (playwright/)",
    pattern: /(^|\/)playwright(\/|$)/i,
  },
  {
    id: "github-workflows",
    label: "GitHub Actions workflow (.github/workflows/)",
    pattern: /(^|\/)\.github\/workflows(\/|$)/i,
  },
  {
    id: "gitlab-ci",
    label: "GitLab CI config (.gitlab-ci.yml)",
    pattern: /(^|\/)\.gitlab-ci\.ya?ml$/i,
  },
  {
    id: "jenkinsfile",
    label: "Jenkins CI config (Jenkinsfile)",
    pattern: /(^|\/)jenkinsfile$/i,
  },
  {
    id: "jest-config",
    label: "jest config (jest.config.*)",
    pattern: /(^|\/)jest\.config(\.|$)/i,
  },
  {
    id: "vitest-config",
    label: "vitest config (vitest.config.*)",
    pattern: /(^|\/)vitest\.config(\.|$)/i,
  },
  {
    id: "playwright-config",
    label: "playwright config (playwright.config.*)",
    pattern: /(^|\/)playwright\.config(\.|$)/i,
  },
  {
    id: "coverage-dir",
    label: "coverage output (coverage/)",
    pattern: /(^|\/)coverage(\/|$)/i,
  },
  {
    id: "nyc-output-dir",
    label: "nyc coverage output (.nyc_output/)",
    pattern: /(^|\/)\.nyc_output(\/|$)/i,
  },
];

/** Normalise a path for matching: posix separators, strip leading "./". */
export function normalizeProtectedPath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/** First protected-path rule that matches, or null. */
export function matchProtectedPath(path: string): ProtectedPathPattern | null {
  const normalized = normalizeProtectedPath(path);
  for (const entry of PROTECTED_PATH_PATTERNS) {
    if (entry.pattern.test(normalized)) return entry;
  }
  return null;
}

/** True when the path is a protected test/CI/test-infra path. */
export function isProtectedTestPath(path: string): boolean {
  return matchProtectedPath(path) !== null;
}

/** Human-readable reason string; "Not a protected path" when nothing matches. */
export function protectedPathReason(path: string): string {
  const match = matchProtectedPath(path);
  return match ? `Protected path: ${match.label}` : "Not a protected path";
}
