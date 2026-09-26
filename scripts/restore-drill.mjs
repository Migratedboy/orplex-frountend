// restore-drill.mjs — Prove that backups are actually restorable.
//
// A backup that has never been restored is a hope, not a backup. This drill:
//   1. picks the newest orplex-backup-*.dump from backups/ (or DRILL_DUMP=<path>)
//   2. drops + recreates a throwaway database orplex_restore_drill
//   3. restores the dump into it with pg_restore
//   4. compares per-table row counts between the drill DB and the live DB
//   5. drops the throwaway DB — on success AND failure (skip with DRILL_KEEP=1)
//
// Snapshot semantics: the dump is a point-in-time copy, so rows written to the
// LIVE database after the backup was taken legitimately make live counts
// higher. Per-table status:
//     match   — equal row counts
//     grew    — live > drill (expected drift after the backup moment)
//     SHRUNK  — live < drill → rows were deleted from live after the backup
//               (e.g. a removed conversation). Reported per table so the
//               operator knows counts won't be exact; NOT a restore failure.
// Hard failures (exit 1): restore itself fails, or a table present in the
// dump is missing after restore.
//
// Usage:
//     npm run db:restore-drill
//     DRILL_DUMP=backups/orplex-backup-<timestamp>.dump npm run db:restore-drill
//     DRILL_KEEP=1 npm run db:restore-drill   # keep the drill DB for inspection
// Requires DATABASE_URL (in .env or environment) and the vendored client
// binaries (.localpg/pgbin/). Connection params are never logged.
import { readdir, stat, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PGBIN = join(ROOT, ".localpg", "pgbin");
const BACKUP_DIR = join(ROOT, "backups");
const DRILL_DB = "orplex_restore_drill";

// Per-table verification set: the app's core tables (snake_case, as Prisma
// maps them). Not exhaustive — covers the tables whose loss would hurt most.
const TABLES_TO_CHECK = [
  "users",
  "agent_runs",
  "run_events",
  "approval_requests",
  "agent_artifacts",
  "pipeline_steps",
  "conversations",
  "messages",
  "tasks",
  "user_api_keys",
  "usage_logs",
  "workspaces",
];

const keep = process.env.DRILL_KEEP === "1";

function info(msg) {
  console.log(`[restore-drill] ${msg}`);
}

// Minimal .env loader (scripts run under bare node — Next.js isn't here to
// load it). Never overrides variables already set in the real environment.
async function loadDotEnv() {
  try {
    const raw = await readFile(join(ROOT, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  } catch {
    // no .env — rely on the real environment
  }
}

/** Run a postgres client binary; throws with a redacted message on failure. */
function run(bin, args, opts = {}) {
  const res = spawnSync(join(PGBIN, bin), args, {
    windowsHide: true,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
  });
  if (res.error) throw new Error(`${bin} failed to launch: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = (res.stderr || "").trim().replace(/postgresql:\/\/\S+/g, "postgresql://***");
    throw new Error(`${bin} exited ${res.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`);
  }
  return (res.stdout || "").toString();
}

/** psql -tAc helper returning trimmed first-column rows. */
function psqlRows(db, sql) {
  return run("psql.exe", ["-tA", "-c", sql, db])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function dropDrill(adminDb) {
  try {
    run("psql.exe", ["-tA", "-c", `DROP DATABASE IF EXISTS ${DRILL_DB};`, adminDb], { timeoutMs: 30_000 });
  } catch (err) {
    info(`warning: could not drop ${DRILL_DB} (${err.message}) — it will be recreated on the next run.`);
  }
}

async function newestDump() {
  const forced = process.env.DRILL_DUMP;
  if (forced) {
    const st = await stat(forced).catch(() => null);
    if (!st) throw new Error(`DRILL_DUMP=${forced} does not exist`);
    return forced;
  }
  const files = (await readdir(BACKUP_DIR))
    .filter((f) => f.startsWith("orplex-backup-") && f.endsWith(".dump"))
    .sort()
    .reverse();
  if (files.length === 0) {
    throw new Error(
      "no orplex-backup-*.dump files in backups/ — trigger a backup first (boot with the server running, or POST /api/admin/backups).",
    );
  }
  return join(BACKUP_DIR, files[0]);
}

async function main() {
  await loadDotEnv();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set (in .env or environment) — point it at the live database to compare against.");

  const adminDb = dbUrl.substring(0, dbUrl.lastIndexOf("/") + 1) + "postgres";
  const drillUrl = dbUrl.substring(0, dbUrl.lastIndexOf("/") + 1) + DRILL_DB;
  const dumpPath = await newestDump();
  const dumpStat = await stat(dumpPath);
  info(`drill target: ${dumpPath.split(/[\\/]/).pop()} (${(dumpStat.size / 1024).toFixed(0)} KB)`);

  let drillCreated = false;
  const missingTables = [];
  let matched = 0;
  let grew = 0;
  let shrunk = 0;

  try {
    // 1. Drop + recreate the throwaway database.
    info(`recreating throwaway database ${DRILL_DB}...`);
    dropDrill(adminDb);
    run("psql.exe", ["-tA", "-c", `CREATE DATABASE ${DRILL_DB};`, adminDb], { timeoutMs: 30_000 });
    drillCreated = true;

    // 2. Restore the dump into it.
    const t0 = Date.now();
    run("pg_restore.exe", [
      "-d", drillUrl,
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      dumpPath,
    ]);
    info(`restore completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // 3. Per-table row counts: drill DB vs live DB. Always pass full URLs —
    //    bare DB names make libpq fall back to localhost:5432 defaults.
    info("per-table verification:");
    for (const table of TABLES_TO_CHECK) {
      // psql -tA prints booleans as t/f.
      const existsInDrill = psqlRows(drillUrl, `SELECT to_regclass('"${table}"') IS NOT NULL;`)[0] === "t";
      if (!existsInDrill) {
        missingTables.push(table);
        console.log(`  ${table}: MISSING after restore`);
        continue;
      }
      const drillCount = Number(psqlRows(drillUrl, `SELECT count(*) FROM "${table}";`)[0] || 0);
      const existsInLive = psqlRows(dbUrl, `SELECT to_regclass('"${table}"') IS NOT NULL;`)[0] === "t";
      const liveCount = existsInLive ? Number(psqlRows(dbUrl, `SELECT count(*) FROM "${table}";`)[0] || 0) : 0;
      let status;
      if (drillCount === liveCount) {
        status = "match";
        matched++;
      } else if (liveCount > drillCount) {
        status = "grew";
        grew++;
      } else {
        status = "SHRUNK";
        shrunk++;
      }
      console.log(`  ${table}: drill ${drillCount} vs live ${liveCount} — ${status}`);
    }
  } finally {
    // 4. Cleanup — runs on success AND failure.
    if (drillCreated && !keep) {
      info(`dropping ${DRILL_DB}...`);
      dropDrill(adminDb);
    } else if (keep && drillCreated) {
      info(`DRILL_KEEP=1 — left ${DRILL_DB} in place for inspection.`);
    }
  }

  // 5. Verdict.
  if (missingTables.length > 0) {
    throw new Error(`${missingTables.length} table(s) present in dump but missing after restore: ${missingTables.join(", ")}`);
  }
  if (shrunk > 0) {
    info(`summary: ${matched} match, ${grew} grew (post-backup writes), ${shrunk} SHRUNK (rows deleted from live after the backup)`);
  } else {
    info(`summary: ${matched} match, ${grew} grew (post-backup writes) — restore is sound.`);
  }
  console.log("[restore-drill] ✓ PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error(`[restore-drill] ✗ ${err?.message || err}`);
  process.exit(1);
});
