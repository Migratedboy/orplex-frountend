---
sidebar_position: 2
---

# Self-Hosting

## Prerequisites

- Docker or Podman
- 2GB RAM minimum
- Domain with HTTPS (for production)

## Quick Deploy

```bash
git clone https://github.com/orplex-tech/orplex-tech.git
cd orplex-tech
podman-compose up -d
```

## Environment Setup

1. Copy `.env.example` to `.env`
2. Set `DATABASE_URL` to your PostgreSQL instance
3. Set `NEXTAUTH_SECRET` to a random string
4. Set `NEXTAUTH_URL` to your domain
5. Add API keys for your preferred AI providers

## Agent Automation Flags

The environment variables below extend what a server-hosted Orplex can do. `ORPLEX_PUSH_BRANCH` and `ORPLEX_MCP_TOKEN` act with the credentials of the server process and are **off by default** — read the blast radius before enabling either. The resource flags (`ORPLEX_MAX_CONCURRENT_RUNS`, `AI_FAILOVER`) are conservative by construction.

| Flag | Default | Grants | Blast radius |
|---|---|---|---|
| `ORPLEX_PUSH_BRANCH` | off | After each server run, push the agent's branch to `origin` and record a PR/compare link | Pushes to your repo's remote |
| `ORPLEX_MCP_TOKEN` | off (unset = gateway fully disabled) | Lets the local MCP proxy spawn runs, read reviews, and merge/discard branches | Another local agent can write to your repo via merge |
| `ORPLEX_MAX_CONCURRENT_RUNS` | `1` | Run up to 3 agent runs at once (values above 3 are clamped) | RAM: see the budget table below |
| `AI_FAILOVER` | off (unset) | Comma list of fallback providers used when the primary is rate-limited | Runs continue on another provider's key after a 429 |

### RAM budget for parallel runs (8 GB-class machines)

Parallel runs are cheap; the verify lane is not. Each verify boot is a real dev server (+0.5–1 GB RSS), so the executor serializes verification **globally** — at most one verify dev server exists no matter how many runs execute. What concurrency actually adds:

| `ORPLEX_MAX_CONCURRENT_RUNS` | Peak extra RAM | Notes |
|---|---|---|
| `1` (default) | — | Historical behavior; always safe |
| `2` | ≈ +0.2–0.4 GB | Second worktree + transcript + MCP children; verify stays serialized |
| `3` | ≈ +0.4–0.8 GB | The ceiling; leave at 1 while a browser + IDE are open |

#### Recommended starting points by machine class

| Machine | `ORPLEX_MAX_CONCURRENT_RUNS` | `ORPLEX_TPM_BUDGET` | Browser verify lane | Notes |
|---|---|---|---|---|
| 8 GB RAM, 4 cores (e.g. i5-8350U laptop) | 2 (or unset to auto-size) | unset (8000) | auto — skipped under pressure | Watchdog pauses claims above 85% RAM; one verify dev server runs at a time globally |
| 16 GB RAM, 6–8 cores | 3 | unset (8000) | auto | Headroom for a browser + IDE alongside runs |
| 32 GB+ / dedicated host | 3 (hard clamp) | provider-specific | auto | Concurrency stops helping when the provider's TPM does — most free tiers are rate-bound, not CPU-bound |

On 8 GB machines, set `ORPLEX_MAX_CONCURRENT_RUNS=1` while a heavy IDE and a browser are open and let the watchdog handle the rest; auto-sizing (`ORPLEX_MAX_CONCURRENT_RUNS` unset) picks 2 for machines with ≤10 GB usable RAM, 3 up to 16 GB, and clamps anything above to 3.

### `AI_FAILOVER` — continue when the primary provider rate-limits

