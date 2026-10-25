// updater.ts — In-app updates for the packaged desktop app (Freebuff-style).
//
// Flow (all user-consented, never forced):
//   boot (packaged only, 30s delay) → check → "available vX" toast
//   → user clicks Download → progress toast w/ Cancel → downloaded
//   → user clicks Restart → quitAndInstall.
// Renderer talks to this module through 4 IPC handlers (registered by
// registerUpdaterIpc) and receives "orplex:update-status" events.
// Dev/unpackaged runs are no-ops (electron-updater needs published metadata).

import { app, BrowserWindow } from "electron";
import type { IpcGate } from "./terminal";
import { isPackagedRuntime } from "./dev-mode";

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
  const au = (await import("electron-updater")).autoUpdater;
  au.logger = console;
  return au;
}

/** Release notes can be HTML (GitHub renderer) — the toast is plain text. */
function notesToText(raw: unknown): string | undefined {
  if (Array.isArray(raw)) {
    return notesToText((raw as Array<{ note?: string }>).map((n) => n.note ?? "").join("\n"));
  }
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const text = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.slice(0, 2000) || undefined;
}

/** Check now (manual from menu/Settings, or the boot/interval schedule). */
export async function checkForUpdates(getWindow: WindowGetter): Promise<UpdateStatus> {
  if (!isPackagedRuntime()) return { state: "idle" };
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
      const notes = notesToText((info as { releaseNotes?: unknown }).releaseNotes);
      const status: UpdateStatus = { state: "available", version: info.version, notes };
      pendingVersion = info.version;
      sendStatus(getWindow, status);
      return status;
    }
    const idle: UpdateStatus = { state: "idle" };
    sendStatus(getWindow, idle);
    return idle;
  } catch (err) {
    console.error("[updater] check failed:", err instanceof Error ? err.message : err);
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
  if (!isPackagedRuntime()) return { state: "idle" };
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
    // Flip the card to "downloading" immediately: the first on-disk progress
    // event can lag several seconds behind the click (blockmap preflight,
    // request setup) — a silent button for 10s reads as broken.
    sendStatus(getWindow, { state: "downloading", percent: 0 });
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
    console.error("[updater] download failed:", err instanceof Error ? err.message : err);
    sendStatus(getWindow, status);
    return status;
  }
}

/** Restart into the downloaded update. Only called from an explicit user click. */
export async function installUpdate(): Promise<void> {
  if (!isPackagedRuntime()) return;
  const au = await updater();
  au.quitAndInstall(false, true);
}

/** Wire the 4 renderer IPC handlers. Safe to call once at startup.
 * Gated at the sender like every other channel — installUpdate force-quits,
 * so a hostile sandboxed preview frame must never be able to invoke it. */
export function registerUpdaterIpc(getWindow: WindowGetter, gate: IpcGate): void {
  if (initialized) return;
  initialized = true;
  gate("orplex:update-check", () => checkForUpdates(getWindow));
  gate("orplex:update-download", () => downloadUpdate(getWindow));
  gate("orplex:update-cancel", () => {
    cancelRequested = true;
    return { ok: true };
  });
  gate("orplex:update-install", () => installUpdate().then(() => ({ ok: true })));
}

/**
 * Start the update schedule: one delayed check after boot, then every 6h.
 * Packaged only; dev runs skip silently (no published metadata to read).
 */
export function startUpdateSchedule(getWindow: WindowGetter): void {
  if (!isPackagedRuntime()) return;
  const CHECK_MS = 6 * 60 * 60 * 1000;
  setTimeout(() => {
    void checkForUpdates(getWindow).catch(() => {});
  }, 30_000);
  setInterval(() => {
    void checkForUpdates(getWindow).catch(() => {});
  }, CHECK_MS);
}
