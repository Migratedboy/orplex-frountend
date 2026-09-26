---
sidebar_position: 5.5
---

# Extending Orplex

Orplex has four plain-text extension points that live **inside your workspace**. No plugins to compile, no code the agent executes blindly — you write markdown and JSON, the agent reads them at run time. All of them are cached for 60 seconds, so an edit applies within a minute without restarting anything.

| File | Scope | What it does |
|---|---|---|
| `orplex.md` | this repo | Project memory injected into every agent prompt |
| `.orplex/skills/<name>/SKILL.md` | this repo | Reusable instructions the agent loads on demand |
| `~/.orplex/skills/<name>/SKILL.md` | all your workspaces | The same, user-level |
| `.orplex/hooks.json` | this repo | Commands that run around tool calls and runs (opt-in) |

[MCP servers](./orplex-config.md) are the fourth pillar — external tool *processes* instead of text. Memory and skills give the agent knowledge; MCP gives it new capabilities; hooks give you an audit and gate on what it does.

Everything below is designed around a small RAM/TPM budget: fixed prompt overhead, lazy skill loading, and hooks that fail closed and fast.

---

## Project memory — `orplex.md`

This is Orplex's parity with Claude Code's `CLAUDE.md`: a markdown file at the workspace root whose content is injected into the system prompt of every server-executed run in that workspace. Put here what a competent colleague should know before touching the repo:

```md
# Project conventions

- Package manager is pnpm — never npm.
- Run `npx tsc --noEmit` before declaring anything done.
- The embedded Postgres lives on port 5433; never expose it.
```

An additional `.orplex/orplex.md` is merged after the root file (use it for rules you keep out of the repo, or per-checkout notes). Both locations are read every run.

### Token discipline: the `essentials` marker

On free-tier providers (≈8k TPM), every prompt character is budget. The loader therefore has two profiles:

- **full** — the first 6,000 characters of each file. Use for normal runs.
- **essentials** — only the section wrapped in `<!-- essentials -->` … `<!-- /essentials -->` (or the first 2,000 characters when no marker exists). Used on repair/continuation turns, where context must be tiny.

Mark the three to five lines that must survive every compaction:

```md
## Deployment

Long-winded history of the deploy setup …

<!-- essentials -->
- Deploy is `npm run deploy:staging` — never deploy from a dirty tree.
- Staging URL is in `.env.staging`, never commit it.
<!-- /essentials -->
```

## Skills — `.orplex/skills/<name>/SKILL.md`

A skill is a folder with one `SKILL.md`. The agent sees a **roster** (name + one-line description, at most 32 skills and 1,600 characters) in its system prompt and pulls the full body — up to 12,000 characters — only when it decides to `use_skill`. Lazy loading means ten skills cost less prompt space than one pasted paragraph.

```
.orplex/
└── skills/
    └── release-checklist/
        └── SKILL.md
```

`SKILL.md` format — a tiny frontmatter block, then the instructions:

```md
---
name: release-checklist
description: Steps to cut a release without breaking staging
---

1. `git fetch origin && git status` — tree must be clean.
2. Bump the version in package.json; commit as `chore(release): x.y.z`.
3. `npm run build` must pass; then tag and push the tag only.
4. Watch the deploy workflow; roll back with `npm run rollback:staging`.
```

- `name` defaults to the folder name; `description` (max 120 characters) is what the agent reads when deciding whether the skill is relevant — write it like an API doc line.
- User-level skills in `~/.orplex/skills/` are available in **every** workspace; project skills take precedence on name collision.
- Frontmatter parsing is deliberately minimal: `key: value` lines between the two `---` fences. Unknown keys are ignored.

**Skills vs MCP:** if the knowledge is "how we do things here" (process, conventions, checklists), write a skill. If the agent needs a *capability* it doesn't have (query an internal API, read a tracker), wire an MCP server instead.

## Hooks — `.orplex/hooks.json`

Hooks run your commands at four points in the agent loop — Claude Code-style, but spec-safe by construction: every command is screened by the exec-guard, runs with a 10-second timeout, gets a 4,000-character output cap, and runs **only** when you opt in.

**Opt-in first** — add to the server's `.env` and restart:

```bash
ORPLEX_USER_HOOKS=1
```

With the flag unset, `.orplex/hooks.json` is never executed anywhere — safe to commit a config your teammates can opt into later.

```json
{
  "hooks": [
    { "event": "pre-tool", "match": "run_command", "command": "node scripts/audit-cmd.js" },
    { "event": "post-run", "command": "npm run deploy-preview" }
  ]
}
```

### Events

| Event | Fires | `match` filters | Special behavior |
|---|---|---|---|
| `pre-tool` | before each tool call | by tool name (substring) | **Exit code 2 blocks the call**; stderr becomes the tool result the agent reads |
| `post-tool` | after each tool call | by tool name (substring) | — |
| `post-run` | after a run completes | — | — |
| `on-fail` | after a run fails | — | — |

### What your hook receives

Environment variables, on top of the normal process env:

| Variable | Content |
|---|---|
| `ORPLEX_HOOK_EVENT` | the event name (`pre-tool`, …) |
| `ORPLEX_TOOL` | tool name for pre/post-tool, empty otherwise |
| `ORPLEX_WORKSPACE` | absolute path of the workspace the run executes in |

### Rules and limits

- Max **20 hooks**, each command ≤ **500 characters**, single-line only (multi-line commands are refused — write a script file and call it).
- Commands run through the platform shell chosen explicitly (`cmd.exe /d /s /c` on Windows, `/bin/sh -c` elsewhere) — but **first** through the exec-guard, which refuses blocked patterns, env-prefixed interpreters (`FOO=x sh …`), encode-to-shell pipes, and multi-line payloads. A refused hook is logged and skipped, never fatal.
- Hooks run sequentially, 10 s timeout each; output is capped and appended to the run timeline context, not the prompt.
- Config errors (unknown event, missing command) make that entry ignored — the agent keeps running.

**Hooks vs `toolHooks`:** the declarative `deny`/`notify` regexes in [orplex.config.json](./orplex-config.md) evaluate instantly with zero processes and are always on. Use them for hard "never run this" rules. Reach for `.orplex/hooks.json` only when a rule needs to *execute* something (audit log, notify service, dynamic check) — and leave `ORPLEX_USER_HOOKS` off on shared or untrusted machines.

## Where things are wired

- Memory + skills: `src/lib/project-memory.ts`, `src/lib/user-skills.ts` → executor system prompt.
- Hooks: `src/lib/user-hooks.ts` → executor pre/post-tool, post-run and on-fail paths.
- MCP: `src/lib/mcp-client.ts` → `orplex.config.json` `mcpServers` (cap: 2 concurrent servers).

## Related

- [orplex.config.json Reference](./orplex-config.md) — MCP servers and declarative tool rules
- [Self-hosting](./self-hosting.md) — executor concurrency, memory watchdog and janitor
- [Driving Orplex from Claude Code](./claude-code.md) — Orplex as a tool of another agent
