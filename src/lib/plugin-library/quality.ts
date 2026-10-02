// plugin-library/quality.ts — Quality category: 8 bundles.

import { SKILL_HEADER, type BundleDef } from "./types";

export const QUALITY_BUNDLES: BundleDef[] = [
  {
    slug: "verified-commits",
    category: "quality",
    version: "1.0.0",
    description: "The agent may only claim a task done when the machine agrees: typecheck and tests must exit 0 before any 'done' summary, and history rewriting is off-limits.",
    skills: [
      {
        name: "verified-commits",
        body:
          SKILL_HEADER("Verified commits", "Work is not done because the code looks right. It is done when the verification lanes pass.") +
          `## Rules

1. After every code change, run the project's checks (tsc --noEmit + the test suite) and read the EXIT CODES. Exit 0 is the only "passed".
2. Never summarize a task as complete while any check fails. Report the failure and the fix you attempted instead.
3. If a check was never run (no test suite, no compiler), say so explicitly — "unverified" is an honest status, a guess is not.
4. Never rewrite history: no git push --force, no git commit --no-verify, no amending commits you did not create in this session.
5. Commit small and often; every commit message says WHY, not just what.
`,
      },
    ],
    hooks: {
      deny: ["git\\s+push\\s+.*--force", "git\\s+commit\\s+.*--no-verify"],
      notify: ["git\\s+commit"],
    },
  },
  {
    slug: "test-first",
    category: "quality",
    version: "1.0.0",
    description: "Test-driven discipline: a failing test exists before any fix, and new features land with coverage.",
    skills: [
      {
        name: "test-first",
        body:
          SKILL_HEADER("Test-first", "A bug you can't reproduce in a test isn't fixed — it's postponed.") +
          `## Rules

1. For every bug fix, first write the smallest test that fails on the current code. Watch it fail. Then fix.
2. New features ship with at least one test per acceptance criterion.
3. Refactors run the existing suite before and after — green to green, no snapshot drift.
4. Never weaken an assertion to make a test pass. If the test is wrong, change the test and say why.
5. Prefer testing observable behavior over private internals.
`,
      },
    ],
    hooks: { notify: ["run_command.*test", "run_command.*jest", "run_command.*pytest"] },
  },
  {
    slug: "strict-types",
    category: "quality",
    version: "1.0.0",
    description: "No any, no silent casts: the agent must typecheck clean and prefer narrowing over assertions.",
    skills: [
      {
        name: "strict-types",
        body:
          SKILL_HEADER("Strict types", "Types are the cheapest test you will ever write.") +
          `## Rules

1. No new "any" — including any[] and Record<string, any>. Use unknown and narrow.
2. Prefer type guards and discriminated unions over "as" assertions. Every "as" is a lie the compiler can't check.
3. Public function signatures are explicit — no inferred object soup on exports.
4. After edits run tsc --noEmit; zero new errors is the bar, not "it mostly compiles".
5. Null/undefined are handled at the boundary (validate input, then carry non-optional types inward).
`,
      },
    ],
  },
  {
    slug: "doc-strings",
    category: "quality",
    version: "1.0.0",
    description: "Every exported function gets a doc comment: what it does, what it returns, and what it throws.",
    skills: [
      {
        name: "doc-strings",
        body:
          SKILL_HEADER("Doc strings", "Future readers include the agent in your next session — write for them.") +
          `## Rules

1. Every exported function/class/type gets a one-to-three line doc comment: WHAT it does, not how.
2. Document the non-obvious: surprising null returns, thrown errors, performance characteristics.
3. Never narrate the implementation in comments — explain intent and constraints ("because the API rate-limits at 8k/min").
4. Stale docs are worse than none: update the comment in the same edit that changes the behavior.
5. Module-level header comments state the module's responsibility in one sentence.
`,
      },
    ],
  },
  {
    slug: "clean-imports",
    category: "quality",
    version: "1.0.0",
    description: "Import hygiene: no unused imports, no circular dependencies, consistent path aliases.",
    skills: [
      {
        name: "clean-imports",
        body:
          SKILL_HEADER("Clean imports", "The import graph is the architecture — keep it honest.") +
          `## Rules

1. Remove imports you no longer use in the same edit that stops using them.
2. Prefer the project's path alias (@/...) over fragile relative chains like ../../../.
3. Never introduce a circular dependency; if two modules need each other, extract the shared piece.
4. Type-only imports use "import type" where the bundler supports it.
5. Heavy optional dependencies load via dynamic import inside functions, not at module top-level.
`,
      },
    ],
  },
  {
    slug: "error-handling",
    category: "quality",
    version: "1.0.0",
    description: "Errors are typed, actionable, and never swallowed: no empty catch blocks, no string-only errors.",
    skills: [
      {
        name: "error-handling",
        body:
          SKILL_HEADER("Error handling", "Every catch is a decision — make it deliberately.") +
          `## Rules

1. Never an empty catch. Either handle, wrap with context, or rethrow — and the choice is visible in a comment when subtle.
2. Catch specific errors, not everything. A broad catch belongs at the boundary (route handler, top of a task), not mid-logic.
3. Error messages say what failed, the offending value (truncated), and what to do about it.
4. User-facing messages never leak stack traces or internals; log the detail server-side.
5. Use the project's error hierarchy/types instead of bare strings.
`,
      },
    ],
  },
  {
    slug: "refactor-safety",
    category: "quality",
    version: "1.0.0",
    description: "Behavior-preserving refactors in small verified steps — never mix 'move code' and 'change behavior' in one edit.",
    skills: [
      {
        name: "refactor-safety",
        body:
          SKILL_HEADER("Refactor safety", "Small steps, verified each time, beat heroic rewrites.") +
          `## Rules

1. One refactor = one commit = one behavior (which is: no behavior change). Mixing moves with changes makes review impossible.
2. Before moving code, run the suite; after moving it, run it again. Green to green or revert.
3. Rename by tooling where possible (find-all-references), never by search-and-replace across unrelated matches.
4. Delete dead code outright — commented-out code is noise, not safety.
5. Keep public APIs stable during internal refactors; deprecate loudly before removing.
`,
      },
    ],
  },
  {
    slug: "lint-clean",
    category: "quality",
    version: "1.0.0",
    description: "The linter is the gate: zero new warnings allowed, autofix first, disable-with-reason only when justified.",
    skills: [
      {
        name: "lint-clean",
        body:
          SKILL_HEADER("Lint clean", "Warnings rot into errors. The bar is exit 0 with --max-warnings 0.") +
          `## Rules

1. Run the project's linter after every edit batch; fix every new warning you introduced.
2. Prefer fixing the underlying issue over disabling the rule.
3. An inline disable must carry a reason and a scope as narrow as possible (next line, not the file).
4. Never reformat whole files when the project has no formatter config — match surrounding style instead.
5. Lint errors fail CI; treat them exactly like test failures.
`,
      },
    ],
    hooks: { notify: ["run_command.*eslint", "run_command.*lint"] },
  },
];
