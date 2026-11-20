# Orplex SDK + Marketplace — implementation plan

Status: proposed · Owner: Yash · App version at time of writing: 2.0.2
Goal: **the AI tool layer and cloud mode live in a published npm SDK**; **skills / MCP servers / plugins live in a public marketplace repo**; the app keeps only UI, orchestration and adapters.

---

## 1. Why

Today every tool, skill, MCP entry and plugin is compiled into the app. Consequences:

- A skill/MCP tweak needs a full app release (Electron build, installer, update).
- Nothing is reusable: the same tool layer cannot power a CLI, a server agent, or a third-party product.
- The 2.0.2 app carries ~5.5k lines of tool code, 101 skills, 101 MCP catalog entries, 25 plugins and 40 bundles in the main bundle.

After this plan:

| artifact | owns | ships as |
|---|---|---|
| `orplex-sdk` | AI tools, MCP client/gateway, skills loader, plugin runtime, cloud client, marketplace client | npm package |
| `orplex-marketplace` | the *data*: skills, MCP specs, plugin bundles | public GitHub repo, signed index |
| `orplex` (the app) | UI, agent loop, adapters implementing SDK ports, Next routes | unchanged distribution |

---

## 2. Measured baseline (verified against the working tree)

| asset | location | size |
|---|---|---|
| Skills catalog | `src/lib/skills.ts` | 1,131 lines, **101** skills |
| MCP catalog | `src/lib/mcp-catalog.ts` | 693 lines, **101** entries |
| Built-in plugins | `src/lib/plugins/builtin/*.ts` | **25** files |
| Plugin bundles | `src/lib/plugin-library/{5 categories}.ts` | **40** bundles (8 × 5) |
| Tool definitions | `src/lib/tool-definitions.ts` | 895 lines |
| Tool dispatch | `src/lib/agent/native-tools.ts` | 1,819 lines, `dispatchToolCall(call, ctx)` |
| Tool support | `tool-chain` 382 · `tool-hooks` 159 · `tool-text` 407 | 948 |
| File ops | `agent/file-ops` 210 · `serve-helpers` 20 · `archive-extract` 418 | 648 |
| Guard/risk/const | `exec-guard` 417 · `risk-classifier` 228 · `constants` 117 | 762 |
| MCP runtime | `mcp-client`, `mcp-gateway`, `mcp-auth`, `agent/mcp-lane` | ~1.1k |
| Skills runtime | `skills.ts`, `user-skills.ts` | 1,356 |
| Plugin runtime | `plugins/{types,registry,initializer}`, `plugin-bundles.ts` | ~800 |
| Cloud mode | `api-base.ts` 111, `app-session.ts`, `proxy.ts`, `electron/auth-desktop.ts` | ~400 |
| Coupled tests | `plugin-runtime`, `plugin-bundles`, `dispatch-surface`, `use-skill`, `scripts/audit-mcp-catalog.mjs`, `scripts/audit-events.mjs` | must move with the data |

Dependency audit — imports of `next`, `@prisma/client`, `react` inside the tool layer: **zero** (two comment-only mentions). The layer is already framework-free; `ToolContext` is already an injected interface. This is what makes extraction realistic.

---

## 3. Target architecture

```
                 ┌─────────────────────────────┐
                 │  orplex-marketplace (git)   │  data only, no code
                 │  catalog/index.json (signed)│
                 │  mcp/*  skills/*  plugins/* │
                 └──────────┬──────────────────┘
                            │ https + Ed25519 verify
┌───────────────────────────┴──────────────────────────────┐
│ orplex-sdk (npm)                                          │
│  /tools /mcp /skills /plugins /cloud /marketplace         │
│  no next · no prisma · no react · no electron             │
└───────────────────────────┬──────────────────────────────┘
                            │ imports (types + impls)
        ┌───────────────────┴────────────────────┐
        │ orplex app (Electron + Next 16)        │
        │  adapters/ (ports) · loop-engine · UI  │
        └────────────────────────────────────────┘
```

### 3.1 SDK package

Name: **`orplex-sdk`** (unscoped; `orplex-sdk` and `@orplex/sdk` are both unclaimed on npm — unscoped avoids an org dependency). Subpath exports:

