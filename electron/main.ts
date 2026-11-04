/**
 * electron/main.ts — Electron main process for Orplex.
 *
 * Architecture: the desktop app is a native shell around the Next.js UI
 * (repo root). All API routes, next-auth, Prisma and processing live in the
 * CLOUD backend (e.g. https://orplextech.freebuff.app) — set ORPLEX_API_URL
 * (ORPLEX_API_URL) and the main process spawns ONLY the UI
 * server; the UI talks to the hosted backend over HTTPS. Both vars come
 * from the repo-root .env via the loader at the top of this file.
 */
import { app, BrowserWindow, shell, Menu, dialog, ipcMain, session, nativeImage } from "electron";
import type { NativeImage } from "electron";
import { isDevRuntime } from "./dev-mode";
import { POISON_SHORTCUT_NAME, sweepIconPoison as sweepIconPoisonPure } from "./icon-poison";
import { homedir } from "node:os";
import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import { registerMcpIpc } from "./mcp-bridge";
import { loopbackUrl, loopbackProbeUrls } from "./loopback";
import { registerDesktopAuth, handleDesktopAuthArgv } from "./auth-desktop";
import { registerTerminalIpc, killAllTerminalChildren } from "./terminal";
import { createConversationStore } from "./conversations-store";
import { killNextChildren } from "./next-children";
import { preparePreviewPartition, registerPreviewBrowser } from "./preview-views";
import fs from "node:fs";
import path from "node:path";

// Load the repo-root .env into this process (tiny 2-line parser — dotenv is
// intentionally not a dependency). Must run BEFORE the constants below read
// ORPLEX_*: this is how cloud mode (ORPLEX_API_URL) is configured for the
// desktop app without touching shell env or rebuilding.
(function loadElectronEnv() {
  try {
    const envPath = path.join(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch {}
})();

// A PACKAGED app has no .env beside it (electron-builder deliberately never
// ships one — it holds the database password), so cloud mode would silently
// fall back to booting an embedded local Postgres + local API. Ship the
// backend origin in electron/app-config.json instead and apply it as a
// DEFAULT only: repo-root .env and real shell env keep winning, so local dev
// and self-hosted installs are unaffected.
(function loadAppConfig() {
  try {
    const candidates = [
      path.join(__dirname, "..", "electron", "app-config.json"),
      app.isPackaged
        ? path.join(process.resourcesPath, "app", "electron", "app-config.json")
        : path.join(process.cwd(), "electron", "app-config.json"),
    ];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      const cfg = JSON.parse(fs.readFileSync(p, "utf8")) as {
        apiUrl?: string;
        lightweight?: boolean;
        sessionPublicKey?: string;
      };
      if (cfg.apiUrl && !process.env.ORPLEX_API_URL) process.env.ORPLEX_API_URL = cfg.apiUrl;
      if (cfg.lightweight && !process.env.ORPLEX_LIGHTWEIGHT) process.env.ORPLEX_LIGHTWEIGHT = "1";
      // The app verifies its own session cookie with the backend's PUBLIC
      // key (the private key never leaves the backend). Without it the local
      // page gate cannot recognize a signed-in user and bounces everyone back
      // to /auth/signin right after a successful sign-in.
      if (cfg.sessionPublicKey && !process.env.ORPLEX_SESSION_PUBLIC_KEY) {
        process.env.ORPLEX_SESSION_PUBLIC_KEY = cfg.sessionPublicKey;
      }
      return;
    }
  } catch {}
})();

// A branded dev binary (renamed electron.exe with our icon) makes Electron
// report isPackaged=true — ORPLEX_DEV=1 from the dev launcher restores the
// checkout semantics the rest of this file relies on.
const isDev = isDevRuntime();
// Taskbar identity. The packaged app owns the stable AUMID. A dev run must NOT
// claim it: Windows draws the taskbar button of a KNOWN AUMID from the
// registered shell app (Start Menu shortcut -> installed exe), so a dev run
// reusing "tech.orplex.app" keeps showing the INSTALLED app's cached icon
// even when the dev exe and the BrowserWindow carry a brand-new one.
const PACKAGED_APP_ID = "tech.orplex.app";
const DEV_APP_ID = "tech.orplex.app.dev";
const APP_ID = isDev ? DEV_APP_ID : PACKAGED_APP_ID;
// Electron OWNS both Next.js processes — the user never runs one separately.
// ORPLEX_PORT / ORPLEX_API_PORT only override for special setups.
const UI_PORT = Number(process.env.ORPLEX_PORT || 5000);
const API_PORT = Number(process.env.ORPLEX_API_PORT || 5010);
/**
 * Register an IPC handler that only accepts calls from our own app origin.
 *
 * All 33 handlers previously registered with a bare `ipcMain.handle(...)` and
 * validated nothing about the sender. The preload bridge (including
 * terminal.exec, which spawns with shell:true) is attached to the MAIN WINDOW
 * only - the preview/agent views are sandboxed with no preload - so any handler
 * reachable from a non-app origin is reachable only after the window has been
 * navigated somewhere hostile. With the will-navigate guard above that is much
 * harder, but defence in depth: validate at every single entry point rather
 * than trusting the navigation layer to hold.
 */
function handleAppIpc(channel: string, handler: (event: any, ...args: any[]) => any) {
  ipcMain.handle(channel, async (event, ...args) => {
    const senderUrl =
      event?.senderFrame?.url || event?.sender?.getURL?.() || "";
    if (!isAppOrigin(senderUrl)) {
      console.warn(
        `[ipc] rejected '${channel}' from untrusted origin: ${senderUrl || "(unknown)"}`,
      );
      throw new Error(`IPC '${channel}' rejected: sender origin not allowed`);
    }
    return handler(event, ...args);
  });
}

/**
 * The address the app's own Next.js server is bound to.
 *
 * The server is spawned with HOSTNAME=127.0.0.1 (IPv4 loopback). "localhost"
 * is NOT a safe alias for it: on Windows it resolves to ::1 (IPv6) first, and
 * a request that lands on ::1 never reaches the IPv4 listener — the readiness
 * probe timed out and the app showed "Server failed to start" while the
 * server was up and answering on 127.0.0.1. Always talk to the address we
 * bind, and keep "localhost" only as a probe fallback.
 */
const APP_URL = loopbackUrl(UI_PORT);
const API_URL = loopbackUrl(API_PORT);
/** Probe order: the bound address first, "localhost" as a fallback. */
const APP_PROBES = loopbackProbeUrls(UI_PORT);
const API_PROBES = loopbackProbeUrls(API_PORT);

/**
 * Is this URL our own app?
 *
 * Used by the navigation guards to ensure the main window can only ever host
 * the local Next server. Everything else is refused and (for http/https)
 * handed to the OS browser. Compared against the parsed origin rather than by
 * string prefix, so `http://localhost:3000.evil.com` and
 * `http://evil.com/?x=http://localhost:3000` cannot pass.
 */
function isAppOrigin(raw: string): boolean {  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // The packaged app and dev both serve from loopback on UI_PORT. Dev may be
    // on 127.0.0.1 or the LAN address for device testing.
    const host = u.hostname.toLowerCase();
    const isLoopback =
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    if (isLoopback) return u.port === String(UI_PORT) || u.port === "";
    // The preview/agent WebContentsViews serve third-party origins, but those are
    // sandboxed views WITHOUT the preload bridge (sandbox: true, no contextBridge
    // to orplexDesktop). The main window must stay loopback-only, so anything
    // else is refused.
    return false;
  } catch {
    return false;
  }
}

