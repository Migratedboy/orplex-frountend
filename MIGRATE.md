# Orplex DB — Cloud Migration Guide

## 1. Where data lives today (hybrid)

| Owner | Models | Store |
|---|---|---|
| **Cloud** (Postgres / Supabase via `DATABASE_URL`) | `user`, `account`, `session`, `verificationToken`, `learning` (playbook) | `src/lib/prisma.ts` → cloud-first, local fallback |
| **Local** (JSON facade, no server) | everything else — conversations, messages, keys, runs, events, quota, MCP, telemetry, memory files | `.orplex/db/<model>.json` via `src/lib/local-db.ts` |
| **Local plain-JSON** (blob stores) | `playbook.json` (`.orplex/playbook.json`), `workspaceMemory` (`.orplex/workspace-memory.json`) | atomic tmp+rename, read-through cache |

Ownership sets are defined once in `src/lib/local-db.ts` (`CLOUD_OWNED_MODELS`, `LOCAL_OWNED_MODELS`) and shared with `prisma.ts` — one owner per model, no doubling. When the cloud is healthy, local duplicates of cloud-owned models are auto-pruned (`pruneCloudDuplicates`).

### Local DB hardening (always-on)
- Dir `.orplex/db/` is guaranteed at startup (`ensureLocalDbDir()`); the engine is a file store, not a localhost server — no connection can fail.
- Every flush keeps a `.bak` last-good copy. A corrupt file restores from `.bak` (logged loudly) instead of serving empty.
- Telemetry collections are capped (oldest evicted); user data (chats/messages) is never capped.
- `verifyLocalDb()` — per-model integrity scan for health checks.
- `exportSnapshot()` / `importSnapshot(path)` — one portable JSON bundle (SHA-256 per model) for device-to-device moves or cold backup.

## 2. Moving to full cloud

```bash
# 1. Set DATABASE_URL in .env.local (Supabase pooler, port 6543)
# 2. Ensure schema is on the cloud
npx prisma db push

# 3. Preview what would move (writes nothing)
node scripts/migrate-to-cloud.js --dry-run

# 4. Real migration — idempotent, parents-first, corrupt-skipping
node scripts/migrate-to-cloud.js
```

The script (`scripts/migrate-to-cloud.js`):
- Reads every `.orplex/db/<model>.json`, revives ISO dates, and `createMany({ skipDuplicates: true })` into the matching Prisma model — ids preserved, re-runs are no-ops.
- Migrates parents before children (user → workspace → conversation → agentRun → …) so Postgres FK checks pass.
- Skips corrupt/absent files with a loud warning; **local files are never touched** — cut-over stays a separate, reversible step.

### Cut-over options
- **Keep hybrid** (recommended today): after migration, identity+playbook stay cloud-first; everything else keeps working from local. No code change needed — `prisma.ts` already routes cloud-owned models to the cloud.
- **Full cloud**: repoint the hybrid router (all models → cloud) or set `ORPLEX_LOCAL_DB_DIR` aside — reversible by restoring local files, since migration never altered them.

### Workspace memory special case
`workspaceMemory` lives in `.orplex/workspace-memory.json`, outside the facade. Export it with `exportSnapshot()` from `local-db.ts` (checksum-validated bundle; `importSnapshot()` restores it atomically).

## 3. Rollback
Local files are untouched by migration. To roll back: remove/point `DATABASE_URL` away — the app immediately falls back to the local facade (cloud-owned models included). Nothing to rebuild.
