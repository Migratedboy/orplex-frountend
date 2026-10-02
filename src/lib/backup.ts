// backup.ts — Automated database backup with rotation
//
// Backups are stored in ./backups/ with timestamps.
// Keeps the last N backups (default: 7 daily, 4 weekly).
//
// Windows note: this used to shell out to `pg_dump ... | gzip`, which fails
// on Windows (cmd.exe has no `gzip` and no sh-pipe semantics). It now spawns
// pg_dump directly with `--file` and PG's built-in gzip compression, resolving
// the binary in this order:
//   1. .localpg/pgbin/  — vendored by `npm run db:pgdump` (fetch-pgdump.mjs)
//   2. embedded-postgres bundle (if a future version ships pg_dump)
//   3. PG_BIN env dir   — self-hosters with a real Postgres install
//   4. PATH
// Output files are PostgreSQL custom-format dumps (`.dump`), restorable with
// `pg_restore -d <url> <file>` — not raw SQL despite the historical name.
//
// Usage:
//   import { runBackup, startBackupCron, getBackupStatus } from "./backup";
//   await runBackup();           // One-time backup
//   startBackupCron();           // Schedule daily backups
//   getBackupStatus();           // Admin UI: availability + last backup

import { spawn, spawnSync } from "child_process";
import { readdir, unlink, stat, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { recordRuntimeLog } from "@/lib/runtime-log";
import { runtimeState } from "@/lib/runtime-state";

const BACKUP_DIR = join(process.cwd(), "backups");
const MAX_DAILY_BACKUPS = 7;
const MAX_WEEKLY_BACKUPS = 4;

// Retention telemetry: how stale / how large backups may get before the admin
// UI warns. Staleness default is 25h — the daily cron ticks every 24h, so the
// newest dump older than that means a missed cycle (crash, DB down at boot).
const DEFAULT_MAX_STALE_HOURS = 25;

/**
 * ORPLEX_BACKUP_MAX_STALE_HOURS (default 25) and ORPLEX_BACKUP_MAX_TOTAL_MB
 * (default: no cap). Junk/zero/negative values fall back to the defaults so a
 * typo can never disable the telemetry entirely.
 */
export function backupRetentionConfig(env: NodeJS.ProcessEnv = process.env): { maxStaleHours: number; maxTotalBytes: number } {
  const hours = Number.parseFloat(env.ORPLEX_BACKUP_MAX_STALE_HOURS ?? "");
  const mb = Number.parseFloat(env.ORPLEX_BACKUP_MAX_TOTAL_MB ?? "");
  return {
    maxStaleHours: Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MAX_STALE_HOURS,
    maxTotalBytes: Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 0,
  };
}

export interface RetentionWarning {
  kind: "stale" | "size";
  message: string;
}

/**
 * Pure retention evaluation for the admin card / health endpoint. No backups
 * at all (lastBackupAt null) produces no warnings — "No backups yet" is its
 * own visible state, not a staleness violation.
 */
export function evaluateBackupRetention(input: {
  lastBackupAt: string | null;
  totalSizeBytes: number;
  now?: Date;
  config?: { maxStaleHours: number; maxTotalBytes: number };
}): RetentionWarning[] {
  const config = input.config ?? backupRetentionConfig();
  const warnings: RetentionWarning[] = [];
  if (input.lastBackupAt) {
    const ageH = (input.now?.getTime() ?? Date.now()) - new Date(input.lastBackupAt).getTime();
    const ageHours = ageH / 3_600_000;
    if (ageHours > config.maxStaleHours) {
      warnings.push({
        kind: "stale",
        message: `Newest backup is ${ageHours.toFixed(1)}h old (limit ${config.maxStaleHours}h) — the daily cron may be down or failing.`,
      });
    }
  }
  if (config.maxTotalBytes > 0 && input.totalSizeBytes > config.maxTotalBytes) {
    warnings.push({
      kind: "size",
      message: `Backups total ${(input.totalSizeBytes / 1024 / 1024).toFixed(0)} MB (cap ${Math.round(config.maxTotalBytes / 1024 / 1024)} MB) — tighten retention or raise ORPLEX_BACKUP_MAX_TOTAL_MB.`,
    });
  }
  return warnings;
}

/** Locally bundled pg_dump (embedded-postgres ships pg_ctl but not pg_dump). */
const EMBEDDED_PG_DUMP = join(
  process.cwd(),
  "node_modules",
  "@embedded-postgres",
  `${process.platform}-x64`,
  "native",
  "bin",
  `pg_dump${process.platform === "win32" ? ".exe" : ""}`,
);

/** Vendored by scripts/fetch-pgdump.mjs (`npm run db:pgdump`). */
const VENDORED_PG_DUMP = join(process.cwd(), ".localpg", "pgbin", `pg_dump${process.platform === "win32" ? ".exe" : ""}`);

export type PgDumpSource = "vendored" | "embedded" | "pgbin-env" | "path" | "missing";

function resolvePgDump(): { cmd: string; source: PgDumpSource } | null {
  if (existsSync(VENDORED_PG_DUMP)) return { cmd: VENDORED_PG_DUMP, source: "vendored" };
  if (existsSync(EMBEDDED_PG_DUMP)) return { cmd: EMBEDDED_PG_DUMP, source: "embedded" };
  const pgBin = process.env.PG_BIN;
  if (pgBin) {
    const candidate = join(pgBin, `pg_dump${process.platform === "win32" ? ".exe" : ""}`);
    if (existsSync(candidate)) return { cmd: candidate, source: "pgbin-env" };
  }
  // Bare "pg_dump" from PATH: probe availability once per process so machines
  // without the binary get a single warning, not an error at every attempt.
  if (pathProbeDone) {
    return pathProbeAvailable ? { cmd: "pg_dump", source: "path" } : null;
  }
  pathProbeDone = true;
  try {
    const probe = spawnSync("pg_dump", ["--version"], { stdio: "ignore", windowsHide: true });
    pathProbeAvailable = !probe.error && probe.status === 0;
  } catch {
    pathProbeAvailable = false;
  }
  if (!pathProbeAvailable) {
    recordRuntimeLog("backup", "warn", "pg_dump not found (vendored / embedded / PG_BIN / PATH) — backups disabled");
  }
  return pathProbeAvailable ? { cmd: "pg_dump", source: "path" } : null;
}

let pathProbeDone = false;
let pathProbeAvailable = false;

/**
 * Cheap availability check for the admin UI — no process spawn unless only
 * the PATH candidate remains (cached after the first probe).
 */
export function isBackupConfigured(): boolean {
  return resolvePgDump() !== null;
}

export interface BackupFileInfo {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BackupRetentionInfo {
  maxStaleHours: number;
  /** 0 = uncapped. */
  maxTotalMB: number;
  warnings: RetentionWarning[];
}

export interface BackupStatus {
  pgDump: { available: boolean; source: PgDumpSource };
  databaseConfigured: boolean;
  backupDir: string;
  lastBackup: BackupFileInfo | null;
  backupCount: number;
  totalSizeBytes: number;
  retention: BackupRetentionInfo;
}

/** Snapshot for the admin Backups card. Never throws. */
export async function getBackupStatus(): Promise<BackupStatus> {
  const pgDump = resolvePgDump();
  let files: BackupFileInfo[] = [];
  try {
    const names = (await readdir(BACKUP_DIR))
      .filter((f) => f.startsWith("orplex-backup-") && f.endsWith(".dump"))
      .sort()
      .reverse(); // Newest first
    files = await Promise.all(
      names.map(async (f): Promise<BackupFileInfo> => {
        const st = await stat(join(BACKUP_DIR, f));
        return { filename: f, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
      }),
    );
  } catch {
    files = [];
  }
  return {
    pgDump: { available: pgDump !== null, source: pgDump?.source ?? "missing" },
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    backupDir: "backups/",
    lastBackup: files[0] ?? null,
    backupCount: files.length,
    totalSizeBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
    retention: buildRetentionInfo(files[0] ?? null, files.reduce((sum, f) => sum + f.sizeBytes, 0)),
  };
}

function buildRetentionInfo(lastBackup: BackupFileInfo | null, totalSizeBytes: number): BackupRetentionInfo {
  const config = backupRetentionConfig();
  return {
    maxStaleHours: config.maxStaleHours,
    maxTotalMB: config.maxTotalBytes > 0 ? Math.round(config.maxTotalBytes / 1024 / 1024) : 0,
    warnings: evaluateBackupRetention({ lastBackupAt: lastBackup?.createdAt ?? null, totalSizeBytes, config }),
  };
}

let warnedNoPgDump = false;

/** Record the outcome of a backup attempt for /api/admin/health (shared cross-bundle state). */
function recordBackupOutcome(outcome: "ok" | "failed" | "unconfigured", message: string): void {
  runtimeState.backup.lastBackupOutcome = outcome;
  runtimeState.backup.lastBackupMessage = message.slice(0, 300);
}

/** Last backup outcome for the admin System page (shared cross-bundle state). */
export function getBackupRuntime() {
  return { ...runtimeState.backup };
}

/** Status file written by scripts/fetch-pgdump.mjs — lives OUTSIDE .localpg/pgbin so it survives partial-vendor cleanup. */
const VENDOR_STATUS_FILE = join(process.cwd(), ".localpg", "pg-dump-status.json");

export interface PgDumpVendorStatus {
  /** Whether the vendoring script ever reported (i.e. the status file exists). */
  present: boolean;
  status: "vendored" | "skipped" | "not-applicable" | "failed" | "unknown";
  pgDumpVersion: string | null;
  fetchedAt: string | null;
  message: string | null;
}

/**
 * What `scripts/fetch-pgdump.mjs` (postinstall / npm run db:pgdump) last did.
 * Read from disk because the script runs OUT of the server process. Never throws.
 */
export async function getVendorStatus(): Promise<PgDumpVendorStatus> {
  let raw: string;
  try {
    raw = await readFile(VENDOR_STATUS_FILE, "utf8");
  } catch {
    return { present: false, status: "unknown", pgDumpVersion: null, fetchedAt: null, message: null };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PgDumpVendorStatus>;
    return {
      present: true,
      status: parsed.status ?? "unknown",
      pgDumpVersion: parsed.pgDumpVersion ?? null,
      fetchedAt: parsed.fetchedAt ?? null,
      message: parsed.message ?? null,
    };
  } catch {
    return {
      present: true,
      status: "unknown",
      pgDumpVersion: null,
      fetchedAt: null,
      message: "vendor status file exists but is not valid JSON",
    };
  }
}

/**
 * Run a database backup using pg_dump (native gzip compression, no shell).
 * Requires DATABASE_URL to be set and pg_dump to be available.
 */
export async function runBackup(): Promise<{ path: string; size: number } | null> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[backup] DATABASE_URL not set — skipping backup.");
    recordBackupOutcome("unconfigured", "DATABASE_URL not set");
    return null;
  }

  const pgDump = resolvePgDump();
  if (!pgDump) {
    if (!warnedNoPgDump) {
      warnedNoPgDump = true;
      console.warn("[backup] pg_dump not found (embedded-postgres bundle / PG_BIN / PATH) — backups disabled.");
    }
    recordBackupOutcome("unconfigured", "pg_dump not found — run npm run db:pgdump");
    return null;
  }
  recordRuntimeLog("backup", "info", `backup started (${pgDump.source})`);

  await mkdir(BACKUP_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `orplex-backup-${timestamp}.dump`;
  const filepath = join(BACKUP_DIR, filename);

  console.log(`[backup] Starting backup to ${filename}...`);

  // Split credentials out of the URL: a password on the pg_dump command line
  // is visible to other local users via the process list. PGPASSWORD (env)
  // is libpq's native channel and never appears in argv. --no-password stays:
  // it means "never prompt interactively", which is still what we want.
  let connectUrl = dbUrl;
  let pgPassword: string | undefined;
  try {
    const u = new URL(dbUrl);
    if (u.password) {
      pgPassword = decodeURIComponent(u.password);
      u.password = "";
      connectUrl = u.toString();
    }
  } catch {
    // Non-URL connection string (key=value form) — pass through unchanged.
  }

  try {
    await new Promise<void>((resolve, reject) => {
      // spawn (no shell) — arguments with spaces/URL params survive verbatim.
      const child = spawn(
        pgDump.cmd,
        ["--file", filepath, "--format=custom", "--compress=gzip:6", "--no-password", connectUrl],
        {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
          ...(pgPassword ? { env: { ...process.env, PGPASSWORD: pgPassword } } : {}),
        },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pg_dump exited ${code}${stderr ? `: ${stderr.trim().slice(0, 400)}` : ""}`));
      });
    });

    const fileStat = await stat(filepath);
    const sizeMB = (fileStat.size / 1024 / 1024).toFixed(1);
    runtimeState.backup.lastBackupAt = new Date().toISOString();
    runtimeState.backup.lastBackupError = null;
    recordBackupOutcome("ok", `${filename} (${sizeMB} MB)`);
    recordRuntimeLog("backup", "info", `backup complete: ${filename} (${sizeMB} MB)`);
    console.log(`[backup] Backup complete: ${filename} (${sizeMB} MB)`);
    return { path: filepath, size: fileStat.size };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runtimeState.backup.lastBackupError = msg.slice(0, 300);
    recordBackupOutcome("failed", msg);
    // Best-effort: remove the likely-partial output so rotation never sees it.
    await unlink(filepath).catch(() => {});
    recordRuntimeLog("backup", "error", `backup failed: ${msg.slice(0, 200)}`);
    console.error("[backup] Backup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Remove old backups beyond the retention limit.
 * Keeps the newest MAX_DAILY_BACKUPS daily and MAX_WEEKLY_BACKUPS weekly.
 */
export async function cleanupOldBackups(): Promise<number> {
  try {
    const files = (await readdir(BACKUP_DIR))
      .filter((f) => f.startsWith("orplex-backup-") && f.endsWith(".dump"))
      .sort()
      .reverse(); // Newest first

    // Keep all weekly backups (every 7th file)
    const weeklyKeep = new Set(
      files.filter((_, i) => i % 7 === 0).slice(0, MAX_WEEKLY_BACKUPS)
    );

    // Keep the most recent daily backups
    const dailyKeep = new Set(files.slice(0, MAX_DAILY_BACKUPS));

    // Delete everything else
    let deleted = 0;
    for (const file of files) {
      if (dailyKeep.has(file) || weeklyKeep.has(file)) continue;
      try {
        await unlink(join(BACKUP_DIR, file));
        deleted++;
      } catch {
        // Ignore — file might be in use
      }
    }

    if (deleted > 0) {
      console.log(`[backup] Cleaned up ${deleted} old backup(s).`);
    }
    return deleted;
  } catch {
    return 0;
  }
}

/**
 * Run a full backup cycle: backup + cleanup.
 */
export async function fullBackupCycle(): Promise<void> {
  const result = await runBackup();
  if (result) {
    await cleanupOldBackups();
  }
  // Retention telemetry: surface stale/oversized state as a warn in the
  // runtime log once per cycle (24h cadence — not spammy) so the System
  // page's log and the admin card agree.
  try {
    const status = await getBackupStatus();
    for (const w of status.retention.warnings) {
      recordRuntimeLog("backup", "warn", `retention: ${w.message}`);
      console.warn(`[backup] retention warning: ${w.message}`);
    }
  } catch {
    // Telemetry must never break the backup cycle.
  }
}

let backupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start daily backup cron.
 * Runs once at startup, then every 24 hours.
 */
export function startBackupCron(intervalMs = 24 * 60 * 60 * 1000): void {
  if (backupInterval) return;

  runtimeState.backup.cronRunning = true;
  runtimeState.backup.lastCronTickAt = new Date().toISOString();

  // Run once immediately
  fullBackupCycle().catch(() => {});

  // Then on interval
  backupInterval = setInterval(() => {
    runtimeState.backup.lastCronTickAt = new Date().toISOString();
    fullBackupCycle().catch(() => {});
  }, intervalMs);

  // Don't keep the process alive just for backups
  if (backupInterval.unref) backupInterval.unref();

  console.log(`[backup] Daily backup cron started (interval: ${intervalMs / 3600_000}h)`);
}

export function stopBackupCron(): void {
  if (backupInterval) {
    clearInterval(backupInterval);
    backupInterval = null;
  }
  runtimeState.backup.cronRunning = false;
}
