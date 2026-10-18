/**
 * risk-tiering.test.ts — Phase 7's risk-tiered review depth: trivial /
 * standard / elevated / critical with exact reviewer counts and evidence
 * requirements, plus the sensitive-path coverage the audit found missing
 * (auth* was not in risk-classifier's SENSITIVE_FILE at all).
 */
import {
  SENSITIVE_PATH_PATTERNS,
  classifyChangeRisk,
  deriveRiskSignals,
  isSensitivePath,
  type ChangeRiskInput,
} from "../reliability/risk-tiering";

const base: ChangeRiskInput = {
  changedFiles: ["src/utils/format.ts"],
  diffSizeLines: 10,
  touchesAuth: false,
  touchesPayments: false,
  touchesMigrations: false,
  hasTests: true,
};

const change = (partial: Partial<ChangeRiskInput>): ChangeRiskInput => ({ ...base, ...partial });

// ---------------------------------------------------------------------------
// classifyChangeRisk
// ---------------------------------------------------------------------------

describe("classifyChangeRisk", () => {
  it("trivial: ≤20 lines, nothing sensitive, tests present → 1 reviewer, no repro", () => {
    expect(classifyChangeRisk(base)).toEqual({
      tier: "trivial",
      reviewers: 1,
      requireReproTest: false,
      requireMutationTesting: false,
    });
  });

  it("a ≤20-line change WITHOUT tests is not trivial — it gets 2 reviewers", () => {
    expect(classifyChangeRisk(change({ hasTests: false })).tier).toBe("standard");
  });

  it("standard: mid-size plain change → 2 reviewers", () => {
    expect(classifyChangeRisk(change({ diffSizeLines: 80 }))).toEqual({
      tier: "standard",
      reviewers: 2,
      requireReproTest: false,
      requireMutationTesting: false,
    });
  });

  it("elevated on auth OR payments OR migrations OR >200 lines → 3 reviewers + repro required", () => {
    for (const partial of [
      { touchesAuth: true },
      { touchesPayments: true },
      { touchesMigrations: true },
      { diffSizeLines: 201 },
    ] as Array<Partial<ChangeRiskInput>>) {
      const r = classifyChangeRisk(change(partial));
      expect(r.tier).toBe("elevated");
      expect(r.reviewers).toBe(3);
      expect(r.requireReproTest).toBe(true);
      expect(r.requireMutationTesting).toBe(false);
    }
  });

  it("boundary: 200 lines is still standard; 201 is elevated", () => {
    expect(classifyChangeRisk(change({ diffSizeLines: 200 })).tier).toBe("standard");
    expect(classifyChangeRisk(change({ diffSizeLines: 201 })).tier).toBe("elevated");
  });

  it("boundary: 21 lines without tests and without sensitive touches is standard", () => {
    expect(classifyChangeRisk(change({ diffSizeLines: 21 })).tier).toBe("standard");
  });

  it("critical: auth AND payments → 4 reviewers + repro + mutation testing", () => {
    expect(classifyChangeRisk(change({ touchesAuth: true, touchesPayments: true }))).toEqual({
      tier: "critical",
      reviewers: 4,
      requireReproTest: true,
      requireMutationTesting: true,
    });
  });

  it("critical: migrations AND >500 lines → 4 reviewers + repro + mutation testing", () => {
    expect(classifyChangeRisk(change({ touchesMigrations: true, diffSizeLines: 501 }))).toEqual({
      tier: "critical",
      reviewers: 4,
      requireReproTest: true,
      requireMutationTesting: true,
    });
  });

  it("boundary: migrations AND exactly 500 lines is elevated, not critical", () => {
    const r = classifyChangeRisk(change({ touchesMigrations: true, diffSizeLines: 500 }));
    expect(r.tier).toBe("elevated");
    expect(r.requireMutationTesting).toBe(false);
  });

  it("auth alone is elevated, not critical", () => {
    const r = classifyChangeRisk(change({ touchesAuth: true }));
    expect(r.tier).toBe("elevated");
  });

  it("file names can only RAISE risk — an auth file is elevated even with flags false", () => {
    const r = classifyChangeRisk(change({ changedFiles: ["src/auth/session.ts"] }));
    expect(r.tier).toBe("elevated");
  });

  it("an unknown diff size (NaN) is treated as maximal — unknown is not light", () => {
    const r = classifyChangeRisk(change({ diffSizeLines: Number.NaN }));
    expect(r.tier).not.toBe("trivial");
    expect(r.tier === "elevated" || r.tier === "critical").toBe(true);
  });

  it("critical dominates: auth+payments beats a 5-line diff", () => {
    const r = classifyChangeRisk(change({ touchesAuth: true, touchesPayments: true, diffSizeLines: 5 }));
    expect(r.tier).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// Sensitive path coverage
// ---------------------------------------------------------------------------

describe("SENSITIVE_PATH_PATTERNS / isSensitivePath", () => {
  it("covers the plan-required families", () => {
    const sensitive = [
      "src/auth/login.ts", // auth*
      "src/someauth.ts", // *auth*
      "src/login/route.ts", // login*
      "src/session-store.ts", // session*
      "src/payments/charge.ts", // payment*
      "src/billing/invoice.ts", // billing*
      "src/checkout/page.tsx", // checkout*
      "src/stripe-webhook.ts", // stripe*
      "prisma/migrations/20240101_init.sql", // migration*
      "db/seed.sql", // *.sql
      "middleware.ts", // middleware.ts
    ];
    for (const p of sensitive) {
      expect(isSensitivePath(p)).toBe(true);
    }
  });

  it("mirrors risk-classifier.ts's SENSITIVE_FILE set where it overlaps", () => {
    // Those path fragments come from risk-classifier.ts:76 (module-private
    // there, mirrored here by list).
    const mirrored = [
      ".env",
      "config/.npmrc",
      "keys/id_rsa",
      "src/credentials.ts",
      "src/secret-scanner.ts",
      "src/password-hasher.ts",
      "docker-compose.yml",
      "Dockerfile",
      "nginx.conf",
      ".github/workflows/ci.yml",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "prisma/migrations/migration_lock.toml",
    ];
    for (const p of mirrored) {
      expect(isSensitivePath(p)).toBe(true);
    }
  });

  it("does NOT match ordinary source files", () => {
    const plain = ["src/components/Button.tsx", "src/lib/format.ts", "src/app/page.tsx", "README.md"];
    for (const p of plain) {
      expect(isSensitivePath(p)).toBe(false);
    }
    // The bare `ci` substring from SENSITIVE_FILE must not match "special.ts".
    expect(isSensitivePath("src/special.ts")).toBe(false);
  });

  it("normalizes windows separators", () => {
    expect(isSensitivePath("src\\auth\\login.ts")).toBe(true);
  });

  it("every pattern is a non-global regex (test() must stay stateless)", () => {
    for (const re of SENSITIVE_PATH_PATTERNS) {
      expect(re.global).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// deriveRiskSignals
// ---------------------------------------------------------------------------

describe("deriveRiskSignals", () => {
  it("detects auth, payments and migrations families from file names", () => {
    expect(deriveRiskSignals(["src/auth/client.ts"])).toEqual({
      touchesAuth: true,
      touchesPayments: false,
      touchesMigrations: false,
    });
    expect(deriveRiskSignals(["src/checkout/page.tsx", "src/stripe.ts"])).toEqual({
      touchesAuth: false,
      touchesPayments: true,
      touchesMigrations: false,
    });
    expect(deriveRiskSignals(["prisma/migrations/0001_add_users.sql"])).toEqual({
      touchesAuth: false,
      touchesPayments: false,
      touchesMigrations: true,
    });
  });

  it("plain files touch nothing", () => {
    expect(deriveRiskSignals(["src/lib/utils.ts", "src/app/page.tsx"])).toEqual({
      touchesAuth: false,
      touchesPayments: false,
      touchesMigrations: false,
    });
  });

  it("handles empty input", () => {
    expect(deriveRiskSignals([])).toEqual({
      touchesAuth: false,
      touchesPayments: false,
      touchesMigrations: false,
    });
  });
});