// Legal pages (Terms of Service / Privacy Policy) must never load inside the
// app window: the proxy deliberately serves them WITHOUT an auth gate, so an
// in-place navigation from the sign-in page would swap the auth screen for a
// public page and let the app shell boot unlocked. Clicking them sends the
// document to the OS browser instead ("a different page", as requested).
function isLegalPageUrl(raw: string): boolean {
  try {
    return isAppOrigin(raw) && new URL(raw).pathname.replace(/\/+$/, "").startsWith("/legal/");
  } catch {
    return false;
  }
}
// === LIGHTWEIGHT MODE =======================================================
// ORPLEX_LIGHTWEIGHT=1 (repo .env or shell env) records that the run expects
// no local database at all. There is no embedded/local Postgres any more —
// the backend owns the database — so this flag no longer changes startup,
// it is kept only so existing env files stay valid and self-documenting.
const LIGHTWEIGHT = /^(1|true|yes)$/i.test(process.env.ORPLEX_LIGHTWEIGHT || "");

// === LOCAL-FIRST CONVERSATIONS ==============================================
// Conversations are ON-DEVICE data in the desktop app. This JSON file in
// userData is the source of truth (one-time imported from the cloud on first
// run — see conversations:migrate-from-cloud — then never written to the
// backend again). The proxy stops forwarding /api/conversations, so no
// sign-in outage or deploy hiccup can take the History/Sidebar away.
const conversationsStore = createConversationStore({
  file: process.env.ORPLEX_CONVERSATIONS_FILE || path.join(app.getPath("userData"), "conversations.json"),
});

let nextProcess: ChildProcess | null = null;
let apiProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}
let quitting = false;

// === CRASH RECOVERY =========================================================
// A session file records whether the previous run ended cleanly. If the app
// starts WITHOUT that marker (crash, force-kill, power loss), the renderer
// offers "Recover previous session?" — the run ledger on the backend still
// has the runs; the prompt just tells the user where to look.
const sessionStatePath = (): string => {
  try {
    const path = require("node:path") as typeof import("node:path");
    return path.join(app.getPath("userData"), "session-state.json");
  } catch {
    return "";
  }
};