| subpath | contents | notable exports |
|---|---|---|
| `orplex-sdk/tools` | `tool-definitions`, `native-tools` (dispatch), `tool-chain`, `tool-hooks`, `tool-text`, `file-ops`, `serve-helpers`, `archive-extract`, `exec-guard`, `risk-classifier`, `constants` | `TOOL_DEFINITIONS`, `dispatchToolCall`, `ToolContext`, `ToolPorts`, `classifyRisk`, `isCommandAllowed` |
| `orplex-sdk/mcp` | `mcp-client`, `mcp-gateway`, `mcp-auth`, `mcp-lane`, catalog **types** | `McpClient`, `McpGateway`, `McpCatalogEntry`, `runMcpLane` |
| `orplex-sdk/skills` | `user-skills` loader/parser, roster renderer | `loadUserSkills`, `parseFrontmatter`, `renderSkillRoster`, `findSkill` |
| `orplex-sdk/plugins` | registry, hook compiler, bundle parser | `pluginRegistry`, `parseToolHookConfig`, `parseBundle` |
| `orplex-sdk/cloud` | `api-base`, session verify | `apiFetch`, `withApiBase`, `verifyAppSession`, `API_BASE` |
| `orplex-sdk/marketplace` | index client, resolver, cache, signature verify | `fetchIndex`, `resolveCatalog`, `installItem`, `verifyIndex` |

Build: `tsup` → ESM + CJS + `.d.ts`; `sideEffects: false`; `engines.node >= 20`; `zod` for manifest schemas; MIT licence; vitest.

### 3.2 The ports contract (the seam that makes it publishable)

Everything the SDK cannot know is an interface the app implements:

```ts
export interface ToolPorts {
  fs: FileOpsFs;                       // read/write/stat inside the workspace
  approvals: {
    request(req: ApprovalRequest): Promise<ApprovalDecision>;
  };
  events: {
    activity(e: ActivityEvent): void;   // app's SSE / UI stream
    preview(p: PreviewEvent): void;
  };
  store: {
    setTodos(items: string[]): void;
    completeTodo(index: number): void;
    clearTodos(): void;
    setQuestion(q: QuestionSpec): void;
    answerQuestion(a: string): void;
  };
  stats: { commandRun(): void; failedStep(): void; rejectedAction(): void };
  history: { computeDiff(a: string, b: string): Diff; snapshot(p: string): void };
  api: { fetch(path: string, init?: RequestInit): Promise<Response> };  // default = cloud client
  extractArchive?: (path: string) => Promise<ExtractResult>;             // injected so bundlers keep tracing it
}
```

The app's existing modules map 1:1 (`approval-store`, `agent-events`, `background-chat`, `file-history`, `virtual-fs`, `electron fs bridge`) — no behaviour rewrite, only wiring.

### 3.3 Marketplace repo

```
orplex-marketplace/
├── catalog/index.json           # {schemaVersion, generatedAt, minAppVersion, items[], signature}
├── schemas/{item,index,skill,plugin}.schema.json
├── mcp/<id>/manifest.json + README.md          (101)
├── skills/<slug>/SKILL.md                      (101)
├── plugins/<slug>/manifest.json + skills/*.md  (65)
├── scripts/{build-index,validate}.mjs
└── .github/workflows/validate.yml
```

`catalog/index.json` item shape:

```json
{
  "id": "supabase",
  "kind": "mcp",
  "version": "1.2.0",
  "engine": ">=2.0.0 <3",
  "path": "mcp/supabase/",
  "sha256": "…",
  "size": 4213,
  "tags": ["database"],
  "auth": "oauth"
}
```

Rules:
- CI validates every manifest against `schemas/`, recomputes `sha256`, rebuilds `index.json`, and refuses a PR that hand-edits the index.
- The index is Ed25519-signed with the existing key infra (`ORPLEX_SESSION_PRIVATE_KEY` / `…PUBLIC_KEY` pattern); the app ships the public key and rejects unsigned/mismatched items.
- **Plugins are data, not code**: `SKILL.md` + declarative hook rules + MCP specs. Executable plugins are reviewed and vendored — never fetched at runtime. Remote code + an agent with filesystem access is a supply-chain hole, so this is a hard rule, not a preference.

---

## 4. App changes

**Deleted from the app:** the 13 tool/guard/mcp/plugin/skill modules listed in §2, `plugin-library/`, `plugins/builtin/`, `skills.ts`, `mcp-catalog.ts`.
**Kept:** `loop-engine.ts` (461 lines — streaming orchestration tied to UI events), all `app/api/**` routes (they become thin SDK callers), all components, adapters.
**Added:** `src/lib/sdk.ts` (single adapter module: constructs `ToolPorts`, resolves the marketplace catalog, exposes SDK to routes), `src/app/api/marketplace/*`, marketplace UI.

### 4.1 Migration technique — strangler with re-export shims

For every moved module the app file becomes one line:

```ts
export * from "orplex-sdk/tools";            // src/lib/tool-definitions.ts
```

Consequences: the app compiles unchanged, the existing jest suites (4 suites), `scripts/audit-events.mjs` and `scripts/audit-mcp-catalog.mjs` keep passing, and each module can be rolled back independently. Bodies are deleted only after the gates in §6 pass.

---

## 5. Phases

