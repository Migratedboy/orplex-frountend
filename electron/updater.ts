// updater.ts — In-app updates for the packaged desktop app.
//
// The app updates itself, the way VS Code and Chrome do: a newer version is
// fetched in the background and, once it is on disk, installed over the
// running one. The old build is replaced by the installer — the user never
// deletes or reinstalls anything by hand.
//
//   boot (packaged only) → check → newer version found → downloaded in the
//   background → "downloaded" status → the app installs it and relaunches.
//
// The renderer can DEFER the restart ("Later", or while agent runs are
// active): the downloaded installer stays on disk and is applied on the next
// quit (autoInstallOnAppQuit) or on the next boot, where the pending update
// is found again and applied automatically.
//
// Renderer talks to this module through 6 IPC handlers (registered by
// registerUpdaterIpc) and receives "orplex:update-status" events.
// Dev/unpackaged runs are no-ops (electron-updater needs published metadata).

import { app, BrowserWindow, powerMonitor } from "electron";
import type { AppUpdater } from "electron-updater";
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
let listenersWired = false;
let autoInstallTimer: NodeJS.Timeout | null = null;
let deferredVersion: string | undefined;
let downloadActive = false;
let downloadedVersion: string | undefined;

/** Grace period between "download finished" and the automatic restart. */
const AUTO_INSTALL_DELAY_MS = 12_000;

function sendStatus(getWindow: WindowGetter, status: UpdateStatus): void {
  try {
    getWindow()?.webContents.send("orplex:update-status", status);
  } catch {
    /* window gone — drop the event */
  }
}

let updaterPromise: Promise<AppUpdater> | null = null;

async function updater(): Promise<AppUpdater> {
  if (!updaterPromise) {
    updaterPromise = (async () => {
      const au = (await import("electron-updater")).autoUpdater;
      au.logger = console;
      return au;
    })();
  }
  return await updaterPromise;
}

/**
 * The app updates itself: a newer version is fetched in the background and,
 * once it is on disk, installed over the running one. The old build is
 * replaced by the installer — nothing has to be deleted by hand.
 */
function configureAuto(au: AppUpdater): void {
  au.autoDownload = true;
  au.autoInstallOnAppQuit = true;
  au.allowDowngrade = false;
}

/** Restart into the downloaded update once the grace period is over. */
function scheduleAutoInstall(getWindow: WindowGetter): void {
  if (autoInstallTimer) clearTimeout(autoInstallTimer);
  autoInstallTimer = setTimeout(() => {
    autoInstallTimer = null;
    void installUpdate();
  }, AUTO_INSTALL_DELAY_MS);
}

/**
 * Forward the updater's own events to the renderer and apply the update
 * automatically. Wired once — electron-updater is a process-wide singleton.
 */
async function ensureEventListeners(getWindow: WindowGetter): Promise<void> {
  if (listenersWired) return;
  listenersWired = true;
  const au = await updater();
  au.on("download-progress", (p: { percent?: number; bytesPerSecond?: number; transferred?: number; total?: number }) => {
    if (cancelRequested) return;
    downloadActive = true;
    sendStatus(getWindow, {
      state: "downloading",
      percent: typeof p.percent === "number" ? Math.round(p.percent) : undefined,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    });
  });
  au.on("update-downloaded", (info: { version?: string }) => {
    const version = info?.version ?? pendingVersion;
    pendingVersion = undefined;
    downloadActive = false;
    downloadedVersion = version;
    sendStatus(getWindow, { state: "downloaded", version });
    if (deferredVersion && deferredVersion === version) return;
    scheduleAutoInstall(getWindow);
  });
  au.on("error", (err: Error) => {
    downloadActive = false;
    console.error("[updater] update error:", err?.message ?? err);
    sendStatus(getWindow, { state: "error", error: (err?.message ?? "update failed").slice(0, 200) });
  });
}

/** Release notes can be HTML (GitHub renderer) — the toast is plain text. */
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

