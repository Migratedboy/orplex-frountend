// plugin-library/devops.ts — DevOps category: 8 bundles.

import { SKILL_HEADER, type BundleDef } from "./types";

export const DEVOPS_BUNDLES: BundleDef[] = [
  {
    slug: "branch-discipline",
    category: "devops",
    version: "1.0.0",
    description: "Feature-branch workflow guardrails: pushes to main/master are blocked, commits and pushes are announced, and every task starts from a clean tree.",
    skills: [
      {
        name: "branch-discipline",
        body:
          SKILL_HEADER("Branch discipline", "main is releasable at all times; all agent work happens on branches.") +
          `## Rules

1. Check git status and the current branch before the first write. If the tree is dirty or you are on main, create/switch to a feature branch first (feat/<topic>, fix/<topic>).
2. One logical change per commit; rebase-style cleanups beat interleaved mega-commits.
3. Never push to main/master — open a branch and let the human merge after review.
4. If the repo has no remote, commit locally and say so; do not invent push commands.
`,
      },
    ],
    hooks: {
      deny: ["git\\s+push\\s+.*\\b(main|master)\\b", "git\\s+push\\s+origin\\s+(main|master)\\s*$"],
      notify: ["git\\s+push", "git\\s+commit"],
    },
  },
  {
    slug: "conventional-commits",
    category: "devops",
    version: "1.0.0",
    description: "Commit messages follow Conventional Commits: type(scope): subject, imperative mood, body explains why.",
    skills: [
      {
        name: "conventional-commits",
        body:
          SKILL_HEADER("Conventional Commits", "A commit message is addressed to the person bisecting a regression at 2am.") +
          `## Rules

1. Format: type(scope): subject — types: feat, fix, refactor, test, docs, chore, perf, build, ci.
2. Subject in imperative mood, ≤72 chars, no trailing period ("fix(auth): reject empty session tokens").
3. The body explains WHY the change exists and what tradeoffs were made; the diff already shows what.
4. Breaking changes get a "BREAKING CHANGE:" footer describing the migration.
5. One logical change per commit — if the subject needs "and", it wants to be two commits.
`,
      },
    ],
    hooks: { notify: ["git\\s+commit"] },
  },
  {
    slug: "ci-green",
    category: "devops",
    version: "1.0.0",
    description: "CI is the shared gatekeeper: the agent reproduces failing CI steps locally before pushing any fix.",
    skills: [
      {
        name: "ci-green",
        body:
          SKILL_HEADER("CI green", "Pushing to 'see if CI passes' spends the team's time. Reproduce first.") +
          `## Rules

1. When CI fails, read the failing step's log and reproduce THAT exact command locally before changing any code.
2. Environment differences (env vars, DB, OS) are the first suspect — not the code.
3. Flaky tests get fixed or quarantined with an issue link, never ignored.
4. Never merge with a red pipeline; disabling a failing job is a team decision, not an agent decision.
5. After fixing, push and WATCH the pipeline to completion, then report the run link.
`,
      },
    ],
    hooks: { notify: ["run_command.*ci", "run_command.*act "] },
  },
  {
    slug: "env-parity",
    category: "devops",
    version: "1.0.0",
    description: "Environment configuration stays explicit: new env vars are documented, defaulted, and never silently required.",
    skills: [
      {
        name: "env-parity",
        body:
          SKILL_HEADER("Env parity", "Works on my machine is a configuration bug wearing a disguise.") +
          `## Rules

1. New env vars get: a safe local default, a .env.example entry with a comment, and a mention in the task summary.
2. Required-at-runtime vars fail loudly at startup with the variable NAME in the error — never a mysterious undefined downstream.
3. Secrets live only in secret stores/CI secrets — .env files with real values never get committed.
4. Prefer fewer, well-named variables over overlapping flags that can contradict each other.
5. Behavior differences between dev/prod are called out in the summary, not discovered later.
`,
      },
    ],
  },
  {
    slug: "db-migrations",
    category: "devops",
    version: "1.0.0",
    description: "Schema changes are additive-first and pushed with the client regenerated — destructive steps are called out for human review.",
    skills: [
      {
        name: "db-migrations",
        body:
          SKILL_HEADER("DB migrations", "Production data is someone's day. Change schema like a surgeon.") +
          `## Rules

1. Prefer additive changes (new nullable columns, new tables) over destructive ones.
2. Any destructive step (drop column/table, type narrowing) requires explicit human approval in the task before pushing.
3. After schema edits: generate the client, push to the local dev DB, and run the typecheck lane — the ORM types must agree.
4. New query paths get indexes; say which query motivated each index.
5. Never edit an applied migration in place; add a new one.
`,
      },
    ],
    hooks: { notify: ["run_command.*prisma"] },
  },
  {
    slug: "docker-hygiene",
    category: "devops",
    version: "1.0.0",
    description: "Containerfiles stay lean and reproducible: pinned bases, layered caching, non-root runtime user.",
    skills: [
      {
        name: "docker-hygiene",
        body:
          SKILL_HEADER("Docker hygiene", "Images are deployed artifacts — every layer is a liability you ship.") +
          `## Rules

1. Pin base images by digest or specific version tag — never :latest in anything deployed.
2. Order layers least→most volatile; copy lockfiles and install deps before copying source so builds cache.
3. One concern per container; multi-stage builds keep build tools out of the runtime image.
4. Run as a non-root user; expose only the ports actually used.
5. Healthchecks reflect real readiness (the app's own endpoint), not "process exists".
`,
      },
    ],
  },
  {
    slug: "release-notes",
    category: "devops",
    version: "1.0.0",
    description: "Every finished task produces a changelog-ready entry: what changed, why, migration/upgrade notes.",
    skills: [
      {
        name: "release-notes",
        body:
          SKILL_HEADER("Release notes", "If it mattered enough to build, it matters enough to document in the changelog.") +
          `## Rules

1. End every feature/fix task with a one-to-three line changelog entry: what changed, who benefits, why.
2. User-visible changes lead; internal refactors get a single summary line or nothing.
3. Behavior changes and deprecations include an upgrade note ("set X=1 to keep the old behavior").
4. Match the repo's existing changelog format (Keep a Changelog / semantic versioning headers) when present.
5. Link the issue/PR id where the repo convention does.
`,
      },
    ],
  },
  {
    slug: "backup-aware",
    category: "devops",
    version: "1.0.0",
    description: "Data-touching operations respect backups: snapshot before risky changes, verify restore paths, never hand-edit production data.",
    skills: [
      {
        name: "backup-aware",
        body:
          SKILL_HEADER("Backup awareness", "The backup you haven't tested is a wish, not a backup.") +
          `## Rules

1. Before bulk data operations (migration backfills, mass updates, deletes), confirm a recent backup exists and say so in the summary.
2. Prefer writing the new data alongside the old (dual-write / add-column-backfill) over in-place rewrites.
3. Practice restores, not just backups — the repo's restore drill script is the reference path.
4. Never hand-edit production data row by row; use a reviewed script that is idempotent and dry-runnable.
5. A failed data operation reports what state it left things in — partial progress is a fact to document, not hide.
`,
      },
    ],
  },
];
