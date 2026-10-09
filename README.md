# Orplex

AI coding assistant with streaming chat, conversation history, file context, OAuth authentication, and multi-provider inference.

## Current Features

**Flagship capabilities**

- **AI coding agent** — streaming chat with real tool calling, three modes, worktree-isolated server runs with explicit merge/discard review
- **BYOK frontier mode** — any OpenAI-compatible endpoint + your key (`AI_PROVIDER=custom`), per-run model overrides, live provider badge
- **Morning PR queue** — schedule runs for overnight (`🌙 Tonight` or the batch API), branches pushed with PR/compare links, merge from the run drawer
- **Audit bundle (flight recorder)** — every run exports a tamper-evident file: SHA-256 hash-chained events, artifacts, approval decisions, human-readable manifest, verify endpoint
- **MCP in both directions** — use external MCP servers in Orplex runs (`orplex.config.json`), and drive Orplex from Claude Code via the stdio proxy
- **Summarizing compaction + workspace memory** — decisions preserved under tiny token budgets instead of silently truncated

**Also included**

- **AI Chat** - Streaming responses with markdown and code syntax highlighting
- **Conversation History** - Persisted in Supabase PostgreSQL, searchable and renameable
- **File Attachments** - Upload text files and images, sent as context to the AI model
- **OAuth Authentication** - Google and GitHub sign-in via NextAuth.js
- **Multi-Provider AI** - OpenRouter (primary) with NVIDIA fallback
- **Bug Report** - In-app bug reporting with email notification
- **Dark Mode** - Toggle between light and dark themes
- **Keyboard Shortcuts** - Ctrl+K search, Ctrl+N new chat, Esc stop generation
- **Mobile Responsive** - Hamburger menu, responsive layout

## Where to look next

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the Electron shell, agent runtime,
  API layer, and data stores actually fit together (the source of truth).
- **[CONTRIBUTING.md](CONTRIBUTING.md)** / **[SECURITY.md](SECURITY.md)** —
  workflow and vulnerability reporting.

> This section used to list the agent loop, git integration, code review, and
> task persistence as "in development". All of them ship now — see Current
> Features above.

## Getting Started

### Prerequisites

- Node.js v18+
- A Supabase project (for PostgreSQL database)
- OpenRouter API key (free tier available)
- Google OAuth credentials (optional)

### Installation

```bash
git clone https://github.com/Migratedboy/orplex-agentic-codiing-.git
cd orplex-agentic-codiing-
npm install
```

### Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
# Database (Supabase)
DATABASE_URL=postgresql://postgres:your-password@your-project.supabase.co:5432/postgres

# Auth
NEXTAUTH_URL=http://localhost:5000
NEXTAUTH_SECRET=your-random-secret-here

# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# AI Providers
OPENROUTER_API_KEY=your-openrouter-key
OPENROUTER_MODEL=qwen/qwen3.8-27b:free
NVIDIA_API_KEY=your-nvidia-key
NVIDIA_MODEL=nvidia/nemotron-3-super-120b-a12b

# BYOK frontier mode (optional): point Orplex at ANY OpenAI-compatible
# endpoint — your own Claude, Gemini, or OpenRouter key.
# AI_PROVIDER=custom
# AI_BASE_URL=https://api.anthropic.com/v1/chat/completions
# AI_API_KEY=sk-ant-...
# AI_MODEL=claude-sonnet-4

# Morning PR queue (optional): push agent branches after each server run.
# ORPLEX_PUSH_BRANCH=1

# MCP gateway token (optional): lets the local stdio proxy
# (scripts/orplex-mcp-server.mjs) drive Orplex from any MCP client,
# including Claude Code. Use a long random value.
# ORPLEX_MCP_TOKEN=change-me-to-something-long-and-random