function notesToText(raw: unknown): string | undefined {
  if (Array.isArray(raw)) {
    return notesToText((raw as Array<{ note?: string }>).map((n) => n.note ?? "").join("\n"));
  }
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const text = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&([a-z]+);/gi, (m, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? m)
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
    configureAuto(au);
    await ensureEventListeners(getWindow);
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
    // runs at 10s; a 426 can beat it) — resolve the pending update first.
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
    configureAuto(au);
    await ensureEventListeners(getWindow);
    // The background auto-download may already be running — a second call
    // would fail with "already downloading", which is not an error here.
    if (downloadActive) return { state: "downloading", version: pendingVersion };
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
    const message = err instanceof Error ? err.message : String(err);
    // electron-updater refuses a second concurrent download — that is the
    // background download doing its job, not a failure.
    if (/already|download in progress/i.test(message)) {
      return { state: "downloading", version: pendingVersion };
    }
    const status: UpdateStatus = {
      state: "error",
      error: message.slice(0, 200),
    };
    console.error("[updater] download failed:", message);
    sendStatus(getWindow, status);
    return status;
  }
}

/**
 * Hold the restart back for now ("Later", or while agent runs are active).
 * The downloaded installer stays on disk and is applied on the next quit or
 * the next boot — the update is never lost, it is only postponed.
 */
export function deferAutoInstall(version?: string): void {
  if (autoInstallTimer) {
    clearTimeout(autoInstallTimer);
    autoInstallTimer = null;
  }
  if (version) deferredVersion = version;
  else if (downloadedVersion) deferredVersion = downloadedVersion;
}

/** Re-arm the automatic restart (the blocker that deferred it is gone). */
export function armAutoInstall(getWindow: WindowGetter): void {
  if (!downloadedVersion) return;
  if (deferredVersion && deferredVersion === downloadedVersion) {
    deferredVersion = undefined;
  }
  scheduleAutoInstall(getWindow);
}

/** Restart into the downloaded update. */
export async function installUpdate(): Promise<void> {
  if (!isPackagedRuntime()) return;
  if (autoInstallTimer) {
    clearTimeout(autoInstallTimer);
    autoInstallTimer = null;
  }
  const au = await updater();
  au.quitAndInstall(false, true);
}

/** Wire the renderer IPC handlers. Safe to call once at startup.
 *  Gated at the sender like every other channel — installUpdate force-quits,
 *  so a hostile sandboxed preview frame must never be able to invoke it. */
export function registerUpdaterIpc(getWindow: WindowGetter, gate: IpcGate): void {
  if (initialized) return;
  initialized = true;
  gate("orplex:update-check", () => checkForUpdates(getWindow));
  gate("orplex:update-download", () => downloadUpdate(getWindow));
  gate("orplex:update-cancel", () => {
    cancelRequested = true;
    downloadActive = false;
    return { ok: true };
  });
  gate("orplex:update-install", () => installUpdate().then(() => ({ ok: true })));
  gate("orplex:update-defer", () => {
    deferAutoInstall(pendingVersion);
    return { ok: true };
  });
  gate("orplex:update-arm", () => {
    armAutoInstall(getWindow);
    return { ok: true };
  });
}

/**
 * Start the update schedule: one check shortly after boot, then every 6h and
 * whenever the machine wakes up. Packaged only; dev runs skip silently (no
 * published metadata to read).
 */
export function startUpdateSchedule(getWindow: WindowGetter): void {
  if (!isPackagedRuntime()) return;
  const CHECK_MS = 6 * 60 * 60 * 1000;
  const check = () => {
    void checkForUpdates(getWindow).catch(() => {});
  };
  setTimeout(check, 10_000);
  setInterval(check, CHECK_MS);
  try {
    // A laptop that wakes up after a release should pick it up right away.
    powerMonitor.on("resume", check);
  } catch {
    /* powerMonitor is unavailable in some sandboxes — the interval still runs */
  }
}
