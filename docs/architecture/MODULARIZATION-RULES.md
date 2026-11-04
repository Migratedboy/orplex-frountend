# MODULARIZATION-RULES.md — project-specific architectural rules

These are the regression-prevention rules for Orplex Code. They are constraints a change must respect to avoid architectural drift; they are **not** line-count limits. A cohesive 800-line module can be fine — splintering code into 50-line files is worse.

## M1 — One copy of lane-shared logic

- The chat lane (`background-worker`, `stream-reader`, `agent/native-tools`) and the server lane (`server-executor/executor.ts`) must share: compaction (`src/lib/compaction.ts`), effort budgeting (`src/lib/effort.ts`), loop detection (`src/lib/loop-detect.ts`), the tool registry (`src/lib/tool-definitions.ts`), the master prompt (`src/lib/master-prompt.ts`), web search (`src/lib/web-search.ts`).
- Never copy a shared function to "fix a lane quickly". Fix the shared module. Bug-fix history (v1.0.20–v1.0.28) shows every copied function drifted and had to be re-fixed twice.

## M2 — Boundary walls (no exceptions)

- `electron/**` never imports `src/**` (electron tsconfig `rootDir`). Intentional twin copies (e.g. `screenTerminalCommand` ≈ `exec-guard`, `mcpFetchUrlError` ≈ `mcp/ssrf-fetch`) must say so in a comment naming the twin.
- `src/**` never imports `electron/**`.
- `src/lib` leaf modules (`tool-text`, `tool-definitions`, `loop-detect`, `effort`, `web-search`, `tool-text`-level parsers) never import React, Next, Prisma, `electron`, or device SDKs.
- `src/components` and `src/hooks` never import Prisma or server-only modules. Data crosses the wall through `src/app/api/**/route.ts`.

## M3 — Module shape

- One primary responsibility per module; public interface as small as the callers actually need.
- No file that is *only* moved code — extraction must tighten something (a seam, a dependency edge, a smaller import surface).
- No barrel files re-exporting whole subsystems; import the real module. (Re-export bridges are allowed only while a rename-finish migration completes.)
- Under `src/lib`, prefer feature folders (`agent/`, `mcp/`, `reliability/`, `browser-verification/`, `server-executor/`) for anything with more than 3 related files; don't create a folder for 1 file.
- Server-lane tool additions must update BOTH: `buildNativeToolDefs` (executor) AND `mcp/post`/definitions where the client lane defines them — and the roster comment in `master-prompt.ts` categories table.

## M4 - Public interfaces are frozen on the wire.

Preserve across refactors unless a change explicitly announces and tests the migration: API routes + status codes, tool names/schemas, event names, IPC channel names, DB models, localStorage keys (`orplex.*`), file paths, serialization formats, environment variables, startup/shutdown ordering. Compatibility wrapper > breaking import; `git grep` before changing any export named in `MODULE-MAP.md`.

## M5 — Testing gates for a refactor

- Before extracting a critical module: establish/verify the test that pins it (route contract test, jest suite, or source-level regression test).
- A refactor commit must show: `npm run lint`, `npm run typecheck`, and the relevant `npx jest` suite(s) all green, plus `npm run audit` when routing/imports touched.
- Never bundle a behavior fix with a pure-move refactor. If behavior changes at all, it is feature work and must be documented separately.

## M6 — Known structural debts (tracked, deliberate)

- The tool dispatcher is duplicated (`agent/native-tools.ts` vs `server-executor/executeTool` ≈ 24 overlapping tools). Resolution path: adopt `agent/contract/results.ts formatToolResult` + prove parity by snapshot, then unify one tool-group at a time. Do not byte-copy between lanes instead.
- `isServerCommand` / `diagnosePortConflict` exist in `background-worker.ts` and `agent/serve-helpers.ts` with **diverged** semantics (`permission denied` handling). Unifying is a behavior decision — needs product sign-off, not a mechanical merge.
- Two validators share the exported name `validateToolArgs` (`reliability/tool-args` vs `agent/contract/tools`) with different semantics. Confusing by itself; ready to rename in a future behavior-free pass.

## M7 — New-code checklists

Adding a module:
1. Its file name says what it is — never `utils2.ts` or `helpers2.ts` under `src/lib`.
2. Imports listed in this doc's relevant section (or update `MODULE-MAP.md`).
2. One responsibility — if you wrote "and" you either need two modules or to stop.
3. Unit-test the module across test projects if pure (see jest.config); otherwise a route/hook test that executes it.
4. `npm run audit` + `npm run lint` + `npm run typecheck` green.

Changing a large file instead of splitting it:
- Allowed when the change is small, the file has unified responsibility, and splitting would create churn (ripple imports) that outweighs comprehension.

## Automated checks available now

- `npm run audit` — API wiring audit.
- `npm run lint` / `npm run typecheck` — ESLint + `tsc --noEmit` on both tsconfigs.
- `npm test` — jest (201 suites; includes source-level regression tests that read file text, e.g. `run-state-isolation.test.ts` — check them before moving code).
- Circular-import and dead-import detection: `npx eslint` + `tsc` catch most below-boundary imports; a dedicated dep-cruiser config is future work, not gating.