Set a comma list in fallback order, e.g. `AI_FAILOVER=groq,openrouter`. When the configured primary fails with a rate/quota error (retries exhausted, `Retry-After` hints honored), the executor moves down the chain, records a `provider-failover` timeline event, and stamps `result.provider` with the provider that actually served the run. Providers without their key env var set (`NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `AI_API_KEY`) are skipped — a chain entry without a key is a lie. Only the server executor fails over; the interactive chat path always uses the configured provider.

### `ORPLEX_PUSH_BRANCH=1` — push agent branches for review

What happens when enabled: after a server-executed run commits its work to its dedicated `orplex/run-*` branch, the executor runs `git push -u origin <branch>` (60s timeout), then records a review link on the timeline — a real PR via the `gh` CLI if it's installed and authenticated, otherwise the GitHub compare URL (`/compare/<base>...<branch>?expand=1`), which needs no credentials. Look for the `branch-pushed` and `pr-opened` timeline events.

Built-in safety rails (know them, don't rely on them blindly):

- **Only the agent's branch is pushed** — never your checked-out branch, never a force push. Branch names are namespaced `orplex/run-*`, so you can protect `main` and add CI auto-cleanup rules for `orplex/*`.
- **Failure is honest, not fatal.** No remote → the run completes with `pushed: false, "no origin remote"`. A rejected push never fails the run.
- **No tokens are stored or proxied by Orplex.** Pushing uses whatever git credentials the *server process* already has (Git Credential Manager, SSH agent, `gh` auth). Orplex never sees them.

Safe-enablement steps:

1. In the workspace, confirm the remote is the one you intend: `git remote -v`.
2. Make push auth **non-interactive**: `git push --dry-run` must succeed without prompting. The executor runs unattended — an interactive credential prompt hangs the push until timeout.
3. Optional: install the GitHub CLI and `gh auth login` once for real PRs instead of compare links. Skip this if you don't want PR creation — the fallback link appears either way.
4. Set `ORPLEX_PUSH_BRANCH=1` and restart.
5. Verify with a throwaway run before a real one.

Do **not** enable this on a workspace whose `origin` is shared production infrastructure, or on a multi-user host where you can't vouch for the server's git identity. Every push is attributed to that identity, not to the human who spawned the run.

### `ORPLEX_MCP_TOKEN` — the programmatic gateway

Setting this variable turns on `POST /api/mcp`, the gateway used by the local stdio proxy (`scripts/orplex-mcp-server.mjs`) that lets any MCP client — Claude Code in particular — drive Orplex: `spawn_run`, `list_runs`, `get_run_review`, `merge_run`. See [Driving Orplex from Claude Code](./claude-code.md).

Security model, as implemented:

- **Unset means disabled.** The route refuses every request while the variable is absent — the gateway can never be silently open.
- **Constant-time comparison.** Token checks don't leak length/prefix timing, and no endpoint ever returns the token.
- **Single-user attribution.** Runs created through the gateway belong to the local user (first user in the database). There is no per-token identity.
- **`merge_run` is the sharp edge.** It merges the reviewed agent branch into your working repo — guarded by the same dirty-tree refusal and conflict abort as the UI's merge button, but it is still a remote-controlled write. Treat the token as the keys to that.

Safe-enablement steps:

1. Generate a strong value:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Put the **same value** in the server's `.env` and in the proxy registration's `env` block (`ORPLEX_MCP_TOKEN`), then restart both.
3. **Loopback only.** Point the proxy at `http://localhost:5000` and do not route `/api/mcp` through any reverse proxy to the internet. This is a machine-to-machine endpoint for one machine — it has no rate limiting, no per-user scoping, and no audit of callers beyond Orplex's own run records.
4. Scope your clients. Registering the proxy in a project's `.mcp.json` grants that project's agent everything, including `merge_run`. If you only want spawn-and-review today, the merge is still gated by your explicit review of the diff — but the *capability* is gated only by the token. Register deliberately.
5. Rotate on suspicion: change the value, restart the server and proxy. If a token was ever committed to a file, rotate now and `git rm --cached` it.

Compose users: add both variables to the `environment:` block of the app service in your compose file rather than baking them into the image.

## Database Backups

Backups run automatically once a day when the server boots (then every 24h) and can be triggered manually from **Admin → Database Backups**. Output is a PostgreSQL custom-format dump in `backups/`, restored with:

```bash
pg_restore -d "$DATABASE_URL" backups/orplex-backup-<timestamp>.dump
```

`pg_dump` resolution order:

1. `.localpg/pgbin/` — vendored automatically on `npm install` (postinstall) and manually via `npm run db:pgdump` (Windows: downloads the official EnterpriseDB binaries matching the embedded server's major version, extracts only pg_dump, pg_restore, psql + DLLs). Offline installs skip the download with a single warning — set `ORPLEX_PG_DUMP_SKIP_NETWORK=1` to force that path, or `npm run db:pgdump` later when online.
2. the embedded-postgres bundle, when a future version ships `pg_dump`
3. `PG_BIN` — set it to a Postgres `bin/` directory if you have a full install (e.g. `PG_BIN="C:\\Program Files\\PostgreSQL\\16\\bin"`)
4. `PATH`

When nothing resolves, backups are disabled with a **single** log line at boot and the admin card shows the same setup hint — no crash spam. On Linux, `apt install postgresql-client` (or your distro equivalent) covers step 4.

#### Retention telemetry

The admin Backups card and `GET /api/admin/health` warn when retention slips:

- **Stale** — newest backup older than `ORPLEX_BACKUP_MAX_STALE_HOURS` (default 25 — the cron ticks every 24h, so a 25h-old dump means a missed cycle).
- **Oversized** — `backups/` total exceeds `ORPLEX_BACKUP_MAX_TOTAL_MB` (default: uncapped).

Warnings render on the admin card, appear as `retention:` warns in the System-page runtime log once per backup cycle, and ride along in the health endpoint under `dbBackups.retention`. Junk values in either env var fall back to the defaults, so a typo can't disable the telemetry.

### Restore drill — prove backups are restorable

A backup that has never been restored is a hope, not a backup. The drill recreates a throwaway `orplex_restore_drill` database, `pg_restore`s the newest dump into it, compares per-table row counts against live (post-backup writes are reported as drift, not failure), then drops the throwaway:

```bash
npm run db:restore-drill
DRILL_DUMP=backups/orplex-backup-<timestamp>.dump npm run db:restore-drill  # specific file
DRILL_KEEP=1 npm run db:restore-drill                                       # keep the drill DB for inspection
```

Exit 0 = restorable; exit 1 = restore failed or a dumped table came back missing. Run it after your first backup and after any schema migration.

### One-endpoint ops picture: `GET /api/admin/health`

Admin-authenticated. Alongside provider health and key-pool state, the `dbBackups` section rolls up the whole backup stack:

```jsonc
{
  "dbBackups": {
    "healthy": true,               // pg_dump resolvable AND DATABASE_URL set
    "pgDump": { "available": true, "source": "vendored" },
    "cron": {
      "running": true,             // daily cron loop alive in this process
      "lastTickAt": "…",           // proves the loop ticks even without a new file
      "lastBackupAt": "…",
      "lastBackupOutcome": "ok",   // ok | failed | unconfigured
      "lastBackupMessage": "orplex-backup-…dump (2.4 MB)",
      "lastBackupError": null
    },
    "lastBackup": { "filename": "…", "sizeBytes": 2500000, "createdAt": "…" },
    "backupCount": 9,
    "totalSizeBytes": 12345678,
    "vendorScript": {              // what `npm run db:pgdump` / postinstall last did
      "present": true,
      "status": "vendored",        // vendored | skipped | not-applicable | failed | unknown
      "pgDumpVersion": "pg_dump (PostgreSQL) 18.0",
      "fetchedAt": "…",
      "message": "…"
    }
  }
}
```

The vendor script runs **outside** the server process (postinstall / CLI), so its outcome is bridged via `.localpg/pg-dump-status.json` and surfaced here — a fresh offline checkout reports `vendorScript.status: "skipped"` with `pgDump.available: false`, telling you exactly one `npm run db:pgdump` away from working backups.

## Resource safety: watchdog, janitor, crash recovery

The server executor runs unattended on machines that also run your IDE, browser and OS updates. Three layers keep it from being the process that tips the machine over.

### Memory watchdog

A 10-second in-process watchdog samples system memory and walks a ladder with hysteresis (an episode must *sustain* before actions fire, and recovery must be sustained before claiming resumes):

| Level | Trigger (used RAM) | Action |
|---|---|---|
| elevated | ≥ 70% | none — recorded, first warning |
| high | ≥ 85% | **run claiming pauses**, browser verify lanes are skipped; runs already in flight finish |
| critical | ≥ 92% sustained (3 consecutive samples) | critical actions fire: a janitor sweep and an in-process lane kill; claiming stays paused until recovery |

Current state (level, paused?, last action, RSS/heap) is on **Admin → System → Memory Pressure** and in `GET /api/admin/system` under `hardware`. On an 8 GB machine with a browser open, expect `high` during builds — that is the ladder working, not a fault: claims resume automatically when memory recovers.

### Memory janitor

The janitor reclaims *cache* disk only — it deletes from a whitelist and never from anything else:

- **Whitelist:** `.next/cache`, `node_modules/.cache`, docs-site build artifacts, temp worktree scratch dirs older than 24 h, and log files over 25 MB (truncated, not deleted).
- **Protected denylist (never swept even if nested in a cache dir):** `backups/`, `.git/`, `.env*`, `.localpg/`, `prisma/`, `src/`, `public/`, `electron/`, `scripts/`, `.orplex*` workspaces and more — `src` inside `node_modules/.cache/foo/src` is still refused.
- `.next/dev` (Turbopack's live dev database) is **not** on the whitelist — see crash recovery below for why.

Sweeps run automatically on critical pressure (`ORPLEX_JANITOR=1` also enables a light sweep at boot) and manually from **Admin → System → Memory Janitor** (both buttons hit `POST /api/admin/janitor`, mode `full` or `critical`). A full sweep sizes candidates before deleting and returns `{ candidates, deleted, bytesFreed, skipped }`; under critical pressure it skips sizing to act fast. The `.orplex/` directory is protected — put anything you care about under it.

### Crash safety — `.next/dev` and `npm run clean`

`.next/dev` is Turbopack's live task database, written *during* dev-server startup. Deleting it while the server runs (or during boot) crashes the server with missing-module errors — which is exactly why the janitor must never touch it, and why the only safe removal is out-of-process while the server is stopped:

```bash
# stop the dev server first, then:
npm run clean
```

`npm run clean` refuses to run while something listens on :5000 (override with `npm run clean -- --force`), deletes `.next/dev` and `.next/cache` with retry/backoff for Windows handle-lag (locked `lock`/chunk files right after a server exit), and reports anything it had to skip — Next regenerates all of it on the next boot. Recover from a crashed or corrupt dev server with: stop the server → `npm run clean` → start again.

If the *embedded Postgres* dies instead, the watchdog is irrelevant: restart it with `node scripts/local-db.mjs start` and confirm `npm run db:restore-drill` still exits 0 on the newest dump.

## Production Checklist

- [ ] Set strong `NEXTAUTH_SECRET`
- [ ] Configure `ALLOWED_ORIGINS`
- [ ] Enable HTTPS
- [ ] Decide on `ORPLEX_PUSH_BRANCH` / `ORPLEX_MCP_TOKEN` (see above) — leave both off unless you need them
- [ ] Leave `ORPLEX_MAX_CONCURRENT_RUNS` at 1 unless you know the machine's headroom
- [ ] Keep `/api/mcp` off any public route
- [ ] Set up automated backups (`npm run db:pgdump` on Windows, or install `postgresql-client` / set `PG_BIN`)
- [ ] Configure monitoring
- [ ] Set resource limits in compose file

## Scaling

- Use connection pooling (PgBouncer)
- Add Redis for caching
- Use a reverse proxy (nginx/Caddy)
- Enable horizontal pod autoscaling