function readLastSessionState(): { clean: boolean; endedAt?: string } {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const p = sessionStatePath();
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  // No file at all = a genuinely fresh install, not a crash.
  return { clean: true };
}

function writeSessionState(clean: boolean): void {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const p = sessionStatePath();
    if (p) fs.writeFileSync(p, JSON.stringify({ clean, endedAt: new Date().toISOString() }));
  } catch {}
}

// === SINGLE INSTANCE ========================================================
// Opening the app twice must focus the existing window, not fight over the
// backend port (the old "kill the port listener" behavior murdered the
// user's own dev servers AND a healthy app instance).
const gotTheLock = app.requestSingleInstanceLock();
// Taskbar identity FIRST (before ready): Windows groups the taskbar button
// by AppUserModelId + exe and CACHES the icon per AUMID. The packaged exe
// claims the stable AUMID; a dev run gets its OWN AUMID so it never inherits
// the shell registration (Start Menu shortcut -> installed exe) that carries
// the installed app's cached icon.
try {
  app.setAppUserModelId(APP_ID);
} catch {}
// Self-healing icon-poison sweep: Electron's Windows toast-notification
// path self-installs a Start Menu "Electron.lnk" carrying its own AUMID.
// One pointing at a dev electron.exe propagates the generic icon into the
// shell caches — delete it on sight from the packaged app.
// Self-healing icon-poison sweep: Electron's Windows toast-notification
// path self-installs a Start Menu "Electron.lnk" carrying the CURRENT app's
// AUMID. In a dev run that AUMID is tech.orplex.app.dev — the same one our
// window declares — and the shortcut targets the STOCK electron.exe, so the
// shell resolves the taskbar button through it and shows the generic Electron
// logo and the name "Electron" (the branded dev binary, BrowserWindow.icon
// and setAppDetails then have no say). This sweep therefore has to run in
// DEV as well — it used to be packaged-only, which left the dev taskbar
// poisoned — and again once the app is ready, because Electron creates that
// shortcut while initializing its toast support.
// Only an unbranded electron.exe target is ever deleted; an installed
// "Orplex Code.exe" shortcut is never touched.
function sweepIconPoison(): void {
  // Candidates: the known "Electron.lnk" plus EVERY shortcut in the Programs
  // folder — Electron may name the poison after the app name instead, and a
  // name-based sweep would miss that variant. Only the TARGET decides.
  const programs = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
  let candidates: string[] = [path.join(programs, POISON_SHORTCUT_NAME)];
  try {
    for (const entry of fs.readdirSync(programs)) {
      if (!/\.lnk$/i.test(entry)) continue;
      candidates.push(path.join(programs, entry));
    }
  } catch {}
  const result = sweepIconPoisonPure({
    candidates,
    exists: (p) => fs.existsSync(p),
    readTarget: (p) => shell.readShortcutLink(p).target,
    remove: (p) => fs.unlinkSync(p),
  });
  if (result.removed.length) {
    console.log("[win-icon] removed poisonous shortcut(s):", result.removed.join(", "));
  }
  for (const err of result.errors) {
    console.log("[win-icon] poison sweep noop:", err);
  }
}
try {
  sweepIconPoison();
} catch {}
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // A second launch may be the OS delivering an orplex://auth deep link.
    handleDesktopAuthArgv(argv);
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// === REAL-BROWSER PREVIEW + AGENT BROWSER =================================
// The native preview (real WebContentsView tabs) and the agent's own browser
// session live in preview-views.ts; the pure decision logic is unit-tested in
// preview-logic.ts. Registered at the same module scope where these handlers
// used to live inline, so IPC registration order is unchanged. main.ts keeps
// window ownership and the origin-guarded IPC entry point.
registerPreviewBrowser({ handleAppIpc, getMainWindow });

/** Resolve the repo root in dev / resources dir when packaged. */
function projectRoot(): string {
  return isDev ? path.join(app.getAppPath()) : process.resourcesPath;
}

/** Health-check: GET / until it answers (any status).
 *  The timeout is generous: on a loaded machine (the app itself plus a dev
 *  build of the UI) the standalone server can need a couple of minutes to
 *  come up, and giving up early only produced a "Server failed to start"
 *  dialog while the server was about to answer. */
