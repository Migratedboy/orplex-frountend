// updater.ts — In-app updates for the packaged desktop app (Freebuff-style).
//
// Flow (all user-consented, never forced):
//   boot (packaged only, 30s delay) → check → "available vX" toast
//   → user clicks Download → progress toast w/ Cancel → downloaded
//   → user clicks Restart → quitAndInstall.
// Renderer talks to this module through 4 IPC handlers (registered by
// registerUpdaterIpc) and receives "orplex:update-status" events.
// Dev/unpackaged runs are no-ops (electron-updater needs published metadata).

import { app, BrowserWindow, ipcMain } from "electron";

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  notes?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  error?: string;
}

type WindowGetter = () => BrowserWindow | null;

/** Minimal semver gt (major.minor.patch numeric). Local copy: electron/ can't import src/. */
function isNewerThan(candidate: string, current: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.trim().replace(/^v/i, "").split(/[+-]/)[0].split(".").map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    });
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [a, b, c] = parse(candidate);
  const [x, y, z] = parse(current);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c > z;
}

let initialized = false;
let cancelRequested = false;
let pendingVersion: string | undefined;

function sendStatus(getWindow: WindowGetter, status: UpdateStatus): void {
  try {
    getWindow()?.webContents.send("orplex:update-status", status);
  } catch {
    /* window gone — drop the event */
  }
}

async function updater() {
  return (await import("electron-updater")).autoUpdater;
}

/** Check now (manual from menu/Settings, or the boot/interval schedule). */
export async function checkForUpdates(getWindow: WindowGetter): Promise<UpdateStatus> {
  if (!app.isPackaged) return { state: "idle" };
  try {
    sendStatus(getWindow, { state: "checking" });
    const au = await updater();
    au.autoDownload = false;
    au.autoInstallOnAppQuit = false;
    const res = await au.checkForUpdates();
    const info = res?.updateInfo;
    // Only NEWER versions toast — a lagging feed must never "update" a
    // newer local build (downgrade shaped as available).
    if (info && isNewerThan(info.version, app.getVersion())) {
      const notes = Array.isArray((info as { releaseNotes?: unknown }).releaseNotes)
        ? ((info as { releaseNotes: Array<{ note?: string }> }).releaseNotes.map((n) => n.note || "").join("\n").slice(0, 2000) || undefined)
        : typeof (info as { releaseNotes?: unknown }).releaseNotes === "string"
          ? String((info as { releaseNotes: string }).releaseNotes).slice(0, 2000)
          : undefined;
      const status: UpdateStatus = { state: "available", version: info.version, notes };
      pendingVersion = info.version;
      sendStatus(getWindow, status);
      return status;
    }
    const idle: UpdateStatus = { state: "idle" };
    sendStatus(getWindow, idle);
    return idle;
  } catch (err) {
    const status: UpdateStatus = {
      state: "error",
      error: err instanceof Error ? err.message.slice(0, 200) : "update check failed",
    };
    sendStatus(getWindow, status);
    return status;
  }
}

/** Download the pending update. Progress streams as update-status events. */
export async function downloadUpdate(getWindow: WindowGetter): Promise<UpdateStatus> {
  if (!app.isPackaged) return { state: "idle" };
  cancelRequested = false;
  try {
    // The force-update card can fire before any successful check (boot check
    // runs at 30s; a 426 can beat it) — resolve the pending update first.
    if (!pendingVersion) {
      const checked = await checkForUpdates(getWindow);
      if (checked.state !== "available" || !pendingVersion) {
        return checked.state === "available"
          ? { state: "available", version: pendingVersion }
          : checked;
      }
    }
    const au = await updater();
    const { CancellationToken } = await import("builder-util-runtime");
    const token = new CancellationToken();
    const progressHandler = (p: { percent?: number; bytesPerSecond?: number; transferred?: number; total?: number }) => {
      if (cancelRequested) {
        try {
          token.cancel();
        } catch {}
        return;
      }
      sendStatus(getWindow, {
        state: "downloading",
        percent: typeof p.percent === "number" ? Math.round(p.percent) : undefined,
        bytesPerSecond: p.bytesPerSecond,
        transferred: p.transferred,
        total: p.total,
      });
    };
    au.on("download-progress", progressHandler);
    try {
      await au.downloadUpdate(token);
    } finally {
      au.removeListener("download-progress", progressHandler);
    }
    if (cancelRequested) {
      const idle: UpdateStatus = { state: "idle" };
      sendStatus(getWindow, idle);
      return idle;
    }
    const done: UpdateStatus = { state: "downloaded", version: pendingVersion };
    pendingVersion = undefined;
    sendStatus(getWindow, done);
    return done;
  } catch (err) {
    // Cancellation surfaces as an error — report idle instead of scaring the user.
    if (cancelRequested) {
      const idle: UpdateStatus = { state: "idle" };
      sendStatus(getWindow, idle);
      return idle;
    }
    const status: UpdateStatus = {
      state: "error",
      error: err instanceof Error ? err.message.slice(0, 200) : "download failed",
    };
    sendStatus(getWindow, status);
    return status;
  }
}

/** Restart into the downloaded update. Only called from an explicit user click. */
export async function installUpdate(): Promise<void> {
  if (!app.isPackaged) return;
  const au = await updater();
  au.quitAndInstall(false, true);
}

/** Wire the 4 renderer IPC handlers. Safe to call once at startup. */
export function registerUpdaterIpc(getWindow: WindowGetter): void {
  if (initialized) return;
  initialized = true;
  ipcMain.handle("orplex:update-check", () => checkForUpdates(getWindow));
  ipcMain.handle("orplex:update-download", () => downloadUpdate(getWindow));
  ipcMain.handle("orplex:update-cancel", () => {
    cancelRequested = true;
    return { ok: true };
  });
  ipcMain.handle("orplex:update-install", () => installUpdate().then(() => ({ ok: true })));
}

/**
 * Start the update schedule: one delayed check after boot, then every 6h.
 * Packaged only; dev runs skip silently (no published metadata to read).
 */
export function startUpdateSchedule(getWindow: WindowGetter): void {
  if (!app.isPackaged) return;
  const CHECK_MS = 6 * 60 * 60 * 1000;
  setTimeout(() => {
    void checkForUpdates(getWindow).catch(() => {});
  }, 30_000);
  setInterval(() => {
    void checkForUpdates(getWindow).catch(() => {});
  }, CHECK_MS);
}
