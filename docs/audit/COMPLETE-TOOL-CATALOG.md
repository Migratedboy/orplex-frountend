# Complete Tool Catalog — Operation Zero Failure

Source of truth: `M3_TOOL_DEFINITIONS` in `src/lib/tool-definitions.ts` (line 7). **Actual count: 42 tools** — not 41 as stated in the mission brief. The 42nd is `extract_archive`. Per the prior modularity audit's decision, **42 is canonical**; stale "41" references are documentation drift, not missing tools. No tool was invented or removed to reconcile the count.

## Catalog convention

This catalog does **not** duplicate every JSON schema verbatim — that would create exactly the "manually duplicated list that silently becomes outdated" the mission warns against. The authoritative schema for each tool is its entry in `tool-definitions.ts`; this catalog records the stable facts (purpose, risk, lane, dispatch site, tests) and points at the source.

## Roster (42)

| # | Tool | Purpose | Risk class | Dispatch site |
|---|---|---|---|---|
| 1 | `read_file` | Read file contents | read-only | `native-tools.ts` |
| 2 | `extract_archive` | Extract .zip into workspace (path-escape refused) | write | `native-tools.ts` |
| 3 | `list_files` | List workspace files | read-only | `native-tools.ts` |
| 4 | `write_file` | Write file contents | write | `native-tools.ts` (path-jail) |
| 5 | `create_file` | Create new file | write | `native-tools.ts` |
| 6 | `write_file_chunk` | Chunked large-file writes | write | `native-tools.ts` |
| 7 | `edit_file` | Targeted edit of existing file | write | `native-tools.ts` |
| 8 | `batch_edit` | Multi-edit in one call | write | `native-tools.ts` |
| 9 | `apply_edit_ops` | Structured edit operations | write | `native-tools.ts` |
| 10 | `search_code` | Search code by pattern | read-only | `native-tools.ts` |
| 11 | `code_search` | Symbol/reference search | read-only | `native-tools.ts` |
| 12 | `run_command` | Execute workspace command | exec (screened) | `native-tools.ts` via `exec-guard` |
| 13 | `run_in_sandbox` | Contained execution (installs/builds/tests) | exec (contained) | `native-tools.ts` |
| 14 | `web_search` | Web search | network | `native-tools.ts` |
| 15 | `playbook_search` | Search established memories | read-only | `native-tools.ts` |
| 16 | `skill_create` | Create a reusable skill | write | `native-tools.ts` |
| 17 | `session_search` | Search session history | read-only | `native-tools.ts` |
| 18 | `undo_last_change` | Revert last file change | write | `native-tools.ts` (line ~1258) |
| 19 | `take_screenshot` | Capture screen/preview | read-only | `native-tools.ts` |
| 20 | `todo_list` | Track task plan | safe | `native-tools.ts` |
| 21 | `scratchpad_update` | Persist task context | safe | `native-tools.ts` |
| 22 | `ask_question` | Ask the user a question | interaction | `native-tools.ts` |
| 23 | `ask_clarification` | Clarification request | interaction | `native-tools.ts` |
| 24 | `preview_browser` | Verify in the preview panel | network | `native-tools.ts` |
| 25 | `verify_app` | Start server + real browser check | exec+network | `native-tools.ts` |
| 26–40 | `browser_navigate`, `browser_read`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_console`, `browser_screenshot`, `browser_find`, `browser_wait_for`, `browser_hover`, `browser_select`, `browser_tabs`, `browser_network`, `browser_evaluate` | Agent's own browser automation (15 ops) | network (SSRF-guarded) | `native-tools.ts` line 1552 (`startsWith("browser_")` → browser contract) |
| 41 | `mcp_call` | Call a connected MCP server tool | network | `native-tools.ts` MCP lane (line 206) |
| 42 | `spawn_subagent` | Read-only research helper (depth 1) | delegation | `executor.ts` line 2003 / `background-worker.ts` line 1740 |

## Provider tiers

- **Full schemas**: everything except the compact tier (`FULL_TOOL_PROVIDERS`, `tool-definitions.ts` line 695).
- **Compact schemas**: `COMPACT_TOOL_PROVIDERS = ["groq", "nvidia"]` → `GROQ_TOOL_NAMES` (28 tools). The compact set is a strict subset chosen for TPM/context limits; the **system prompt still lists the full roster** so awareness never shrinks — only the executable schema set is reduced, and that reduction is by provider constraint, not omission.

## Permission / policy layer (applies to every dispatch)

- Argument validation per schema (`chatMessageSchema`-style zod checks at the tool boundary).
- Write paths: `assertSafeWrite` (realpath containment + denylist) — `src/lib/reliability/path-jail.ts`.
- Exec paths: `isCommandAllowed` screening — `src/lib/exec-guard.ts`.
- Network paths: `checkUrlPolicy` SSRF guard — `src/lib/ssrf-guard.ts`.
- Risky actions in the server lane: DB-backed approval gate, fail-closed (`requestUserApproval`).
- `ask` mode refuses all write/exec tools; environments without fs access refuse file tools (`native-tools.ts` lines 391, 408).
- Model requests can never self-grant permissions: enforcement is in the dispatcher, not the prompt.
