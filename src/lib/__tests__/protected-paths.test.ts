/**
 * protected-paths.test.ts — Phase 2 path classification + the risk-classifier
 * inversion fix: test/CI/test-infra writes must classify HIGH, never
 * auto-approved, unless the user sets RELIABILITY_PROTECTED_WRITE_OVERRIDE=1.
 */
import {
  PROTECTED_PATH_PATTERNS,
  isProtectedTestPath,
  matchProtectedPath,
  normalizeProtectedPath,
  protectedPathReason,
} from "../reliability/protected-paths";
import { classifyRisk } from "../risk-classifier";

describe("normalizeProtectedPath", () => {
  it("converts backslashes to posix separators and strips leading ./", () => {
    expect(normalizeProtectedPath("src\\lib\\foo.test.ts")).toBe("src/lib/foo.test.ts");
    expect(normalizeProtectedPath("./src/foo.ts")).toBe("src/foo.ts");
    expect(normalizeProtectedPath("./././a.ts")).toBe("a.ts");
    expect(normalizeProtectedPath("src/foo.ts")).toBe("src/foo.ts");
  });
});

describe("isProtectedTestPath — test files at any depth (basename matching)", () => {
  it("matches *.test.* and *.spec.* wherever they sit", () => {
    expect(isProtectedTestPath("foo.test.ts")).toBe(true);
    expect(isProtectedTestPath("foo.spec.ts")).toBe(true);
    expect(isProtectedTestPath("src/lib/__tests__/risk-classifier.test.ts")).toBe(true);
    expect(isProtectedTestPath("deep/nested/dir/thing.test.tsx")).toBe(true);
    expect(isProtectedTestPath("C:\\repo\\src\\a.spec.js")).toBe(true);
    expect(isProtectedTestPath("./src/a.test.ts")).toBe(true);
  });

  it("does not match ordinary source files", () => {
    expect(isProtectedTestPath("src/lib/risk-classifier.ts")).toBe(false);
    expect(isProtectedTestPath("src/component.specification.md")).toBe(false);
    expect(isProtectedTestPath("src/test-utils/helper.ts")).toBe(false);
    expect(isProtectedTestPath("src/latest-function.ts")).toBe(false);
  });
});

describe("isProtectedTestPath — test directories as whole segments", () => {
  it("matches test/, tests/, __tests__/, e2e/, playwright/ at any depth", () => {
    expect(isProtectedTestPath("test/setup.ts")).toBe(true);
    expect(isProtectedTestPath("tests/setup.ts")).toBe(true);
    expect(isProtectedTestPath("__tests__/setup.ts")).toBe(true);
    expect(isProtectedTestPath("src/lib/__tests__/x.ts")).toBe(true);
    expect(isProtectedTestPath("packages/app/e2e/flow.ts")).toBe(true);
    expect(isProtectedTestPath("playwright/fixtures.ts")).toBe(true);
  });

  it("does not match directories that merely start with the segment", () => {
    expect(isProtectedTestPath("src/test-utils/helper.ts")).toBe(false);
    expect(isProtectedTestPath("src/tests-helper/fixture.ts")).toBe(false);
    expect(isProtectedTestPath("src/latest/foo.ts")).toBe(false);
  });
});

describe("isProtectedTestPath — CI config and test infra", () => {
  it("matches GitHub Actions, GitLab CI and Jenkinsfile", () => {
    expect(isProtectedTestPath(".github/workflows/ci.yml")).toBe(true);
    expect(isProtectedTestPath("org/.github/workflows/release.yaml")).toBe(true);
    expect(isProtectedTestPath(".gitlab-ci.yml")).toBe(true);
    expect(isProtectedTestPath("Jenkinsfile")).toBe(true);
    expect(isProtectedTestPath("ci/Jenkinsfile")).toBe(true);
  });

  it("matches jest/vitest/playwright configs and coverage output dirs", () => {
    expect(isProtectedTestPath("jest.config.js")).toBe(true);
    expect(isProtectedTestPath("jest.config.ts")).toBe(true);
    expect(isProtectedTestPath("packages/web/vitest.config.mts")).toBe(true);
    expect(isProtectedTestPath("playwright.config.ts")).toBe(true);
    expect(isProtectedTestPath("coverage/lcov.info")).toBe(true);
    expect(isProtectedTestPath("packages/a/coverage/index.html")).toBe(true);
    expect(isProtectedTestPath(".nyc_output/results.json")).toBe(true);
  });

  it("normalises windows separators before matching", () => {
    expect(isProtectedTestPath(".github\\workflows\\ci.yml")).toBe(true);
    expect(isProtectedTestPath("src\\__tests__\\a.ts")).toBe(true);
  });
});

