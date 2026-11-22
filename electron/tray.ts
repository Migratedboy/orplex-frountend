// tray.ts — System tray + native notifications for the Electron shell.
//
// Deliberately low-key on the 8GB machine: a static icon, a poll of the
// local server's run summary every 15s, and a notification only on status
// TRANSITIONS (running→completed / →failed). No animations, no heavy
// rendering — the tray costs a few hundred KB.
//
// The Next server itself is NOT touched here; main.ts owns its lifecycle.
//
// ICON: `resources/tray.ico` + `resources/tray.png` / `tray@2x.png`, copied
// byte-for-byte from the authored icon pack by scripts/install-icon-pack.mjs.
// They live OUTSIDE the asar (electron-builder extraResources, `resources/` ->
// `resources/`) because the previous lookup preferred `__dirname/assets`, and
// the compiled tree carried its own copy of the OLD tile — so a packaged build
// kept drawing the previous logo in the notification area no matter how many
// times the repo's assets were updated.

import { app, Tray, Menu, Notification, nativeImage } from "electron";
import { isDevRuntime } from "./dev-mode";
import type { NativeImage } from "electron";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const POLL_MS = 15_000;

interface RunRow {
  id: string;
  status: string;
  isActive: boolean;
}

let tray: Tray | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const lastActive = new Set<string>();

/**
 * Directories that can hold the notification-area art, in priority order.
 *
 * A branded dev binary makes Electron report `app.isPackaged === true` (see
 * dev-mode.ts), so `app.isPackaged` is NOT a reliable "is this installed?" test
 * here — it sent the dev run looking for tray files inside Electron's own
 * resources folder, found nothing, and left a blank tray. Order by runtime kind
 * and fall back to the other location.
 */
function trayDirs(): string[] {
  const repo = join(__dirname, "..", "resources");
  const packaged = join(process.resourcesPath, "resources");
  return isDevRuntime() ? [repo, packaged] : [packaged, repo];
}

/** Absolute path of the tray icon for THIS kind of run. */
function trayIconPath(): string {
  for (const dir of trayDirs()) {
    const candidate = join(dir, "tray.ico");
    if (existsSync(candidate)) return candidate;
  }
  return join(trayDirs()[0], "tray.ico");
}

/** 16px / 32px PNG fallbacks, same folder as the .ico (pack-authored). */
function trayPngPaths(): string[] {
  const dir = trayDir();
  return [join(dir, "tray@2x.png"), join(dir, "tray.png")];
}

/** The first icon directory that actually contains the tray art. */
function trayDir(): string {
  for (const dir of trayDirs()) {
    if (existsSync(join(dir, "tray.ico")) || existsSync(join(dir, "tray.png"))) return dir;
  }
  return trayDirs()[0];
}

/**
 * Exact-size pixel representations for the notification area.
 *
 * The pack ships the tray art at 1x (16px) and 2x (32px) — the sizes the
 * Windows tray draws at 100% and 200% scaling — so these are copied verbatim
 * and never resized here. `nativeImage.createFromPath("*.ico")` exposes a
 * single nominal-size representation (256px), which the shell would resample
 * down to 16px and smear; the 1x/2x pair keeps the mark's edges hard.
 *
 * Everything in this folder is byte-for-byte from the authored icon pack
 * (scripts/install-icon-pack.mjs). Nothing is derived.
 */
function trayRepresentations(icoImage: NativeImage): NativeImage {
  const dir = trayDir();
  const reps: Array<readonly [number, string]> = [
    [1, "tray.png"],
    [2, "tray@2x.png"],
  ];
  if (!reps.every(([, name]) => existsSync(join(dir, name)))) return icoImage;

  const image = nativeImage.createEmpty();
  for (const [scaleFactor, name] of reps) {
    image.addRepresentation({ scaleFactor, buffer: readFileSync(join(dir, name)) });
  }
  return image.isEmpty() ? icoImage : image;
}

/**
 * Load the tray image, and SAY SO when the path is wrong. A silent empty image
 * is what let an old icon live on for releases: Electron falls back to a blank
 * tray entry instead of failing, so nobody noticed the path had moved.
 */
function loadTrayImage(): NativeImage {
  const ico = trayIconPath();
  if (!existsSync(ico)) {
    console.error(`[tray] tray icon missing: ${ico}`);
  } else {
    const image = nativeImage.createFromPath(ico);
    if (!image.isEmpty()) {
      // The .ico proves the pinned file decodes; the exact-size PNGs are what
      // the notification area actually draws (see trayRepresentations).
      return trayRepresentations(image);
    }
    console.error(`[tray] tray icon could not be decoded (isEmpty): ${ico}`);
  }

  for (const png of trayPngPaths()) {
    if (!existsSync(png)) {
      console.error(`[tray] fallback icon missing: ${png}`);
      continue;
    }
    const image = nativeImage.createFromPath(png);
    if (!image.isEmpty()) return image;
    console.error(`[tray] fallback icon could not be decoded (isEmpty): ${png}`);
  }

  console.error(`[tray] no usable tray icon — the notification area entry will be blank`);
  return nativeImage.createEmpty();
}

function notify(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on("click", () => {
      for (const w of (require("electron").BrowserWindow.getAllWindows?.() ?? []) as unknown[]) {
        (w as { show?: () => void }).show?.();
      }
    });
    n.show();
  } catch {
    // notifications are best-effort
  }
}

function poll(appUrl: string): void {
  fetch(`${appUrl}/api/agent/runs?limit=20&status=active`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const runs: RunRow[] = d?.runs ?? [];
      const activeIds = new Set(runs.filter((r) => r.isActive).map((r) => r.id));
      // Completed/failed transitions: ids that WERE active last poll but are
      // no longer active now.
      for (const r of runs) {
        if (lastActive.has(r.id) && !activeIds.has(r.id)) {
          if (r.status === "completed") notify("Orplex — run completed", r.id.slice(-6));
          else if (r.status === "failed") notify("Orplex — run failed", r.id.slice(-6));
          else if (r.status === "interrupted") notify("Orplex — run interrupted (memory pressure)", r.id.slice(-6));
        }
      }
      lastActive.clear();
      for (const id of activeIds) lastActive.add(id);
      if (tray) tray.setToolTip(`Orplex Code — ${activeIds.size} active run(s)`);
    })
    .catch(() => {});
}

/** Exactly one tray, created once, referenced at module scope so it survives GC. */
export function buildTrayWithNotifications(appUrl: string): void {
  if (tray) return; // never stack a second icon in the notification area
  tray = new Tray(loadTrayImage());
  tray.setToolTip("Orplex Code");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Orplex", click: () => app.focus({ steal: true }) },
      { type: "separator" },
      {
        label: "Quit",
        click: () => app.quit(),
      },
    ])
  );

  poll(appUrl);
  timer = setInterval(() => poll(appUrl), POLL_MS);
  if (timer.unref) timer.unref();
}

/** Remove the tray icon on quit — a destroyed window must not leave a ghost. */
export function stopTray(): void {
  if (timer) clearInterval(timer);
  timer = null;
  tray?.destroy();
  tray = null;
  lastActive.clear();
}
