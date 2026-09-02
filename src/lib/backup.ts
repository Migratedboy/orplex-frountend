// backup.ts — Automated database backup with rotation
//
// Backups are stored in ./backups/ with timestamps.
// Keeps the last N backups (default: 7 daily, 4 weekly).
//
// Usage:
//   import { runBackup, startBackupCron } from "./backup";
//   await runBackup();           // One-time backup
//   startBackupCron();           // Schedule daily backups

import { exec } from "child_process";
import { promisify } from "util";
import { readdir, unlink, stat, mkdir } from "fs/promises";
import { join } from "path";

const execAsync = promisify(exec);

const BACKUP_DIR = join(process.cwd(), "backups");
const MAX_DAILY_BACKUPS = 7;
const MAX_WEEKLY_BACKUPS = 4;

/**
 * Run a database backup using pg_dump.
 * Requires DATABASE_URL to be set and pg_dump to be available.
 */
export async function runBackup(): Promise<{ path: string; size: number } | null> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[backup] DATABASE_URL not set — skipping backup.");
    return null;
  }

  try {
    // Ensure backup directory exists
    await mkdir(BACKUP_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `orplex-backup-${timestamp}.sql.gz`;
    const filepath = join(BACKUP_DIR, filename);

    console.log(`[backup] Starting backup to ${filename}...`);

    // pg_dump with compression
    const { stderr } = await execAsync(
      `pg_dump "${dbUrl}" | gzip > "${filepath}"`,
      { timeout: 300_000 } // 5 minutes max
    );

    if (stderr && !stderr.includes("NOTICE")) {
      console.error("[backup] pg_dump warnings:", stderr);
    }

    const fileStat = await stat(filepath);
    const sizeMB = (fileStat.size / 1024 / 1024).toFixed(1);

    console.log(`[backup] Backup complete: ${filename} (${sizeMB} MB)`);
    return { path: filepath, size: fileStat.size };
  } catch (err) {
    console.error("[backup] Backup failed:", err);
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
      .filter((f) => f.startsWith("orplex-backup-") && f.endsWith(".sql.gz"))
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
}

let backupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start daily backup cron.
 * Runs once at startup, then every 24 hours.
 */
export function startBackupCron(intervalMs = 24 * 60 * 60 * 1000): void {
  if (backupInterval) return;

  // Run once immediately
  fullBackupCycle().catch(() => {});

  // Then on interval
  backupInterval = setInterval(() => {
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
}