function waitForServer(urls: string | string[], timeoutMs = 150000): Promise<void> {
  const list = Array.isArray(urls) ? urls : [urls];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      probeAnyServer(list)
        .then((up) => (up ? resolve() : retry()))
        .catch(retry);
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Next.js server did not become ready at ${list[0]}`));
        return;
      }
      setTimeout(attempt, 400);
    };
    attempt();
  });
}

/** Probe every candidate address until one answers. */
async function probeAnyServer(urls: string[], timeoutMs = 2500): Promise<boolean> {
  for (const url of urls) {
    if (await probeServer(url, timeoutMs)) return true;
  }
  return false;
}

/** Single probe: resolves true if the URL answers with any HTTP status. */
function probeServer(url: string, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume(); // drain
      resolve(!!res.statusCode && res.statusCode < 600);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Spawn one Next.js app ("ui" | "api") as a child process.
 *
 * Cloud mode: ORPLEX_API_URL points at a hosted backend and NO API child is
 * spawned at all — the
 * desktop app is a pure shell around a remote Orplex. (The historical
 * local-API mode that spawned a second backend/ Next app is gone; the
 * backend is deployed, not bundled.)
 */
function startNextServer(which: "ui" | "api"): void {
  const runAsNode = {
    ...process.env,
    ELECTRON: "1",
    ELECTRON_RUN_AS_NODE: "1", // make electron.exe behave as plain node for the child
    // The backend origin is SERVER-side only (ORPLEX_API_URL): the UI proxy
    // forwards /api/* there. The browser stays same-origin so the session
    // cookie is first-party on the UI origin — no CORS, no cross-site 401s.
    // Nothing NEXT_PUBLIC_* is injected on purpose.
    // The playbook store is a plain JSON file on THIS device (the user's
    // machine), so it must live in the writable per-user data dir — never in
    // the install folder (read-only under Program Files) and never on the
    // cloud backend.
    ORPLEX_PLAYBOOK_FILE: process.env.ORPLEX_PLAYBOOK_FILE || path.join(app.getPath("userData"), "playbook.json"),
    // The open workspace folder (per user) is device-local state too — it
    // must survive an app restart so the Plugins page, the agent's terminal
    // cwd and the workspace-scoped routes keep working.
    ORPLEX_WORKSPACES_FILE: process.env.ORPLEX_WORKSPACES_FILE || path.join(app.getPath("userData"), "workspaces.json"),
  } as NodeJS.ProcessEnv;

  const tag = which === "ui" ? "[ui]" : "[api]";
  const port = which === "ui" ? UI_PORT : API_PORT;

  const wireChild = (child: ChildProcess) => {
    child.stdout?.on("data", (d: Buffer) => process.stdout.write(`${tag} ${d}`));
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(`${tag} ${d}`));
    // A spawn failure (ENOENT, EINVAL, permissions) must never kill the main
    // process silently — surface it and exit cleanly.
    child.on("error", (err) => {
      process.stderr.write(`${tag} spawn error: ${err?.message || err}\n`);
      if (!quitting) {
        dialog.showErrorBox("Orplex server failed", `Could not launch the ${which} server: ${err?.message || err}`);
        app.exit(1);
      }
    });
    child.on("exit", (code) => {
      if (!quitting) {
        dialog.showErrorBox(
          "Orplex server exited",
          `The ${which} server exited unexpectedly (code ${code ?? "?"}).`
        );
        app.quit();
      }
    });
  };

  if (isDev) {
    // Dev: run `next dev` directly with node — no npm.cmd wrapper (spawning
    // .cmd/.bat without a shell is blocked on modern Node and crashes us).
    // Only the UI ever spawns locally now; in cloud mode (ORPLEX_API_URL set)
    // startNextServer("api") is never called.
    const root = projectRoot();
    const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
    const cwd = root; // the UI app (repo root) — the only local Next app
    const child = spawn(process.execPath, [nextBin, "dev", "-p", String(port)], {
      cwd,
      env: runAsNode,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (which === "ui") nextProcess = child;
    else apiProcess = child;
    wireChild(child);
  } else {
    // Packaged: run the standalone server bundle that ships in app/.next/
    // standalone. `next start` cannot work here — standalone deliberately
    // ships no `next` CLI and no top-level .next/server, only its own
    // self-contained server.js. Electron's bundled Node runs it directly via
    // ELECTRON_RUN_AS_NODE, so no separate node.exe has to ship.
    const root = projectRoot();
    const appRoot = path.join(root, "app");
    const standalone = path.join(appRoot, ".next", "standalone");
    const serverEntry = path.join(standalone, "server.js");
    if (!fs.existsSync(serverEntry)) {
      dialog.showErrorBox(
        "Orplex install is incomplete",
        `The app server is missing:\n${serverEntry}\n\nReinstall Orplex Code.`
      );
      app.exit(1);
    }
    const child = spawn(process.execPath, [serverEntry], {
      cwd: standalone,
      env: {
        ...runAsNode,
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (which === "ui") nextProcess = child;
    else apiProcess = child;
    wireChild(child);
  }
}

// === APP ICON ===============================================================
// Finds the icon on disk no matter where the code runs from: compiled output
// (dist-electron), the electron/ source folder, or a packaged app's resources.
// Windows needs the .ico for a crisp taskbar icon; PNG is the fallback.
function resolveIconPath(): string | undefined {
  const names = process.platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png", "icon.ico"];
  // Start points: packaged resources (a REAL file, not inside the asar),
  // compiled dir, app root, cwd. From each, walk UP a few levels and probe
  // the usual icon folders at every level.
  const starts = [process.resourcesPath || "", __dirname, app.getAppPath(), process.cwd()];
  const subs = ["", "assets", "electron", path.join("electron", "assets"), "build", "public", "resources",
    // Packaged app: files land inside app.asar (fs.existsSync reads through asar).
    path.join("app.asar", "electron", "assets"), path.join("app", "electron", "assets")];
  const seen = new Set<string>();
  for (const name of names) {
    for (const start of starts) {
      if (!start) continue;
      let dir = start;
      for (let up = 0; up < 5; up++) {
        for (const sub of subs) {
          const candidate = path.join(dir, sub, name);
          if (seen.has(candidate)) continue;
          seen.add(candidate);
          try {
            if (fs.existsSync(candidate)) return candidate;
          } catch {}
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  process.stdout.write(`[icon] NOT FOUND. __dirname=${__dirname} appPath=${app.getAppPath()} cwd=${process.cwd()}\n`);
  return undefined;
}

function createWindow(): void {
  // Crash detection: start dirty; the clean-quit handler flips it to true.
  writeSessionState(false);
  const iconPath = resolveIconPath();
  const appIcon = iconPath ? nativeImage.createFromPath(iconPath) : undefined;
  // Windows draws the TASKBAR button from the icon RESOURCE: it picks the
  // 16/24/32px frame that fits. A nativeImage built from an .ico keeps only
  // the largest frame (256px), so the taskbar button ends up blank or
  // upscaled garbage — passing the .ico PATH lets the shell pick the right
  // frame itself. Elsewhere (mac/linux) the nativeImage is the right form.
  const iconArg: NativeImage | string | undefined =
    process.platform === "win32" && iconPath && iconPath.toLowerCase().endsWith(".ico")
      ? iconPath
      : appIcon && !appIcon.isEmpty()
        ? appIcon
        : iconPath;
  try {
    const bytes = iconPath ? fs.statSync(iconPath).size : 0;
    const sz = appIcon ? appIcon.getSize() : { width: 0, height: 0 };
    process.stdout.write(
      `[icon] picked=${iconPath ?? "NONE"} bytes=${bytes} empty=${appIcon ? appIcon.isEmpty() : "n/a"} size=${sz.width}x${sz.height}\n`
    );
  } catch {}
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: "#1a1c1d",
    show: false,
    title: "Orplex Code — starting server…",
    autoHideMenuBar: true,
    // Orplex logo for the window + taskbar. On Windows an .ico carries the
    // full size range (16–256) so the taskbar renders crisply; PNG elsewhere.
    icon: iconArg,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require() for the bridge
      webviewTag: false,
    },
  });

  if (iconArg) {
    try {
      // On Windows pass the .ico PATH: a nativeImage built from an .ico keeps
      // only the largest frame, so the taskbar button ends up upscaled instead
      // of the crisp 16/24/32px frame the shell would pick from the file.
      mainWindow.setIcon(iconArg as any);
    } catch {}
    // Windows: pin the taskbar identity + icon explicitly so the shell stops
    // showing electron.exe's default icon (needs a real .ico path). The AUMID
    // MUST match the one registered above, otherwise the shell resolves the
    // button through the packaged app's shell registration (stale icon).
    if (process.platform === "win32" && iconPath && /\.ico$/i.test(iconPath)) {
      try {
        mainWindow.setAppDetails({
          appId: APP_ID,
          appIconPath: iconPath,
          appIconIndex: 0,
          relaunchDisplayName: "Orplex Code",
        });
      } catch (err) {
        process.stdout.write(`[icon] setAppDetails failed: ${String((err as Error)?.message || err)}\n`);
      }
    }
  }

  mainWindow.once("ready-to-show", () => {
    // Re-assert the icon after the window exists: Windows sometimes caches
    // the pre-show placeholder icon for the taskbar button.
    if (iconArg) {
      try {
        mainWindow?.setIcon(iconArg);
      } catch {}
    }
    mainWindow?.setTitle("Orplex Code");
    mainWindow?.show();
  });

  // Open target=_blank / window.open in the OS browser, not a new Electron window.
  // Only http(s): anything else (file:, javascript:, custom schemes) is denied.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Navigation guard. setWindowOpenHandler only covers target=_blank and
  // window.open - a plain <a href>, location.assign, or a redirect still
  // navigates the MAIN window, and the preload bridge is attached to whatever
  // that window loads. Without this, any navigation of the main window to a
  // non-localhost origin hands that origin orplexDesktop.terminal.exec, which
  // spawns with shell:true - i.e. any injected script becomes arbitrary code
  // execution. Only our own origin may navigate in place; anything else is
  // either denied or handed to the OS browser.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppOrigin(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    } else if (isLegalPageUrl(url)) {
      // Legal docs open outside the app window (proxy serves them pre-auth).
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  // Same protection for in-page redirects that never emit will-navigate on
  // some paths (window.location on a 3xx), plus a back/forward guard.
  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!isAppOrigin(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    } else if (isLegalPageUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  // Block attaching webviews/frames to arbitrary origins.
  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  // Deny every powerful permission request from the app origin (camera,
  // geolocation, notifications, ...) - the app never asks for any.
  //
  // EXCEPTION: "fileSystem". This is NOT an app-initiated capability probe,
  // it is how a PERSISTED FileSystemDirectoryHandle is re-granted. The
  // Projects sidebar reloads its saved handles from IndexedDB on every launch
  // and calls requestPermission to re-attach them; denying it made every
  // previously-opened project permanently unopenable after a restart — the row
  // stayed in the sidebar and clicking it silently did nothing, because
  // requestPermission resolved "denied" instead of raising the one-click prompt
  // the UI is written around. Granting it re-approves access to a folder the
  // user already picked with the OS picker; it grants no new path access.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "fileSystem");
  });

  // Renderer crash recovery: a gone renderer used to leave a blank window
  // forever. Reload once after a short delay (a boolean guard keeps an
  // endlessly-crashing renderer from spinning a reload loop), or recreate
  // the window if it destroyed itself.
  let rendererRecoveredOnce = false;
  mainWindow.webContents.on("render-process-gone", (_e, details: any) => {
    process.stdout.write(`[main-window] renderer gone: ${details?.reason || "?"}\n`);
    if (quitting || rendererRecoveredOnce) return;
    rendererRecoveredOnce = true;
    setTimeout(() => {
      if (quitting) return;
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.reload();
      } else if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    }, 1500);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    // Normal exit path (window closed while the app keeps running).
    writeSessionState(true);
  });

  mainWindow.loadURL(APP_URL).catch(async (err) => {
    if (!isDev) {
      dialog.showErrorBox("Failed to start", `Could not load ${APP_URL}: ${err?.message || err}`);
      app.quit();
    }
  });

  
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" }, { role: "redo" }, { type: "separator" },
          { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
        ],
      },
      {
        label: "Help",
        submenu: [
          {
            label: "Check for updates",
            click: () => {
              // The renderer owns the download UI (UpdateToast); the menu
              // just kicks a check — results arrive as update-status events.
              void import("./updater").then((m) => m.checkForUpdates(getMainWindow).catch(() => {}));
            },
          },
        ],
      },
    ])
  );
}

app.on("before-quit", () => {
  quitting = true;
  conversationsStore.flush();
});

// === CONVERSATIONS IPC (local-first store bridging) =========================
// The renderer's CRUD calls land here instead of the cloud backend. All
// guarded by handleAppIpc (app origin only) like every other channel.
registerConversationIpc();
function registerConversationIpc(): void {
  handleAppIpc("orplex:conversations:list", () => conversationsStore.list());
  handleAppIpc("orplex:conversations:get", (_e, id: string) =>
    typeof id === "string" ? conversationsStore.get(id) : null
  );
  handleAppIpc(
    "orplex:conversations:save",
    (_e, input: { conversationId?: string | null; workspaceName?: string | null; messages: unknown[] }) => {
      if (!input || !Array.isArray(input.messages)) return { error: "Invalid body" };
      return conversationsStore.save({
        conversationId: input.conversationId ?? null,
        workspaceName: input.workspaceName ?? undefined,
        messages: input.messages as Array<{ role?: unknown; content?: unknown }>,
      });
    }
  );
  handleAppIpc("orplex:conversations:rename", (_e, id: string, title: string) =>
    typeof id === "string" && typeof title === "string"
      ? conversationsStore.rename(id, title)
      : false
  );
  handleAppIpc("orplex:conversations:remove", (_e, id: string) =>
    typeof id === "string" ? conversationsStore.remove(id) : false
  );
  handleAppIpc("orplex:conversations:fork", (_e, id: string) =>
    typeof id === "string" ? conversationsStore.fork(id) : null
  );
  handleAppIpc(
    "orplex:conversations:import",
    (_e, list: Array<{ id?: unknown; title?: unknown; workspaceName?: unknown; createdAt?: unknown; updatedAt?: unknown; messages?: unknown }>) =>
      Array.isArray(list) ? conversationsStore.importAll(list) : { imported: 0, skipped: 0 }
  );
  handleAppIpc("orplex:conversations:flush", () => {
    conversationsStore.flush();
    return true;
  });
}

/** Renderer → OS file manager: reveal a workspace folder (Projects menu).
 * openPath opens the folder itself; the renderer only sends paths it has
 * already registered via /api/agent/workspace-cwd (this device's folders). */
handleAppIpc("orplex:reveal-path", async (_e, path: string) => {
  if (typeof path !== "string" || !/^([A-Za-z]:[\\/]|\/)/.test(path)) return false; // absolute paths only
  try {
    const errMsg = await shell.openPath(path);
    return !errMsg;
  } catch {
    return false;
  }
});

/**
 * Resolve a workspace folder's ABSOLUTE path from its name. The renderer has
 * no path access (File System Access API), and webUtils.getPathForFile can
 * come back empty for a probe file created through a handle — in which case
 * folder-open could not register a cwd and every terminal/verification call
 * failed with "no workspace folder open" while a folder was plainly open.
 * Bounded search of the usual roots (home first — that is where users keep
 * projects); returns "" when nothing matches, never a guess.
 */
handleAppIpc("orplex:path-for-directory", async (_e, name: string) => {
  if (typeof name !== "string" || !name || /[\\/]/.test(name) || name === "." || name === "..") return "";
  try {
    const { readdir, stat } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const roots = [homedir(), app.getPath("documents"), app.getPath("desktop")];
    // Windows fixed drives: users keep projects at drive roots too
    // (live-observed: C:\psd10 was invisible to the old search, so the
    // workspace path came back "" and every agent command was refused with
    // "no workspace folder path is registered"). Cheap: one stat per drive
    // plus its top-level entries.
    if (process.platform === "win32") {
      for (let letter = 67; letter <= 90; letter++) {
        // C..Z — A/B are legacy floppy; skip the drive we run from if listed
        const drive = String.fromCharCode(letter) + ":\\";
        try {
          if (fs.statSync(drive).isDirectory()) roots.push(drive);
        } catch {}
      }
    }
    const isDir = async (p: string) => {
      try {
        return (await stat(p)).isDirectory();
      } catch {
        return false;
      }
    };
    for (const root of roots) {
      const direct = join(root, name);
      if (await isDir(direct)) return direct;
      // One level down covers the common ~/Projects/<repo> and ~/code/<repo> layouts.
      let entries: string[] = [];
      try {
        entries = await readdir(root, { withFileTypes: true }).then((es) =>
          es.filter((e) => e.isDirectory()).map((e) => e.name)
        );
      } catch {
        continue;
      }
      for (const entry of entries) {
        const nested = join(root, entry, name);
        if (await isDir(nested)) return nested;
      }
    }
    return "";
  } catch {
    return "";
  }
});

/**
 * Take over a port held by a stale/zombie listener (Windows + POSIX).
 * Two safety fixes over the old findstr pipeline: `findstr :${port}`
 * substring-matched ":5000" against ":50001" (killing an innocent listener
 * on a superset port), so rows are now parsed in JS with the local address
 * required to END at `:port` (followed by whitespace) AND the row required
 * to be LISTENING. And a kill only happens after the HTTP probe confirms a
 * real listener up (callers may probe too — a blind taskkill is the failure
 * mode being guarded against).
 */
async function killPortListener(port: number): Promise<void> {
  if (!(await probeAnyServer(loopbackProbeUrls(port)))) return;
  const { execSync } = await import("node:child_process");
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano", { encoding: "utf8" });
      // `TCP  <local>  <foreign>  LISTENING  <pid>` — local addr ends at :port.
      const row = new RegExp(`\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
      const pids = new Set<string>();
      for (const line of out.split(/\r?\n/)) {
        const m = row.exec(line);
        if (m && m[1] !== String(process.pid)) pids.add(m[1]);
      }
      // Skip our own PID: this Electron process (or its in-process sockets)
      // must never taskkill'ed out from under itself.
      pids.delete(String(process.pid));
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
        } catch {}
      }
    } else {
      execSync(`lsof -ti tcp:${port} | xargs -r kill -9`, { stdio: "ignore" });
    }
  } catch {}
}

