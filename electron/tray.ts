// tray.ts — System tray + native notifications for the Electron shell.
//
// Deliberately low-key on the 8GB machine: a static icon, a poll of the
// local server's run summary every 15s, and a notification only on status
// TRANSITIONS (running→completed / →failed). No animations, no heavy
// rendering — the tray costs a few hundred KB.
//
// The Next server itself is NOT touched here; main.ts owns its lifecycle.

import { app, Tray, Menu, Notification, nativeImage } from "electron";
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

function iconPath(): string {
  // Orplex logo in the tray/system area. Prefer the 32px render (crisper on
  // HiDPI taskbars than the old 16px), fall back to the 16px, then to an
  // empty image (Electron uses its default) rather than crashing.
  // Probes dev layout (electron-dist/../electron/assets) AND packaged layout
  // (app.asar/electron/assets) — tray.png must ship in builder `files`.
  const fs = require("fs");
  try {
    const bases = [
      join(__dirname, "assets"),
      join(__dirname, "..", "electron", "assets"),
      join(process.resourcesPath || "", "app.asar", "electron", "assets"),
    ];
    for (const base of bases) {
      for (const name of ["icon32.png", "tray.png"]) {
        const p = join(base, name);
        if (p && fs.existsSync(p)) return p;
      }
    }
    return "";
  } catch {
    return "";
  }
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
      if (tray) tray.setToolTip(`Orplex — ${activeIds.size} active run(s)`);
    })
    .catch(() => {});
}

export function buildTrayWithNotifications(appUrl: string): void {
  const img = iconPath();
  const image = img ? nativeImage.createFromPath(img) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("Orplex");
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

export function stopTray(): void {
  if (timer) clearInterval(timer);
  timer = null;
  tray?.destroy();
  tray = null;
}