| # | phase | work | exit criteria |
|---|---|---|---|
| 0 | Freeze contract | copy 6 type files + tool-result XML contract into SDK `schemas/`; add golden-file tests for `<tool_result>` output | golden tests reproduce current output byte-identically |
| 1 | Scaffold | `D:\orplex-sdk` (tsup, exports map, vitest, zod, README, LICENSE), `D:\orplex-marketplace` (schemas, scripts, CI) | `npm run build` + `npm test` green in an empty package |
| 2 | Tools → SDK | move the 11 tool/guard modules verbatim; introduce `ToolPorts`; replace the 6 app imports in `native-tools.ts` with ports | SDK unit tests green; dispatch behaves identically under fake ports |
| 3 | Shims in app | re-export every moved file; wire `src/lib/sdk.ts`; **no behaviour change** | `tsc --noEmit`, jest, `npm run build`, `electron:dist`, one real agent turn |
| 4 | Delete bodies | remove the 2 dynamic imports (`archive-extract`) behind `ports.extractArchive`; delete moved sources + their tests (already in SDK) | same gates + `knip` clean |
| 5 | MCP + skills + plugins → SDK | move runtimes; catalog/skills **content** goes to the marketplace instead | SDK tests; app builds |
| 6 | Marketplace data extraction | `scripts/extract-marketplace.mjs` emits 101/101/65; deep-equal assert against current constants | `orplex-marketplace` v1.0.0 tagged, CI green |
| 7 | Runtime fetch | ETag + 12h cache + 3s timeout + signature verify + fallback chain (network → cache → 12-item vendored seed) | fresh install with network off still has 12 skills + 12 MCP |
| 8 | Marketplace UI | browse/search/install/update/pin, provenance badge, offline badge; `/api/plugins` + `/api/mcp/catalog` read resolved catalog | manual pass over 6 journeys |
| 9 | Publish | `npm publish --access public`; README with a 10-line "build your own agent" example; release notes | `npm i orplex-sdk` works from a clean dir |

Estimate: 9–11 focused days full plan; **2 days** for a publishable slim SDK (phases 0–2 + `cloud` + `marketplace` client, plugin runtime deferred).

---

## 6. Quality gates (must pass before deleting code)

1. `tsc --noEmit` (app + SDK), `tsc -p electron/tsconfig.json`
2. `npm test` (jest) — including the moved `dispatch-surface`, `plugin-runtime`, `plugin-bundles`, `use-skill` suites
3. `npm run build` **and** `npm run electron:dist` — dynamic imports vanish silently in the standalone bundle; only the packaging run proves it
4. One scripted agent turn per tool family (fs read/write, shell, search, MCP call, skill use, archive)
5. `knip` clean — no orphaned shims left behind
6. `scripts/audit-events.mjs`, `scripts/audit-mcp-catalog.mjs` pass (moved to the SDK repo)

---

## 7. Risk register

| risk | impact | mitigation |
|---|---|---|
| `native-tools.ts` (1,819 lines) behaviour drift during ports refactor | broken tool calls | golden `<tool_result>` tests before touching it; shim = instant rollback |
| Electron/standalone drops dynamic imports | tool missing only in packaged build | gate 3 (`electron:dist`) + `ports.extractArchive` injection |
| Tests assert against built-in constants | red build after extraction | tests move in the same commit as the deletion |
| First run with no network | empty skills/MCP list looks broken | vendored seed (12 items) + cached index |
| Supply chain: remote plugin code | RCE in an agent with fs access | plugins are data only; signed index + per-item sha256 |
| npm scope/ownership | cannot publish | `orplex-sdk` unscoped is free; requires **your** `npm login` |
| Two repos drift (marketplace vs SDK types) | runtime type mismatches | schemas live in the SDK and are vendored into the marketplace; CI fails on mismatch |

---

## 8. Publishing checklist

```bash
# one-time, needs the account holder
npm login                                   # I cannot do this
npm whoami                                  # expect your username

cd /d/orplex-sdk
npm run build && npm test
npm pack --dry-run                          # inspect the tarball contents
npm publish --access public                 # orplex-sdk@0.1.0
```

Versioning: SDK semver tied to the app's `minAppVersion`; marketplace items declare an `engine` range so old apps never load incompatible items.

Marketplace repo creation and pushes: `gh` is already authenticated as `Migratedboy`, so I can create and push it; only npm needs you.

---

## 9. Decisions I need from you

1. **SDK name**: `orplex-sdk` (no org needed) — confirm, or create the `orplex` npm org for `@orplex/sdk`.
2. **Repo layout**: two standalone repos (`orplex-sdk`, `orplex-marketplace`) as planned, or a monorepo with `packages/sdk` + `packages/marketplace`?
3. **Scope of v1**: full plan (tools + MCP + skills + plugins + marketplace) or slim publish first (tools + cloud + marketplace client)?
4. **Loop engine**: keep in the app for now, or target `orplex-sdk/agent` with an injected model client later (phase 10)?

Default if you say nothing: `orplex-sdk`, two repos, full plan, loop stays in the app.