app.on("will-quit", () => {
  // Normal quit: mark the session clean BEFORE children die, so the next
  // boot knows there is nothing to recover. Crash paths never reach this.
  writeSessionState(true);
  // Kill terminal children (exec + serve lanes) first so no zombie holds
  // the workspace ports, then both Next.js children.
  try {
    killAllTerminalChildren();
  } catch {}
  // Kill both Next.js children so no orphaned node process holds the ports.
  killNextChildren(nextProcess, apiProcess);
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && nextProcess) createWindow();
});

app.whenReady().then(async () => {
  // (AppUserModelId handling is at module top, before ready. Reaffirm the
  // same AUMID here so the taskbar identity never falls back to the packaged
  // registration in a dev run.)
  try {
    app.setAppUserModelId(APP_ID);
  } catch {}

  // Second icon-poison sweep: Electron installs the "Electron.lnk" Start Menu
  // shortcut while initializing its toast support, which happens AFTER the
  // module-scope sweep. Without this the dev taskbar button resolves through
  // that shortcut and shows the generic Electron logo again.
  sweepIconPoison();

  // Desktop sign-in: register the orplex:// protocol handler and the IPC
  // the sign-in page uses to start the browser OAuth flow and receive the
  // one-time code back (see electron/auth-desktop.ts).
  registerDesktopAuth(getMainWindow);

  // Orplex logo is wired per-window (BrowserWindow `icon` option below —
  // Windows pulls the taskbar icon from it; .ico preferred for the best
  // taskbar scaling). There is no app-level setIcon in Electron; on macOS
  // the Dock icon comes from the app bundle at packaging time.

  // MCP remote servers: OAuth 2.1 browser flow + Node-side JSON-RPC
  // passthrough (renderer has no Node and remote servers may lack CORS).
  // Gated at the sender like every other channel (handleAppIpc).
  registerMcpIpc(handleAppIpc);

  // On-device terminal: exec streaming + detached serve registry, all in the
  // user's workspace folder (see electron/terminal.ts). terminal:exec spawns
  // with shell:true — gating at the handler is the last line of defence
  // against the sandboxed IPC-capable preview views.
  registerTerminalIpc(getMainWindow, handleAppIpc);

  // Renderer → main: open http(s) links in the OS default browser.
  handleAppIpc("orplex:open-external", (_event, url: string) => {
    if (typeof url === "string") {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // Crash recovery: did the previous session end uncleanly? (read-only —
  // the marker flips to "dirty" in createWindow and "clean" on will-quit.)
  handleAppIpc("orplex:last-session-crashed", () => {
    const state = readLastSessionState();
    return state.clean === false;
  });

  // Update detection: the packaged app's version, so the renderer can show
  // "What's new" exactly once per installed version.
  handleAppIpc("orplex:app-version", () => app.getVersion());

  try {
    // Electron owns BOTH server lifecycles — it always spawns its own Next
    // children and kills them on quit (close window = servers stop). The
    // ports are OURS: the app instance lock above guarantees no second
    // instance races us for them. If a stray/zombie server holds a port from
    // a crashed previous run, take it over cleanly; the user's own processes
    // on OTHER ports are never touched.
    const cloudApi = process.env.ORPLEX_API_URL || "";
    for (const [which, port] of [
      ["ui", UI_PORT],
      ["api", API_PORT],
    ] as const) {
      if (await probeAnyServer(loopbackProbeUrls(port))) {
        process.stdout.write(`[startup] port ${port} (${which}) held by a stale process — taking it over\n`);
        await killPortListener(port);
      }
    }
    await startNextServer("ui");
    if (!cloudApi) await startNextServer("api");
    await waitForServer(APP_PROBES);
    if (!cloudApi) {
      await waitForServer(API_PROBES);
    } else {
      process.stdout.write(`[startup] cloud mode: UI points at ${cloudApi} — no local API spawned\n`);
    }
    // Warm the dev-compile path BEFORE the window opens: dev servers compile
    // modules on first hit, and an in-flight recompile resets connections —
    // which raced the app's first next-auth session fetch (CLIENT_FETCH_ERROR
    // "Failed to fetch"). A warm-up probe pays the compile cost here instead.
    await fetch(APP_URL).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    await fetch(APP_URL).catch(() => {});
    // Real-browser preview sessions persist cookies/storage in userData —
    // clear the special-page restriction so the isolated partition behaves
    // like a normal browser profile.
    await preparePreviewPartition();
  } catch (err) {
    dialog.showErrorBox(
      "Server failed to start",
      `Orplex could not start its internal server.\n\n${(err as Error)?.message || err}`
    );
    app.exit(1);
    return;
  }
  buildMenu();
  createWindow();

  // Tray + native notifications (low-GPU: a static template icon + text
  // balloon, nothing that keeps the UHD 620 busy). Polls the local server's
  // run board summary; fires on transitions only, never per-poll.
  try {
    const { buildTrayWithNotifications } = await import("./tray");
    buildTrayWithNotifications(APP_URL);
  } catch {
    // Tray is cosmetic — never block startup on it.
  }

  // In-app updates (packaged builds only — dev skips silently). The renderer
  // owns all UI via update-status events; the menu's "Check for updates"
  // reuses the same check path.
  try {
    const { registerUpdaterIpc, startUpdateSchedule } = await import("./updater");
    registerUpdaterIpc(getMainWindow, handleAppIpc);
    startUpdateSchedule(getMainWindow);
  } catch {
    // Updates are convenience — never block startup on them.
  }

  // Graceful shutdown (wires the graceful-shutdown doctrine into the
  // Electron teardown): SIGTERM/SIGINT kill the Next children first so no
  // orphaned node process holds the ports, then exit. The Next server
  // process runs its own shutdown path (SIGTERM → cleanup → Prisma
  // disconnect) via src/lib/graceful-shutdown.ts. Implemented inline here
  // because electron/tsconfig.json scopes rootDir to electron/ — importing
  // src modules would break the Electron build.
  const shutdownMain = (signal: string) => {
    try {
      process.stdout.write(`[shutdown] main received ${signal} — stopping children\n`);
      try {
        killAllTerminalChildren();
      } catch {}
      killNextChildren(nextProcess, apiProcess);
      writeSessionState(true);
    } finally {
      app.exit(0);
    }
  };
  process.on("SIGTERM", () => shutdownMain("SIGTERM"));
  process.on("SIGINT", () => shutdownMain("SIGINT"));
});