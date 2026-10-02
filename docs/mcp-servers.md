# MCP servers in Orplex

Orplex agents can use **MCP (Model Context Protocol) servers** — external tool
services (Supabase, Vercel, Figma, GitHub, Slack, Stripe, 100+ more) whose
tools are handed to the AI on every run. Users connect them once in the UI;
the agent handles the rest.

## For users: connecting a server

1. In the chat prompt bar, click the **MCP** plug chip (or **+ → MCP servers**).
2. Search or filter the catalog (Databases, Cloud, Design, Dev tools, …).
3. Click **Connect** on a server and fill its credentials (marked `secret`
   fields are encrypted with AES-256-GCM before storage and never returned to
   the browser).
4. Click **Test** to run a real `tools/list` probe — the badge turns
   **healthy** when the server answers, **failing** with the error when not.
5. Done. The server's tools are available to the agent in **every run** — it
   calls them automatically when a task needs them, no per-task setup.

Notes:
- A run loads at most **2 MCP servers** (low-spec budget, see
  `backend/src/lib/mcp-client.ts`); servers that most recently tested healthy
  win the slots.
- The max **20 connectors** per account.
- Workspace `orplex.config.json` `mcpServers` (Claude Code config shape) still
  work and win name conflicts over account connectors.

## For the agent: how MCP tools work

MCP tools appear in the tool roster under the name pattern
`mcp__<server>__<tool>` (e.g. `mcp__github__create_issue`). Guidance is
injected into the system prompt on runs that have MCP tools
(`backend/src/lib/mcp-prompt.ts`):

- arguments follow each tool's JSON schema, exactly like native tools;
- the services are REAL — writes affect the user's account, so prefer reads
  and only write when the task clearly asks;
- a failed call is information: read the error, adjust, retry once, then
  continue and report what could not be done;
- never invent MCP tools outside the roster; never put secrets in arguments.

Server summaries (what each service is) are injected alongside the roster so
cryptic tool names like `supabase_list_tables` have context.

## Architecture (backend/)

```
src/lib/mcp-catalog.ts        verified catalog (101 entries, categories,
                              envSpec incl. secret flags) + search
src/lib/mcp-accounts.ts       per-user connections: encrypted env, list/
                              connect/disconnect/enable, executor collection
src/lib/mcp-client.ts         stdio JSON-RPC client (wire protocol), config-
                              keyed session cache, idle reaper
src/lib/mcp-prompt.ts         agent guidance blocks (usage rules, summaries)
src/app/api/mcp/catalog/      GET  search the catalog
src/app/api/mcp/servers/      GET/POST/PATCH/DELETE user connectors
src/app/api/mcp/test-connection/  POST real spawn + tools/list probe
```

Storage: `McpServerConfig` (Prisma) — one row per user per catalog id,
Claude-Code wire shape (`command`/`args`/`env`), secret env values encrypted
via `key-encryption.ts` (same key as BYOK provider keys).

Executor integration (`backend/src/lib/server-executor/executor.ts`): each run
merges account connectors with workspace config, spawns servers, lists tools
into the roster, injects the usage block, and dispatches `mcp__` calls through
the same hooks/deny gate as native tools. Sessions are keyed by resolved
config hash, so two users' servers never share a process.

## Adding a server to the catalog

Append an `entry(...)` in `mcp-catalog.ts`:

```ts
entry("acme", "Acme", "What it does.", "devtools",
  npx("acme-mcp-server"),
  [KEY_ENV("ACME_API_KEY", "Where to get it")],
  { docsUrl: "https://…", popular: true });
```

Honesty rule: verify the command against the project's README when adding it,
and keep descriptions user-facing. The test-connection probe catches stale
templates loudly at connect time.
