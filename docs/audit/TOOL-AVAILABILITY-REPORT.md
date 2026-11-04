# Tool Availability Report — Operation Zero Failure

Audit date: 2026-11-04 · Baseline `572e64d` + fixes. Canonical roster: **42 tools** (`M3_TOOL_DEFINITIONS`).

## Coverage matrix (automated checks run this audit)

| Check | Method | Result |
|---|---|---|
| Registry enumeration | scripted extraction of `name:` fields from `tool-definitions.ts` | **42 unique names** |
| System-prompt representation | `master-prompt.ts` `buildToolRoster` is generated **from** `M3_TOOL_DEFINITIONS` (line 122) — cannot drift | 42/42 by construction; count rendered in the identity line |
| Schema registration (full tier) | `M3_TOOL_DEFINITIONS` passed to the model request in `/api/chat` (`GROQ_TOOL_DEFINITIONS` for compact tier) | 42/42 full, 28/28 compact |
| Dispatcher connectivity | literal/prefix search across dispatch sites | 42/42: 25 direct in `native-tools.ts`, 15 `browser_*` via prefix branch (line 1552), `mcp_call` via MCP lane (line 206), `spawn_subagent` in both lanes (executor 2003 / worker 1740) |
| Argument validation | zod/schema validation at the tool boundary; malformed provider tool-call args degrade to readable per-arg errors (`ai-providers.ts` 288–303) | enforced |
| Permission enforcement | path-jail, exec-guard, SSRF guard, approval gate, ask-mode refusal (`native-tools.ts` 391/408) | enforced at dispatcher, not prompt |
| Invalid-argument handling | executor tests + native-tools tests in baseline suite | covered by existing suites |
| Result delivery / call-ID mapping | tool results returned as `<tool_result name="…">` blocks tied to the call; failed tools return explicit errors | verified in code + baseline tests |
| Loop breakers | `createLoopStreaks` in both lanes | present |
| Budget enforcement | `subagentLimit` gate at both dispatch sites; refusal is an honest tool result | present |

## Test evidence

- Baseline full suite (before fixes): **210 suites / 2,337 tests passed, 1 skipped** — includes `browser-url-policy.test.ts`, `mcp-ssrf-fetch.test.ts`, reliability, verification-report, and executor suites.
- New regression tests this audit: `run-failure.test.ts` (3), `chat-middleware.test.ts` +3 → targeted runs **35/35** and **23/23** green.
- Multi-tool execution, cancellation, and turn limits: covered by existing executor/worker suites (part of the 2,337).

## Honest limits

- **Mocked, not live**: provider tool-calling was verified against mocked fixtures, not live provider APIs. No real-provider key was exercised this session, so "verified against real providers" count is **0** — recorded as such rather than inferred.
- **Compact-tier trade-off** is real and intentional: groq/nvidia receive 28 executable schemas, not 42. Awareness (prompt roster) stays at 42 for every provider. This is the documented compatibility strategy, not a silent capability loss.
- Packaged-app behavior of tool dispatch was not separately exercised (no packaged run this session).

## Counts (18.5 format)

| Metric | Count |
|---|---|
| Tools documented (canonical registry) | 42 |
| Tools represented in the system prompt | 42 (generated from registry) |
| Tools registered with native schemas — full tier | 42 |
| Tools registered with native schemas — compact tier (groq/nvidia) | 28 |
| Tools executable through the real dispatcher | 42 |
| Tools tested (any automated coverage) | 42 (via dispatcher-level suites) |
| Tools verified against real providers | 0 (mocked verification only) |
| Partially supported tools | 14 (browser_* on compact tier: prompt-aware, schema-reduced) |
| Unavailable tools | 0 |