# CORS
ALLOWED_ORIGINS=http://localhost:5000
```

### Run

```bash
npm run dev
```

### Plug in your own key (BYOK frontier mode)

Set `AI_PROVIDER=custom` with any OpenAI-compatible endpoint and your key —
Claude (via its compat endpoint), Gemini (via `generativelanguage.googleapis.com/v1beta/openai/...`),
OpenRouter, or a local proxy. Per-run overrides: pick **Custom (BYOK model id)**
in the Manager spawn dialog, or pass `modelOverride` to `POST /api/agent/runs`.

```bash
# Anthropic via its OpenAI-compatible endpoint
AI_PROVIDER=custom
AI_BASE_URL=https://api.anthropic.com/v1/chat/completions
AI_API_KEY=sk-ant-...
AI_MODEL=claude-sonnet-4

# Gemini via its OpenAI-compatible endpoint
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
AI_MODEL=gemini-2.5-pro
```

### The morning PR queue

Spawn with **🌙 Tonight (02:00)** (or `POST /api/agent/runs/batch` with
`{ prompts: [...], staggerMinutes: 30 }`) and the serial executor works
through the queue overnight — one run at a time, sipping the free tier.
With `ORPLEX_PUSH_BRANCH=1`, each finished run pushes its
`orplex/run-*` branch and posts a review link (a real PR when `gh` is
installed, otherwise the GitHub compare URL) to the timeline. Wake up,
review the diffs, merge from the run drawer.

### Use Orplex from Claude Code (MCP)

Orplex speaks MCP in both directions. To drive Orplex from any MCP client:

```bash
export ORPLEX_MCP_TOKEN=<long random value>   # same value in the server env
node scripts/orplex-mcp-server.mjs            # stdio MCP server
```

Register in Claude Code's `.mcp.json`:

```json
{ "mcpServers": { "orplex": { "command": "node",
  "args": ["scripts/orplex-mcp-server.mjs"],
  "env": { "ORPLEX_URL": "http://localhost:5000", "ORPLEX_MCP_TOKEN": "<token>" } } } }
