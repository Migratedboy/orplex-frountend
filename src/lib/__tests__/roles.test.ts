/**
 * roles.test.ts — Phase 7's role stack: the directives are real system-prompt
 * fragments (the breaker's job is to PROVE the change is wrong), the per-tier
 * sequences match the plan, and the write/verify separation is enforced by
 * canWrite/canVerify — the scheduler's two permission primitives.
 */
import {
  ROLE_DIRECTIVES,
  ROLE_SCHEMA_COVERAGE,
  buildRoleSequence,
  canVerify,
  canWrite,
  type AgentRoleName,
} from "../reliability/roles";

const ALL_ROLES: AgentRoleName[] = ["architect", "developer", "verifier", "breaker", "reviewer"];

describe("ROLE_DIRECTIVES", () => {
  it("has a real, non-trivial prompt fragment for every role", () => {
    for (const role of ALL_ROLES) {
      expect(typeof ROLE_DIRECTIVES[role]).toBe("string");
      expect(ROLE_DIRECTIVES[role].length).toBeGreaterThan(80);
    }
  });

  it("the breaker's directive is to PROVE the change is wrong, with a failing test first", () => {
    const d = ROLE_DIRECTIVES.breaker.toLowerCase();
    expect(d).toContain("prove the change is wrong");
    expect(d).toContain("should fail");
    expect(d).toContain("reproducible check");
    // A clean break attempt counts as evidence — honest, not goalpost-moving.
    expect(d).toContain("if you cannot break it");
  });

  it("the verifier reports lanes as pass/fail/skipped and never calls skipped a pass", () => {
    const d = ROLE_DIRECTIVES.verifier.toLowerCase();
    expect(d).toContain("typecheck");
    expect(d).toContain("skipped");
    expect(d).toContain("never a pass");
    expect(d).toContain("never change code");
  });

  it("the developer is plan-bound and evidence-bound", () => {
    const d = ROLE_DIRECTIVES.developer.toLowerCase();
    expect(d).toContain("approved plan");
    expect(d).toContain("backed by something the platform can check");
  });

  it("the architect plans but does not implement", () => {
    const d = ROLE_DIRECTIVES.architect.toLowerCase();
    expect(d).toContain("plan");
    expect(d).toContain("do not write implementation code");
  });

  it("the reviewer cites files, grades severity, and attaches repro tests", () => {
    const d = ROLE_DIRECTIVES.reviewer.toLowerCase();
    expect(d).toContain("cite the file");
    expect(d).toContain("blocker/major/minor");
    expect(d).toContain("repro test");
  });
});

describe("buildRoleSequence", () => {
  it("trivial → developer, verifier", () => {
    expect(buildRoleSequence("trivial")).toEqual(["developer", "verifier"]);
  });

  it("standard → architect, developer, verifier", () => {
    expect(buildRoleSequence("standard")).toEqual(["architect", "developer", "verifier"]);
  });

  it("elevated → architect, developer, breaker, verifier, reviewer", () => {
    expect(buildRoleSequence("elevated")).toEqual([
      "architect",
      "developer",
      "breaker",
      "verifier",
      "reviewer",
    ]);
  });

  it("critical → … reviewer, verifier (the final word is a green lane, not a review)", () => {
    expect(buildRoleSequence("critical")).toEqual([
      "architect",
      "developer",
      "breaker",
      "verifier",
      "reviewer",
      "verifier",
    ]);
  });

  it("every role in every sequence has a directive", () => {
    for (const tier of ["trivial", "standard", "elevated", "critical"] as const) {
      for (const role of buildRoleSequence(tier)) {
        expect(ROLE_DIRECTIVES[role]).toBeTruthy();
      }
    }
  });

  it("higher tiers never get fewer roles than lower ones", () => {
    const counts = (["trivial", "standard", "elevated", "critical"] as const).map(
      (t) => buildRoleSequence(t).length,
    );
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThan(counts[i - 1]);
    }
  });
});

describe("canWrite / canVerify", () => {
  it("only developer and architect may write", () => {
    expect(canWrite("developer")).toBe(true);
    expect(canWrite("architect")).toBe(true);
    expect(canWrite("verifier")).toBe(false);
    expect(canWrite("breaker")).toBe(false);
    expect(canWrite("reviewer")).toBe(false);
  });

  it("the checking roles verify; the writing roles never verify their own work", () => {
    expect(canVerify("verifier")).toBe(true);
    expect(canVerify("reviewer")).toBe(true);
    expect(canVerify("breaker")).toBe(true);
    expect(canVerify("developer")).toBe(false);
    expect(canVerify("architect")).toBe(false);
  });

  it("no role in the critical sequence can both write and verify", () => {
    for (const role of buildRoleSequence("critical")) {
      expect(canWrite(role) && canVerify(role)).toBe(false);
    }
  });
});

describe("ROLE_SCHEMA_COVERAGE", () => {
  it("is true while every persisted schema member is addressable by this stack", () => {
    // Compile-time guard exported as a value: agentRoleSchema (runtime/types.ts)
    // growing an uncovered member makes this constant stop typechecking.
    expect(ROLE_SCHEMA_COVERAGE).toBe(true);
  });
});
