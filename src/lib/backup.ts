// backup.ts — FRONTEND STUB.
//
// Physical split: backups are a backend responsibility (the backend owns the
// database and runs the backup cron next to it). The frontend renders the UI
// only, so this module is a no-op that keeps the layout boot block compiling.
// The real implementation lives in backend/src/lib/backup.ts.

export type PgDumpSource = "vendored" | "embedded" | "pgbin-env" | "path" | "missing";

export interface BackupFileInfo {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface BackupRetentionInfo {
  maxStaleHours: number;
  maxTotalBytes: number;
}

export interface BackupStatus {
  configured: boolean;
  cronRunning: boolean;
  lastBackupAt: string | null;
  lastBackupError: string | null;
  lastBackupOutcome: "ok" | "failed" | "unconfigured" | null;
  lastBackupMessage: string | null;
  files: BackupFileInfo[];
  retention: BackupRetentionInfo;
}

export interface PgDumpVendorStatus {
  source: PgDumpSource;
  version: string | null;
  ok: boolean;
  message: string;
}

/** No-op on the frontend: backups run on the backend next to the database. */
export function startBackupCron(): void {}

/** No-op on the frontend. */
export function stopBackupCron(): void {}

export function isBackupConfigured(): boolean {
  return false;
}

export async function getBackupStatus(): Promise<BackupStatus> {
  return {
    configured: false,
    cronRunning: false,
    lastBackupAt: null,
    lastBackupError: null,
    lastBackupOutcome: null,
    lastBackupMessage: null,
    files: [],
    retention: { maxStaleHours: 0, maxTotalBytes: 0 },
  };
}

export async function getVendorStatus(): Promise<PgDumpVendorStatus> {
  return { source: "missing", version: null, ok: false, message: "Backups run on the backend." };
}

export async function runBackup(): Promise<{ path: string; size: number } | null> {
  return null;
}

export async function cleanupOldBackups(): Promise<number> {
  return 0;
}

export async function fullBackupCycle(): Promise<void> {}

export function getBackupRuntime() {
  return {
    cronRunning: false,
    lastBackupAt: null as string | null,
    lastBackupError: null as string | null,
    lastBackupOutcome: null as "ok" | "failed" | "unconfigured" | null,
    lastBackupMessage: null as string | null,
    lastCronTickAt: null as string | null,
  };
}