```

Tools: `spawn_run`, `list_runs`, `get_run_review`, `merge_run` — Claude Code
can launch isolated Orplex runs and read back the review patch.
Step-by-step guide: [docs → Driving Orplex from Claude Code](docs-site/docs/guides/claude-code.md).
Conversely,
add MCP servers to Orplex in `orplex.config.json` under `mcpServers`
(same shape as Claude Code's config):

```json
{ "mcpServers": { "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } } }
```

Max 2 servers, idle-reaped after 5 minutes, tool calls time out at 120s.
Full reference for `mcpServers` + `toolHooks` (deny/notify rules): see
[docs → orplex.config.json](docs-site/docs/guides/orplex-config.md).

Open http://localhost:5000

### Testing Without OAuth (dev only)

Running under `next dev` automatically enables a **dev-only session bypass**: the
sign-in page shows a **"Continue as Dev User"** button that creates a local
session (seeded `dev-user` row + signed session cookie) so the chat flow can be
tested end-to-end without Google/GitHub credentials. It is **never active in
production** (`NODE_ENV=production`). To disable it even in dev, set
`DEV_AUTH_BYPASS=false` in `.env`.

The sign-in page also shows an **"End dev session"** action (dev only) that
expires the httpOnly dev cookie via `/api/dev/session?action=logout`, so
testers can log out and back in under a different (real OAuth) identity.
It reloads into the sign-in page with a confirmation notice and is covered by
the E2E suite.

### E2E Tests (Playwright, no AI keys needed)

```bash
npm run test:e2e
```

The suite starts its own dev server on **:5100** (leaving any dev server you
have on :5000 untouched) with two dev-only flags:

- `DEV_AUTH_BYPASS=1` — logs in through the dev session bypass above.
- `MOCK_AI=1` — `/api/chat` answers with a slow, deterministic fake stream
  (`src/lib/mock-ai.ts`) instead of a real provider, so the streaming UI,
  **Stop mid-stream**, resend, and queue handling are exercised with zero API
  keys and zero quota usage. The flag is inert in production builds and never
  counted against rate/quota limits.

Coverage: dev-login through the sign-in page · send a message and stream a
full reply · Stop mid-stream (reply is cut, no failure UI, resend completes
on a fresh task) · Stop with a queued prompt (queue cleared + toast) ·
seeded non-empty UI states.

**Seeded sample data** (`/api/dev/session?action=seed`, dev only): the E2E
suite seeds the dev user with 3 sample conversations (visible in "Recent
Chats" and openable), quota usage (`12/50 requests today` on the meter), a
sample workspace + owner membership, and usage-log history so tests
exercise non-empty UI. Idempotent fixed ids — safe to re-run. The workspace
rows require the `workspaces` tables in your dev DB (added to the schema
after older databases were provisioned); run `npx prisma db push` to
enable them, otherwise seeding degrades gracefully and skips them.

Chromium must be installed once: `npx playwright install chromium`.

### Database Setup

```bash
# Push schema to Supabase
npx prisma db push

# Generate Prisma client
npx prisma generate
```

## Tech Stack

- **Frontend**: Next.js 16 (App Router), React 18, TypeScript
- **Styling**: Tailwind CSS + custom global CSS (`globals.css`) in a warm
  amber/obsidian design system; brand typefaces are self-hosted Lexend +
  JetBrains Mono with no Google Fonts runtime dependency — see
  [Brand & Documentation](#brand--documentation)
- **Brand tokens**: orange accent ramp, light/dark neutrals, and the
  radius/spacing/shadow scale live in [BRAND.md](./BRAND.md)
- **Database**: Supabase (PostgreSQL) via Prisma
- **Auth**: NextAuth.js with Google/GitHub OAuth
- **AI**: OpenRouter + NVIDIA through an OpenAI-compatible fallback chain with
  streaming SSE; `MOCK_AI` seam for keyless dev and E2E tests
- **Validation**: Zod schemas on all API inputs

## Architecture

```
User Request
    |
    v
Next.js API Route (/api/chat)
    |
    v
Provider Fallback Chain
    |-- OpenRouter (primary)
    |-- NVIDIA (fallback)
    |
    v
SSE Stream to Client
    |
    v
React UI (streaming render)
```

## Brand & Documentation

Two companion docs define the product's look and the docs-site:

- **[BRAND.md](./BRAND.md)** — the unified visual language shared by the app
  and the docs: the orange accent ramp (`#a04100` / `#FF6B00`), neutral +
  semantic tokens for light/dark, radius/spacing/shadow scale, and the
  migration plan for surfaces that still diverge.
- **[docs-site/README.md](./docs-site/README.md)** — quickstart for the
  Docusaurus documentation site.

### Font pipeline (product + docs share faces)

Lexend (UI/prose) and JetBrains Mono (code) are **self-hosted**, not loaded
from Google Fonts — the app's CSP blocks remote stylesheets/fonts. One script
keeps both sites in sync:

```bash
node scripts/fetch-fonts.mjs
```

It downloads the subsets once and writes woff2 files + generated `@font-face`
CSS to both targets, which both serve from `/fonts/`:

| Target | woff2 files | Generated CSS |
|---|---|---|
| App | `public/fonts/` | `src/app/fonts.css` |
| Docs-site | `docs-site/static/fonts/` | `docs-site/src/css/fonts.css` |

No manual regeneration is needed day-to-day: `npm run dev` / `npm run build`
(app) and `npm run build` (docs-site) run the fetcher automatically via npm
`pre*` hooks. The script is cwd-independent and network-resilient — if Google
Fonts is unreachable it keeps the fonts already on disk and exits 0 (force
that with `ORPLEX_FONTS_SKIP_NETWORK=1`). To change which faces ship, edit the
`FONTS` config in the script and restart dev or rebuild.

Because both targets are generated from the same bytes, they must never
diverge — `npm run check:fonts` (root or docs-site) verifies the woff2 file
sets and `fonts.css` are byte-identical across the two sites and exits 1 on
any drift (`node scripts/fetch-fonts.mjs` regenerates both to fix it).

## Security

- All API routes require authentication (except health check)
- CSRF protection via Content-Type validation
- Dynamic CORS origin matching
- Zod input validation on all endpoints
- Rate limiting (30 req/min per user+IP)
- SQL injection prevention via Prisma ORM
- XSS prevention via React auto-escaping
- CSP headers configured

## License

MIT