describe("matchProtectedPath / protectedPathReason", () => {
  it("returns the first matching pattern with a stable id", () => {
    expect(matchProtectedPath("src/a.test.ts")?.id).toBe("test-file");
    expect(matchProtectedPath("Jenkinsfile")?.id).toBe("jenkinsfile");
    expect(matchProtectedPath("src/lib/a.ts")).toBeNull();
  });

  it("gives a human reason for protected paths and a negative one otherwise", () => {
    expect(protectedPathReason("src/a.test.ts")).toContain("test file");
    expect(protectedPathReason(".github/workflows/ci.yml")).toContain("GitHub Actions");
    expect(protectedPathReason("src/lib/a.ts")).toBe("Not a protected path");
  });

  it("PROTECTED_PATH_PATTERNS covers every category the plan requires", () => {
    const ids = PROTECTED_PATH_PATTERNS.map(p => p.id);
    for (const required of [
      "test-file",
      "dunder-tests-dir",
      "test-dir",
      "tests-dir",
      "e2e-dir",
      "playwright-dir",
      "github-workflows",
      "gitlab-ci",
      "jenkinsfile",
      "jest-config",
      "vitest-config",
      "playwright-config",
      "coverage-dir",
      "nyc-output-dir",
    ]) {
      expect(ids).toContain(required);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyRisk integration — the SAFE_WRITE_PREFIXES inversion fix
// ---------------------------------------------------------------------------

describe("classifyRisk — protected test/CI paths (inversion fix)", () => {
  const ENV = process.env;
  beforeEach(() => {
    process.env = { ...ENV };
    delete process.env.RELIABILITY_PROTECTED_WRITE_OVERRIDE;
    delete process.env.RELIABILITY_GATES;
  });
  afterAll(() => {
    process.env = ENV;
  });

  it("classifies test-file writes as high, never auto-approved (was low/auto-approve)", () => {
    for (const path of [
      "src/lib/foo.test.ts",
      "foo.spec.ts",
      "test/helper.ts",
      "tests/helper.ts",
      "__tests__/helper.ts",
      "src/lib/__tests__/helper.ts",
      "e2e/checkout.spec.ts",
    ]) {
      const r = classifyRisk("write_file", { path, content: "export const A = 1;" });
      expect(r.level).toBe("high");
      expect(r.autoApprovable).toBe(false);
      expect(r.reason).toMatch(/Protected test\/CI path/);
    }
  });

  it("classifies CI and test-infra writes as high", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".gitlab-ci.yml",
      "Jenkinsfile",
      "jest.config.js",
      "playwright.config.ts",
    ]) {
      expect(classifyRisk("write_file", { path, content: "x" }).level).toBe("high");
      expect(classifyRisk("edit_file", { path, old_text: "a", new_text: "b" }).level).toBe("high");
    }
  });

  it("classifies edits to protected paths as high — batch_edit included", () => {
    const edit = classifyRisk("edit_file", { path: "src/lib/foo.test.ts", old_text: "a", new_text: "b" });
    expect(edit).toMatchObject({ level: "high", autoApprovable: false });

    const batch = classifyRisk("batch_edit", {
      edits: [
        { path: "src/lib/a.ts", old_text: "a", new_text: "b" },
        { path: "src/lib/__tests__/a.test.ts", old_text: "c", new_text: "d" },
      ],
    });
    expect(batch).toMatchObject({ level: "high", autoApprovable: false });
    expect(batch.reason).toMatch(/Protected test\/CI path/);
  });

  it("new SENSITIVE_FILE members: tsconfig/eslint.config/package.json stay high", () => {
    for (const path of ["tsconfig.json", "src/tsconfig.json", "eslint.config.mjs", "package.json", "packages/app/package.json"]) {
      expect(classifyRisk("write_file", { path, content: "x" }).level).toBe("high");
    }
  });

  it("root-level test/ writes are no longer auto-approved as a safe prefix", () => {
    // Pre-Phase-2: "test/" was in SAFE_WRITE_PREFIXES → low/auto-approve.
    const r = classifyRisk("write_file", { path: "test/new-suite.ts", content: "export const A = 1;" });
    expect(r.level).toBe("high");
    expect(r.autoApprovable).toBe(false);
  });

  it("keeps ordinary source writes unchanged (low, auto-approved)", () => {
    const r = classifyRisk("write_file", { path: "src/components/Button.tsx", content: "export const A = 1;" });
    expect(r).toMatchObject({ level: "low", autoApprovable: true });
  });

  it("override flag unlocks test-integrity files but never secrets or CI", () => {
    process.env.RELIABILITY_PROTECTED_WRITE_OVERRIDE = "1";

    // Test files: unlocked to the normal tiers (src/ prefix → low).
    const testWrite = classifyRisk("write_file", { path: "src/lib/foo.test.ts", content: "export const A = 1;" });
    expect(testWrite.level).toBe("low");
    expect(testWrite.autoApprovable).toBe(true);

    // Root-level test dir: no longer protected, but no safe prefix either → medium.
    const rootTest = classifyRisk("write_file", { path: "test/helper.ts", content: "export const A = 1;" });
    expect(rootTest.level).toBe("medium");
    expect(rootTest.autoApprovable).toBe(false);

    // Secrets, CI and build config remain high even under the override.
    expect(classifyRisk("write_file", { path: ".env.local", content: "X=1" }).level).toBe("high");
    expect(classifyRisk("write_file", { path: ".github/workflows/ci.yml", content: "x" }).level).toBe("high");
    expect(classifyRisk("write_file", { path: "package.json", content: "{}" }).level).toBe("high");
    expect(classifyRisk("write_file", { path: "tsconfig.json", content: "{}" }).level).toBe("high");
    expect(classifyRisk("write_file", { path: "test/.env", content: "X=1" }).level).toBe("high");
  });

  it("override is OFF by default even when the master switch is on", () => {
    process.env.RELIABILITY_GATES = "1";
    const r = classifyRisk("write_file", { path: "src/lib/foo.test.ts", content: "export const A = 1;" });
    expect(r.level).toBe("high");
  });
});
