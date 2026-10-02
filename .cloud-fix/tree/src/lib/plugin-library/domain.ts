// plugin-library/domain.ts — Domain category: 8 bundles.

import { SKILL_HEADER, type BundleDef } from "./types";

export const DOMAIN_BUNDLES: BundleDef[] = [
  {
    slug: "rest-endpoint",
    category: "domain",
    version: "1.0.0",
    description: "Scaffolding for typed Next.js route handlers: auth first, zod-validated bodies, typed JSON errors, status-code discipline.",
    skills: [
      {
        name: "rest-endpoint",
        body:
          SKILL_HEADER("REST endpoint scaffold", "Conventions for a new route handler under src/app/api.") +
          `## Shape

- export const dynamic = "force-dynamic" on every handler that reads state.
- Auth first: getServerSession(jwtOnlyOptions) → 401 before any work.
- Validate the body with a zod schema; return 400 with the flatten() output on failure.
- Wrap DB access in try/catch; return typed JSON errors, never raw exception text.
- Success responses: the created/updated row (or { ok: true }), status 200/201.

## Skeleton

\`\`\`ts
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { z } from "zod";

const BodySchema = z.object({ name: z.string().min(1).max(200) });

export async function POST(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body", issues: parsed.error.flatten() }, { status: 400 });
  // ...do the work...
  return NextResponse.json({ ok: true });
}
\`\`\`
`,
      },
    ],
  },
  {
    slug: "prisma-model",
    category: "domain",
    version: "1.0.0",
    description: "Prisma model conventions: cuid ids, timestamps, motivated indexes, snake_case table mapping, generate+push after edits.",
    skills: [
      {
        name: "prisma-model",
        body:
          SKILL_HEADER("Prisma model scaffold", "Conventions for new models in prisma/schema.prisma.") +
          `## Rules

1. Every model: id String @id @default(cuid()), createdAt DateTime @default(now()); add updatedAt when rows mutate.
2. Foreign keys get an @@index([fk]); every query path in the task gets an index — say which query motivated each one.
3. Map to snake_case plural tables: @@map("task_runs").
4. Json columns are for genuinely shape-flexible data; anything queried or filtered gets real columns.
5. After editing the schema: npx prisma generate (types) and npx prisma db push (local dev DB) — then run the typecheck lane.
`,
      },
    ],
  },
  {
    slug: "react-component",
    category: "domain",
    version: "1.0.0",
    description: "React component conventions: hooks-first, props typed at the definition, lists keyed stably, effects narrow and cancellable.",
    skills: [
      {
        name: "react-component",
        body:
          SKILL_HEADER("React component scaffold", "Conventions for components in src/components.") +
          `## Rules

1. Props get a named interface at the top of the file; no anonymous inline object props on exported components.
2. State is the minimal truth — derive everything else during render instead of mirroring state.
3. Every effect has a cleanup for what it starts (subscriptions, timers, in-flight fetches with a cancelled flag).
4. Lists are keyed by stable data ids, never array indices that reorder.
5. "use client" only when the component truly needs it; server components are the default in app router.
6. Match the project's styling approach (this repo: Tailwind utilities + globals.css classes, theme-aware via .dark).
`,
      },
    ],
  },
  {
    slug: "api-client",
    category: "domain",
    version: "1.0.0",
    description: "Client data-fetching conventions: the shared apiFetch wrapper, typed responses, abortable requests, honest error surfaces.",
    skills: [
      {
        name: "api-client",
        body:
          SKILL_HEADER("API client conventions", "One fetch wrapper, typed responses, no ad-hoc fetch spaghetti.") +
          `## Rules

1. Use the project's apiFetch (it resolves the API base and same-origin semantics) — never bare fetch to relative paths.
2. Responses are parsed into declared interfaces; unknown shapes fail loudly at the parse, not three screens later.
3. Requests tied to unmounted components carry an AbortSignal; races on rapid input are cancelled, not debounced into mush.
4. Error UI states are explicit: loading, empty, error, retry — never an infinite spinner.
5. Polling intervals clean up on unmount and pause when the tab is hidden where practical.
`,
      },
    ],
  },
  {
    slug: "form-validation",
    category: "domain",
    version: "1.0.0",
    description: "Form patterns: schema-driven validation shared between client and server, inline errors, disabled-while-pending submit.",
    skills: [
      {
        name: "form-validation",
        body:
          SKILL_HEADER("Form validation", "The schema is the contract — write it once, use it on both sides.") +
          `## Rules

1. Define the zod schema once; the client validates for UX, the server re-validates for truth.
2. Validation errors render inline next to their field, with the message from the schema — not a generic toast.
3. Submit buttons disable while pending and show progress; double-submits are impossible by construction.
4. Server failures map back onto the form (field errors where identifiable) instead of vanishing.
5. Never trust pre-filled values from the URL/body — they pass through the same schema as fresh input.
`,
      },
    ],
  },
  {
    slug: "notification-events",
    category: "domain",
    version: "1.0.0",
    description: "App notification conventions: typed events into the notification center, user-readable copy, no raw errors.",
    skills: [
      {
        name: "notification-events",
        body:
          SKILL_HEADER("Notification events", "Notifications are user-facing UI — write them like product copy, not logs.") +
          `## Rules

1. Long-running outcomes (run completed/failed, approval needed) emit into the notification center, not just console state.
2. Copy is specific: "Deploy of api-service failed — image build exited 1", never "Something went wrong".
3. Every notification carries a route/link target so clicking it lands somewhere useful.
4. Deduplicate repeat events for the same entity; aggregate storms ("3 files updated") instead of spamming.
5. Failure notifications include the first actionable fix, not just the error class.
`,
      },
    ],
  },
  {
    slug: "background-jobs",
    category: "domain",
    version: "1.0.0",
    description: "Long-running work follows the executor pattern: DB-backed state, lease/claim discipline, resumable progress, honest terminal states.",
    skills: [
      {
        name: "background-jobs",
        body:
          SKILL_HEADER("Background jobs", "Anything that can outlive a request needs durable state and a heartbeat.") +
          `## Rules

1. Job state lives in the DB (status + result columns), never only in process memory — restarts must not lose the trail.
2. Claiming uses atomic compare-and-swap leases so two workers cannot run one job.
3. Progress is written incrementally so the UI can show something honest while it runs.
4. Terminal states are explicit: completed, failed (with reason), cancelled — "stuck" is a bug to fix, not a status.
5. Startup reconciliation requeues jobs orphaned by a crash, bounded retries, then fails honestly.
`,
      },
    ],
  },
  {
    slug: "ws-sse-streams",
    category: "domain",
    version: "1.0.0",
    description: "Streaming endpoint conventions: SSE with heartbeats, cursor-based resumption, client cleanup on unmount.",
    skills: [
      {
        name: "ws-sse-streams",
        body:
          SKILL_HEADER("SSE / streaming conventions", "Streams leak — every one needs a close story.") +
          `## Rules

1. SSE responses set the right headers (text/event-stream, no-cache, keep-alive) and send an initial retry hint.
2. Heartbeats keep proxies from killing idle streams; the interval cleans up on close.
3. Event consumers are cursor-based: the client sends the last sequence, the server sends only what's newer.
4. Clients close EventSource/fetch-streams on unmount and on auth loss; reconnect is exponential-backoff, capped.
5. Payloads are JSON-stringified once at the server, parsed once at the client — no double-encoded nesting.
`,
      },
    ],
  },
];
