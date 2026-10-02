// plugin-library/intelligence.ts — Intelligence category: 8 bundles.

import { SKILL_HEADER, type BundleDef } from "./types";

export const INTELLIGENCE_BUNDLES: BundleDef[] = [
  {
    slug: "token-frugality",
    category: "intelligence",
    version: "1.0.0",
    description: "Context-budget habits: read files in targeted slices, never re-read what is already in the transcript, prefer precise searches over dumps.",
    skills: [
      {
        name: "token-frugality",
        body:
          SKILL_HEADER("Token frugality", "Every token in the transcript is paid for on every later turn. Spend them on evidence, not bulk.") +
          `## Rules

1. Locate before you read: search for the symbol/pattern first, then read a window around the hit — not the whole file.
2. Never re-read a file whose contents are already in the conversation unless it changed since.
3. Prefer one precise search over three broad ones; prefer reading 80 lines around a match over 800 lines of context.
4. When a file must be edited in several places, batch the edits in one pass instead of re-reading between each.
5. Summaries you write are context too — keep them short, factual, and free of restated task text.
`,
      },
    ],
    hooks: { notify: ["read_file"] },
  },
  {
    slug: "plan-then-act",
    category: "intelligence",
    version: "1.0.0",
    description: "Multi-step tasks get a visible plan first: steps enumerated, files identified, risks named — then execution follows the plan.",
    skills: [
      {
        name: "plan-then-act",
        body:
          SKILL_HEADER("Plan then act", "Ten minutes of planning saves an hour of undoing.") +
          `## Rules

1. Any task touching more than ~3 files or 2 subsystems starts with a short written plan: steps, files, verification.
2. The plan names the riskiest step and how it will be verified — do that step's spike first if feasible.
3. Mid-task discoveries update the plan explicitly ("plan changed: X because Y") instead of silently drifting.
4. Do not plan what one search will answer — investigate first, plan only what stays unknown.
5. Finished steps get checked off in the summary so the user sees progress against the plan.
`,
      },
    ],
  },
  {
    slug: "root-cause-first",
    category: "intelligence",
    version: "1.0.0",
    description: "Fix causes, not symptoms: reproduce, trace to origin, then patch — patching the nearest symptom is failure.",
    skills: [
      {
        name: "root-cause-first",
        body:
          SKILL_HEADER("Root cause first", "A symptom patch is a bug with a delay timer.") +
          `## Rules

1. Reproduce the failure before fixing it; an unreproduced fix is a hypothesis, and hypotheses don't ship.
2. Trace the failure to its origin — the throwing line is rarely the broken invariant.
3. Prefer the small fix at the cause over the clever guard at the symptom; if you must guard, leave a comment linking the cause.
4. After fixing, explain the causal chain in one or two lines: "X happened because Y, so Z now fails".
5. If the same bug class has appeared twice in this workspace, fix the class (validation, typing), not the instance.
`,
      },
    ],
  },
  {
    slug: "minimal-diff",
    category: "intelligence",
    version: "1.0.0",
    description: "Changes stay minimal and reviewable: no drive-by reformatting, no scope creep, every touched line justified by the task.",
    skills: [
      {
        name: "minimal-diff",
        body:
          SKILL_HEADER("Minimal diff", "Review effort scales with diff size. Small diffs get real review; big diffs get rubber stamps.") +
          `## Rules

1. Touch only what the task requires. A drive-by cleanup is a separate task with its own commit.
2. Never reformat lines you are not otherwise changing — the diff must tell the story of the task.
3. Prefer editing existing files over creating parallel ones; prefer deleting code over adding abstraction.
4. If the honest fix needs a bigger change than the task allows, say so and stop — don't smuggle it in.
5. Summarize the diff shape at the end ("2 files, +40/−12, core change in X") so review starts oriented.
`,
      },
    ],
  },
  {
    slug: "ask-when-ambiguous",
    category: "intelligence",
    version: "1.0.0",
    description: "Ambiguity triggers one clarifying question, not a guess: irreversible or product-shaped decisions belong to the human.",
    skills: [
      {
        name: "ask-when-ambiguous",
        body:
          SKILL_HEADER("Ask when ambiguous", "A wrong guess costs a rewrite; a question costs a minute.") +
          `## Rules

1. If two reasonable interpretations of the task lead to different deliverables, ask ONE concise question with your recommended default.
2. Irreversible actions (deleting data, force-pushing, schema drops, sending email) always get explicit confirmation first.
3. Product decisions (naming, UI copy, which of two features) belong to the human — propose, don't decide.
4. Reversible technical choices (algorithm details, internal naming) are yours — decide and note the choice.
5. When you proceed on an assumption, state the assumption prominently at the top of the summary.
`,
      },
    ],
  },
  {
    slug: "evidence-summary",
    category: "intelligence",
    version: "1.0.0",
    description: "Task summaries cite evidence: exit codes, test names, file paths — claims are backed by shown output, not vibes.",
    skills: [
      {
        name: "evidence-summary",
        body:
          SKILL_HEADER("Evidence-based summaries", "Show the receipt, then the claim.") +
          `## Rules

1. Every "done" claim carries its evidence: the command run and its exit code, or the test names that passed.
2. Summaries cite file paths with a one-line what/why for each — the user should be able to review in 60 seconds.
3. Unknowns and skipped steps are listed explicitly ("not verified: browser render, no dev server").
4. Numbers come from real output (build size, test counts) — never rounded from imagination.
5. No marketing adjectives in technical summaries ("robust", "comprehensive") — facts only.
`,
      },
    ],
  },
  {
    slug: "memory-saver",
    category: "intelligence",
    version: "1.0.0",
    description: "Durable workspace facts get captured: stack decisions, user preferences, verified patterns — so the next task starts smarter.",
    skills: [
      {
        name: "memory-saver",
        body:
          SKILL_HEADER("Memory saver", "The next session should not re-learn what this session paid for.") +
          `## Rules

1. When the user states a durable preference ("we use pnpm, never npm"), capture it via the memory capture path, not just this task's context.
2. Verified stack facts (which framework, which test runner) are worth remembering; one-off bug details are not.
3. Record decisions WITH their reason ("chose Zod — matches the other routes") so future changes can re-evaluate honestly.
4. Respect the cap: don't spam memory with per-task trivia; the retrieval layer boosts reinforced entries anyway.
5. When you see an existing memory contradicted by reality, correct it instead of working around it.
`,
      },
    ],
  },
  {
    slug: "tool-budget",
    category: "intelligence",
    version: "1.0.0",
    description: "Deliberate tool use: every call has a purpose, redundant probes are batched, exploratory churn is visible and self-limited.",
    skills: [
      {
        name: "tool-budget",
        body:
          SKILL_HEADER("Tool budget", "Tools are for evidence, not for looking busy.") +
          `## Rules

1. Before each tool call, know what answer it will produce and what you'll do with it. If nothing changes either way, skip it.
2. Batch independent reads into one call; don't serialize what can be parallel.
3. A failed call is retried with a CHANGED approach — the same call twice expecting different output is churn.
4. Cap your own exploration: if you've made 5 calls without new information, stop and re-read what you have.
5. Long loops checkpoint progress (write the summary-so-far) so an interrupt doesn't lose the work.
`,
      },
    ],
    hooks: { notify: ["search_code", "list_files"] },
  },
];
