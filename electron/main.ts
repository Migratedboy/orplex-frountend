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
import { app, BrowserWindow, shell, Menu, dialog, ipcMain, WebContentsView, session, nativeImage } from "electron";
import type { NativeImage } from "electron";
import { isDevRuntime } from "./dev-mode";
import { homedir } from "node:os";
import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { registerMcpIpc } from "./mcp-bridge";
import { registerDesktopAuth, handleDesktopAuthArgv } from "./auth-desktop";
import { registerTerminalIpc, killAllTerminalChildren } from "./terminal";
import { createConversationStore } from "./conversations-store";
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
      };
      if (cfg.apiUrl && !process.env.ORPLEX_API_URL) process.env.ORPLEX_API_URL = cfg.apiUrl;
      if (cfg.lightweight && !process.env.ORPLEX_LIGHTWEIGHT) process.env.ORPLEX_LIGHTWEIGHT = "1";
      return;
    }
  } catch {}
})();

// A branded dev binary (renamed electron.exe with our icon) makes Electron
// report isPackaged=true — ORPLEX_DEV=1 from the dev launcher restores the
// checkout semantics the rest of this file relies on.
const isDev = isDevRuntime();
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

const APP_URL = `http://localhost:${UI_PORT}`;

/**
 * Is this URL our own app?
 *
 * Used by the navigation guards to ensure the main window can only ever host
 * the local Next server. Everything else is refused and (for http/https)
 * handed to the OS browser. Compared against the parsed origin rather than by
 * string prefix, so `http://localhost:3000.evil.com` and
 * `http://evil.com/?x=http://localhost:3000` cannot pass.
 */
function isAppOrigin(raw: string): boolean {
  try {
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
// by AppUserModelId + exe. Set as early as possible so the shell never
// associates this process with electron.exe's default icon.
try {
  app.setAppUserModelId("tech.orplex.app");
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

// === REAL-BROWSER PREVIEW (desktop) ========================================
// The RightPanel's iframe+proxy preview breaks on JS-heavy pages (X-Frame-
// Options rewriting has limits, HMR websockets die, SPAs glitch). Inside
// Electron we can do what Antigravity does: render each preview tab as a
// REAL Chromium WebContentsView layered above the app, driven over IPC and
// positioned by the renderer. Each view runs in an isolated
// `persist:orplex-preview` session — no shared cookies/extensions with the
// app itself (Antigravity's isolated-profile equivalent).
const PREVIEW_PARTITION = "persist:orplex-preview";
const previewViews = new Map<number, WebContentsView>(); // renderer tabId -> view
let previewNextTabId = 1; // mirror of the renderer's tab ids (returned on create)
// Dedicated AGENT browser — the AI's own browsing session, separate from
// the user's tabs (Antigravity-style). Created lazily on first agent tool use;
// supports multiple agent tabs (see agent-browser:tabs).
// Per-view console ring buffers (agent observation) — cleared on navigation.
const consoleBuffers = new Map<number, Array<{ level: string; text: string; at: number }>>();
// === AGENT BROWSER advanced-op state (parity with the server lane) ========
// Agent tabs: preview view ids the agent owns (multi-tab). Refs from the last
// browser_find (stale after navigation/tab switch). Per-view network failure
// telemetry captured over the CDP Network domain.
const MAX_AGENT_TABS = 4;
const AGENT_VIEWPORTS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1280, height: 720 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};
const agentTabs: number[] = [];
let agentActiveTabIdx = 0;
let agentFindSnapshot: Array<{ selector: string; description: string }> | null = null;
const networkBuffers = new Map<number, Array<{ url: string; method: string; status?: number; error?: string; resourceType?: string; at: number }>>();
// Last viewport rect reported by the renderer — navigate uses this so a view
// NEVER loads stuck at a placeholder size if the post-load bounds sync hiccups.
let lastViewportRect = { x: 0, y: 0, width: 0, height: 0 };
const visiblePreviewTabs = new Set<number>();

function applyBounds(view: WebContentsView, rect: { x: number; y: number; width: number; height: number }) {
  view.setBounds({
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  });
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function createPreviewView(): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      partition: PREVIEW_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    // window.open/target=_blank inside a preview page becomes a new PREVIEW
    // tab (like a real browser), not an OS window.
    const win = getMainWindow();
    if (win && /^https?:/i.test(url)) {
      win.webContents.send("preview:event", { type: "window-open", url });
    }
    return { action: "deny" };
  });
  wc.session.setPermissionRequestHandler((_wc, permission, callback) => {
    // Minimal allowlist — clipboard write is useful for previewed apps.
    callback(permission === "clipboard-sanitized-write");
  });

  const emit = (type: string, extra: Record<string, unknown> = {}) => {
    const win = getMainWindow();
    if (win) win.webContents.send("preview:event", { type, viewId: viewToId(view), ...extra });
  };
  wc.on("did-navigate", (_e, url) => {
    consoleBuffers.set(viewToId(view), []); // fresh page → fresh console
    agentFindSnapshot = null; // refs are per-page — stale after any navigation
    emit("navigated", { url });
  });
  wc.on("did-navigate-in-page", (_e, url) => emit("navigated", { url, inPage: true }));
  wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
    // Ignore subresource aborts (err_aborted -3) — only report real failures.
    if (errorCode !== -3) {
      emit("did-fail-load", { errorCode, errorDescription, url: validatedURL });
    }
  });
  wc.on("page-title-updated", (_e, title) => emit("title-updated", { title }));
  wc.on("did-start-loading", () => emit("loading", { loading: true }));
  wc.on("did-stop-loading", () => emit("loading", { loading: false }));
  // Console capture — the agent's eyes on what the page is doing.
  // Electron ≥32 passes a single MessageDetails object.
  wc.on("console-message", (_e, details: any) => {
    const id = viewToId(view);
    const buf = consoleBuffers.get(id) ?? [];
    if (buf.length < 150) {
      const level = String(details?.level ?? "log");
      const line = details?.lineNumber != null ? `:${details.lineNumber}` : "";
      const src = details?.sourceId ? ` (${String(details.sourceId).split("/").pop()}${line})` : "";
      buf.push({ level, text: `${details?.message ?? ""}${src}`, at: Date.now() });
    }
    consoleBuffers.set(id, buf);
  });
  wc.on("did-finish-load", () => {
    const b = view.getBounds();
    const myId = [...previewViews.entries()].find(([, v]) => v === view)?.[0];
    process.stdout.write(`[preview] did-finish-load url=${wc.getURL().slice(0, 60)} bounds=${JSON.stringify(b)} visible=${myId !== undefined && visiblePreviewTabs.has(myId)}\n`);
  });
  wc.on("render-process-gone", (_e, details) => {
    process.stdout.write(`[preview] RENDERER GONE: ${details.reason}\n`);
  });
  return view;
}

function viewToId(view: WebContentsView): number {
  for (const [id, v] of previewViews) if (v === view) return id;
  return -1;
}

// === AGENT BROWSER (the AI's own real browser session) ====================
// A dedicated WebContentsView in the same isolated partition, driven entirely
// by the agent tools over IPC. Mirrors into the preview panel when shown so
// the user can watch the agent work live.

/** The ACTIVE agent tab's view (all agent ops run against it). */
async function getAgentView(): Promise<{ id: number; view: WebContentsView }> {
  if (agentTabs.length === 0) {
    const id = previewNextTabId++;
    const view = createPreviewView();
    previewViews.set(id, view);
    attachAgentNetworkCapture(id, view);
    agentTabs.push(id);
    agentActiveTabIdx = 0;
  }
  const idx = Math.min(agentActiveTabIdx, agentTabs.length - 1);
  const id = agentTabs[idx];
  const view = previewViews.get(id)!;
  return { id, view };
}

/** Resolve a browser_find ref ("e3") to its stored selector, main-side. */
function resolveRefToSelector(ref: string): { selector?: string; error?: string } {
  if (!agentFindSnapshot) return { error: `ref ${ref} is stale — run browser_find again (no find snapshot)` };
  const idx = parseInt(ref.replace(/^e/i, ""), 10) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= agentFindSnapshot.length) {
    return { error: `unknown ref ${ref} — run browser_find again` };
  }
  return { selector: agentFindSnapshot[idx].selector };
}

/** CDP Network-domain capture for one agent view: 4xx/5xx + failed requests.
 * Best-effort — if another debugger is attached, telemetry is simply absent. */
function attachAgentNetworkCapture(viewId: number, view: WebContentsView): void {
  const log: Array<{ url: string; method: string; status?: number; error?: string; resourceType?: string; at: number }> = [];
  networkBuffers.set(viewId, log);
  const pending = new Map<string, { url: string; method: string }>();
  const push = (ev: { url: string; method: string; status?: number; error?: string; resourceType?: string; at: number }) => {
    log.push(ev);
    if (log.length > 60) log.splice(0, log.length - 60); // bounded ring, same cap as the server lane
  };
  try {
    const dbg = view.webContents.debugger;
    dbg.attach("1.3");
    void dbg.sendCommand("Network.enable");
    dbg.on("message", (_event: any, method: string, params: any) => {
      try {
        if (method === "Network.requestWillBeSent") {
          pending.set(params.requestId, { url: String(params.request?.url || "").slice(0, 300), method: String(params.request?.method || "GET") });
        } else if (method === "Network.responseReceived") {
          const status = Number(params.response?.status || 0);
          const req = pending.get(params.requestId);
          pending.delete(params.requestId);
          if (status >= 400) {
            push({ url: String(params.response?.url || req?.url || "").slice(0, 300), method: req?.method || "GET", status, resourceType: String(params.response?.type || ""), at: Date.now() });
          }
        } else if (method === "Network.loadingFailed") {
          const req = pending.get(params.requestId);
          pending.delete(params.requestId);
          // Skip ERR_ABORTED — cancelled subresources/redirects are noise.
          if (req && params.errorText !== "net::ERR_ABORTED") {
            push({ url: req.url, method: req.method, error: String(params.errorText || "request failed").slice(0, 120), resourceType: String(params.type || ""), at: Date.now() });
          }
        }
      } catch {}
    });
    view.webContents.on("did-navigate", () => pending.clear());
  } catch {
    // Another debugger attached or unsupported — everything else keeps working.
  }
}

/** Wait until the view's webContents stops loading (with timeout). */
async function waitForLoad(view: WebContentsView, timeoutMs = 15000): Promise<boolean> {
  const wc = view.webContents;
  if (!wc.isLoading()) return true;
  const start = Date.now();
  while (wc.isLoading() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 120));
  }
  return !wc.isLoading();
}

/** Run JS in the page context. */
async function executeJs(view: WebContentsView, code: string): Promise<any> {
  return view.webContents.executeJavaScript(code, false);
}

/** Attach the requested tab's view and hide all others (tab-switch). */
function showPreviewTab(tabId: number | null): void {
  const win = getMainWindow();
  if (!win) return;
  for (const [id, view] of previewViews) {
    const active = id === tabId;
    if (active) {
      if (!win.contentView.children.includes(view)) {
        win.contentView.addChildView(view);
      }
      // A freshly attached view must be at viewport size immediately,
      // otherwise it paints into a stale 1×1 rect until the next sync.
      if (lastViewportRect.width > 2) applyBounds(view, lastViewportRect);
    }
    if (active) visiblePreviewTabs.add(id);
    else visiblePreviewTabs.delete(id);
    view.setVisible(active);
  }
}

function destroyPreviewTab(tabId: number): void {
  const view = previewViews.get(tabId);
  if (!view) return;
  try {
    (view.webContents as any).destroy?.();
  } catch {}
  previewViews.delete(tabId);
  // consoleBuffers was never deleted here, and previewNextTabId only ever
  // increases, so every closed tab stranded up to 150 {level,text,at} entries
  // (~300KB) for the life of the long-lived main process. networkBuffers IS
  // deleted on close, so the omission was an oversight, not a decision.
  consoleBuffers.delete(tabId);
  visiblePreviewTabs.delete(tabId);
}

function normalizePreviewUrl(raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Bare host/localhost/URL-ish input gets https:// (http for localhost)
  if (/^[\w-]+(\.[\w-]+)+(\/|$|:\d)/.test(trimmed)) {
    return /^localhost(:|\/|$)/.test(trimmed) ? `http://${trimmed}` : `https://${trimmed}`;
  }
  // Not URL-shaped → treat as a web search. The agent browser is a real
  // Chromium client, so Google serves the genuine results UI.
  if (/^[\w\s+.-]{2,120}$/.test(trimmed)) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  }
  return null;
}

/** Resolve the repo root in dev / resources dir when packaged. */
function projectRoot(): string {
  return isDev ? path.join(app.getAppPath()) : process.resourcesPath;
}

/** Health-check: GET / until it answers (any status). */
function waitForServer(url: string, timeoutMs = 45000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      probeServer(url)
        .then((up) => (up ? resolve() : retry()))
        .catch(retry);
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Next.js server did not become ready at ${url}`));
        return;
      }
      setTimeout(attempt, 400);
    };
    attempt();
  });
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

  if (appIcon && !appIcon.isEmpty()) {
    try {
      mainWindow.setIcon(appIcon);
    } catch {}
    // Windows: pin the taskbar identity + icon explicitly so the shell stops
    // showing electron.exe's default icon (needs a real .ico path).
    if (process.platform === "win32" && iconPath && /\.ico$/i.test(iconPath)) {
      try {
        mainWindow.setAppDetails({
          appId: "tech.orplex.app",
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
    }
  });
  // Same protection for in-page redirects that never emit will-navigate on
  // some paths (window.location on a 3xx), plus a back/forward guard.
  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!isAppOrigin(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
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

// === PREVIEW IPC (registered once, guarded by partition session) =========
handleAppIpc("preview:create-tab", () => {
  const tabId = previewNextTabId++;
  previewViews.set(tabId, createPreviewView());
  return tabId;
});

handleAppIpc("preview:navigate", (_e, tabId: number, rawUrl: string) => {
  const view = previewViews.get(tabId);
  // The renderer always sends fully-formed URLs (toNavigateUrl normalizes);
  // accept them verbatim, fall back to normalization for bare hosts.
  const url = /^https?:\/\//i.test(rawUrl || "")
    ? rawUrl.trim()
    : normalizePreviewUrl(rawUrl);
  if (!view || !url) return false;
  showPreviewTab(tabId);
  // Position BEFORE load using the renderer's last-reported viewport rect so
  // the page never paints into a 1×1 view.
  applyBounds(view, lastViewportRect.width > 1 ? lastViewportRect : { x: 0, y: 80, width: 800, height: 600 });
  void view.webContents.loadURL(url);
  process.stdout.write(`[preview] navigate tab=${tabId} url=${url.slice(0, 80)} bounds=${JSON.stringify(view.getBounds())}\n`);
  return true;
});

handleAppIpc("preview:set-bounds", (_e, tabId: number, rect: { x: number; y: number; width: number; height: number }) => {
  const view = previewViews.get(tabId);
  if (!view) return false;
  // Real rects only (renderer sends 0-sizes while hidden) — cache for navigate.
  if (rect.width > 2 && rect.height > 2) {
    lastViewportRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  applyBounds(view, rect);
  return true;
});

handleAppIpc("preview:show-tab", (_e, tabId: number | null) => {
  showPreviewTab(tabId);
  return true;
});

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

// DEV DIAGNOSTIC: dump native-preview state shortly after a tab is created —
// proves the view is attached, visible, sized, and which URL it holds.
handleAppIpc("preview:diag", () => {
  const win = getMainWindow();
  const children = win ? win.contentView.children.length : -1;
  const views = [...previewViews.entries()].map(([id, v]) => ({
    id,
    bounds: v.getBounds(),
    visible: visiblePreviewTabs.has(id),
    url: v.webContents.getURL().slice(0, 60),
    inChildren: win ? win.contentView.children.includes(v) : false,
  }));
  process.stdout.write(`[preview-diag] children=${children} ${JSON.stringify(views)}\n`);
  return { children, views };
});

handleAppIpc("preview:close-tab", (_e, tabId: number) => {
  destroyPreviewTab(tabId);
  return true;
});

handleAppIpc("preview:go-back", (_e, tabId: number) => {
  const view = previewViews.get(tabId);
  if (view?.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack();
  return true;
});

handleAppIpc("preview:go-forward", (_e, tabId: number) => {
  const view = previewViews.get(tabId);
  if (view?.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward();
  return true;
});

handleAppIpc("preview:reload", (_e, tabId: number) => {
  previewViews.get(tabId)?.webContents.reload();
  return true;
});

handleAppIpc("preview:stop", (_e, tabId: number) => {
  previewViews.get(tabId)?.webContents.stop();
  return true;
});

handleAppIpc("preview:screenshot", async (_e, tabId: number) => {
  const view = previewViews.get(tabId);
  if (!view) return null;
  const image = await view.webContents.capturePage();
  return image.toDataURL();
});

// === AGENT BROWSER IPC — the AI drives a real browser =====================

/** Show the ACTIVE agent tab in the panel (so the user watches it work). */
handleAppIpc("agent-browser:show", async () => {
  const { id, view } = await getAgentView();
  showPreviewTab(id);
  if (lastViewportRect.width > 2) applyBounds(view, lastViewportRect);
  return id;
});

/** The agent view's id so the renderer can map a tab to it. */
handleAppIpc("agent-browser:get-id", async () => {
  const { id } = await getAgentView();
  return id;
});

/** Show the agent view (id provided) as the panel's active tab. */
handleAppIpc("agent-browser:show-id", (_e, viewId: number) => {
  if (!previewViews.has(viewId)) return false;
  showPreviewTab(viewId);
  const view = previewViews.get(viewId)!;
  if (lastViewportRect.width > 2) applyBounds(view, lastViewportRect);
  return true;
});

/** Navigate + wait for load. Returns final URL + title. */
handleAppIpc("agent-browser:navigate", async (_e, rawUrl: string) => {
  const url = normalizePreviewUrl(rawUrl);
  if (!url) return { ok: false, error: `Invalid URL: ${rawUrl}` };
  const { view } = await getAgentView();
  try {
    await view.webContents.loadURL(url);
    await waitForLoad(view);
    return {
      ok: true,
      url: view.webContents.getURL(),
      title: await view.webContents.executeJavaScript("document.title", false).catch(() => ""),
    };
  } catch (err: any) {
    // loadURL rejects on some successful-but-odd loads (e.g. aborted
    // subresources); the URL may still have loaded — report real state.
    const settled = await waitForLoad(view, 5000);
    return {
      ok: settled,
      url: view.webContents.getURL(),
      error: settled ? undefined : String(err?.message || err),
    };
  }
});

/** Full page observation: URL, title, visible text, headings, links, buttons, inputs. */
handleAppIpc("agent-browser:read", async () => {
  const { view } = await getAgentView();
  await waitForLoad(view);
  const wc = view.webContents;
  try {
    const info = await wc.executeJavaScript(
      `(() => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n');
        const headings = [...document.querySelectorAll('h1,h2,h3')].filter(vis).slice(0, 20)
          .map(h => h.tagName + ': ' + h.textContent.trim().slice(0, 120));
        const links = [...document.querySelectorAll('a[href]')].filter(vis).slice(0, 40)
          .map(a => (a.textContent || '').trim().slice(0, 80) + ' → ' + a.href);
        const buttons = [...document.querySelectorAll('button,[role=button],input[type=submit],input[type=button]')].filter(vis).slice(0, 30)
          .map(b => (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().slice(0, 80)).filter(Boolean);
        const inputs = [...document.querySelectorAll('input,textarea,select')].filter(vis).slice(0, 25)
          .map(i => ({ tag: i.tagName.toLowerCase(), type: i.type || '', name: i.name || i.id || '', placeholder: i.placeholder || '', value: (i.type === 'password' ? '***' : String(i.value || '').slice(0, 60)) }));
        return { url: location.href, title: document.title, textLength: text.length };
      })()`
    , false);
    // Text separately (large)
    const text = await wc.executeJavaScript("(document.body?.innerText || '').slice(0, 6000)", false);
    return { ok: true, ...info, text, headings: info.headings ?? [] } as any;
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err), url: wc.getURL() };
  }
});

/** Structured elements (links/buttons/inputs) for interaction planning. */
handleAppIpc("agent-browser:elements", async () => {
  const { view } = await getAgentView();
  await waitForLoad(view);
  try {
    return { ok: true, ...(await executeJs(view, `
      (() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const links = [...document.querySelectorAll('a[href]')].filter(vis).slice(0, 40)
          .map((a, i) => ({ i, text: (a.textContent || '').trim().slice(0, 80), href: a.href }));
        const buttons = [...document.querySelectorAll('button,[role=button],input[type=submit],input[type=button]')].filter(vis).slice(0, 30)
          .map((b, i) => ({ i, text: (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().slice(0, 80) }));
        const inputs = [...document.querySelectorAll('input,textarea,select')].filter(vis).slice(0, 25)
          .map((el, i) => ({ i, tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || el.id || '', placeholder: el.placeholder || '' }));
        return { links, buttons, inputs };
      })()
    `)) };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// Selector resolution injected into the page: exact CSS first, then a
// case-insensitive text/aria-label/placeholder/name match. Shared by the
// interact/hover/select handlers so "click the button that says Submit" works
// without the model hunting for exact CSS.
const RESOLVE_FN = `
    function __orplexResolve(sel) {
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
      let el = document.querySelector(sel);
      if (el && vis(el)) return el;
      const needle = sel.replace(/^[#.:\\[\"']|[\"'\\]]$/g, '').trim().toLowerCase();
      const candidates = [...document.querySelectorAll('a,button,[role=button],input,textarea,select,[onclick],label,summary')].filter(vis);
      el = candidates.find(c =>
        (c.getAttribute('aria-label') || '').toLowerCase().includes(needle) ||
        (c.placeholder || '').toLowerCase().includes(needle) ||
        (c.name || c.id || '').toLowerCase().includes(needle) ||
        ((c.innerText || c.textContent || c.value || '').trim().toLowerCase().includes(needle))
      ) || null;
      return el;
    }`;

handleAppIpc("agent-browser:interact", async (_e, action: { kind: string; selector?: string; ref?: string; text?: string; key?: string; amount?: number }) => {
  const { view } = await getAgentView();
  await waitForLoad(view);
  const wc = view.webContents;
  // Ref targeting: browser_find refs resolve to their stored CSS selector
  // (main-side snapshot — same semantics as the server lane).
  let selector = action.selector;
  if (!selector && action.ref) {
    const resolved = resolveRefToSelector(action.ref);
    if (resolved.error) return { ok: false, error: resolved.error };
    selector = resolved.selector;
  }
  try {
    switch (action.kind) {
      case "click": {
        if (!selector) return { ok: false, error: "selector (or ref) required" };
        const clicked = await executeJs(view, `
          (() => {
            ${RESOLVE_FN}
            const el = __orplexResolve(${JSON.stringify(selector)});
            if (!el) return { ok: false, error: ${JSON.stringify("not found: " + String(selector))} };
            el.scrollIntoView({ block: 'center' });
            // Realistic event sequence (React/SPA frameworks listen for these)
            const r = el.getBoundingClientRect();
            const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
            el.dispatchEvent(new PointerEvent('pointerdown', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new PointerEvent('pointerup', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.click();
            return { ok: true, clicked: ((el.innerText || el.textContent || el.value || el.tagName) + '').trim().slice(0, 60) };
          })()
        `);
        await new Promise((r) => setTimeout(r, 600)); // let SPA routing settle
        await waitForLoad(view, 5000);
        return clicked;
      }
      case "type": {
        if (!selector || typeof action.text !== "string") return { ok: false, error: "selector (or ref) + text required" };
        const typed = await executeJs(view, `
          (() => {
            ${RESOLVE_FN}
            const el = __orplexResolve(${JSON.stringify(selector)});
            if (!el) return { ok: false, error: 'not found' };
            el.scrollIntoView({ block: 'center' });
            el.focus();
            // Native value setter: React's controlled inputs ignore direct
            // value assignment, but honor the prototype setter + input event.
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, ${JSON.stringify(action.text)});
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, typed: (el.value || '').slice(0, 60) };
          })()
        `);
        return typed;
      }
      case "press": {
        // Real key event for cases JS .click() can't reach (Enter submits forms)
        if (action.key === "Enter") {
          wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
          wc.sendInputEvent({ type: "char", keyCode: "\\r" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
        } else if (action.key) {
          wc.sendInputEvent({ type: "keyDown", keyCode: action.key });
          wc.sendInputEvent({ type: "keyUp", keyCode: action.key });
        }
        await new Promise((r) => setTimeout(r, 400));
        await waitForLoad(view, 5000);
        return { ok: true, pressed: action.key };
      }
      case "scroll": {
        const amount = typeof action.amount === "number" ? action.amount : 600;
        await executeJs(view, `window.scrollBy(0, ${amount})`);
        return { ok: true, scrolled: amount };
      }
      default:
        return { ok: false, error: `unknown action kind: ${action.kind}` };
    }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

/** Console messages since last navigation (errors/warnings/logs). */
handleAppIpc("agent-browser:console", async () => {
  const { id } = await getAgentView();
  return { ok: true, messages: consoleBuffers.get(id) ?? [] };
});

/** Screenshot of the agent view as data URL. */
handleAppIpc("agent-browser:screenshot", async () => {
  const { view } = await getAgentView();
  await waitForLoad(view, 8000);
  const image = await view.webContents.capturePage();
  return image.toDataURL();
});

/** Arbitrary read-only JS evaluation in the page context. */
handleAppIpc("agent-browser:evaluate", async (_e, code: string) => {
  const { view } = await getAgentView();
  await waitForLoad(view);
  try {
    const result = await executeJs(view, code);
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// === AGENT BROWSER advanced ops (parity with the server lane) ============

/** Page-side discovery script: visible actionable elements with roles, names,
 * and STABLE selectors (id / data-testid / nth-of-type path). Shared by
 * agent-browser:find. Mirrors the server lane's findElements. */
const FIND_SCRIPT = `
  (() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const cssPath = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      const dt = el.getAttribute('data-testid');
      if (dt) return '[data-testid="' + dt + '"]';
      const parts = [];
      let cur = el;
      for (let depth = 0; cur && depth < 4 && cur !== document.body; depth++) {
        const tag = cur.tagName.toLowerCase();
        const parent = cur.parentElement;
        if (parent) {
          const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
          const idx = same.indexOf(cur) + 1;
          parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + idx + ')' : tag);
        } else parts.unshift(tag);
        cur = parent;
      }
      return parts.join(' > ');
    };
    const roleOf = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.getAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input' || tag === 'textarea' || el.isContentEditable) return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'summary') return 'button';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return tag;
    };
    const nameOf = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        const lbl = document.getElementById(labelledby);
        if (lbl) return (lbl.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const labels = el.labels;
        if (labels && labels[0]) return (labels[0].textContent || '').trim().slice(0, 120);
        return el.placeholder || el.name || el.value || '';
      }
      if (el instanceof HTMLSelectElement) {
        const labels = el.labels;
        if (labels && labels[0]) return (labels[0].textContent || '').trim().slice(0, 120);
        return el.name || '';
      }
      return (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
    };
    const els = [...document.querySelectorAll('a[href], button, input, textarea, select, [role], summary, [contenteditable="true"], [onclick]')];
    const out = [];
    for (const el of els.slice(0, 400)) {
      if (!vis(el)) continue;
      if (out.length >= 40) break;
      out.push({ role: roleOf(el), name: nameOf(el), selector: cssPath(el), enabled: !el.disabled });
    }
    return out;
  })()`;

/** Discover actionable elements; stores refs e1..eN for click/type/hover/select. */
handleAppIpc("agent-browser:find", async (_e, filter: { text?: string; role?: string } = {}) => {
  const { view } = await getAgentView();
  await waitForLoad(view);
  try {
    const raw = (await executeJs(view, FIND_SCRIPT)) as Array<{ role: string; name: string; selector: string; enabled: boolean }>;
    const needle = (filter.text || "").toLowerCase();
    const matches = raw
      .filter((c) => (filter.role ? c.role === filter.role : true))
      .filter((c) => (needle ? (c.name || "").toLowerCase().includes(needle) || c.selector.toLowerCase().includes(needle) : true))
      .slice(0, 40);
    agentFindSnapshot = matches.map((m) => ({ selector: m.selector, description: `${m.role} "${m.name}"` }));
    return {
      ok: true,
      matches: matches.map((m, i) => ({ ref: `e${i + 1}`, ...m })),
      total: raw.length,
      hint: matches.length
        ? "click/type/hover/select with ref=eN (or the selector). Refs come from THIS list — run find again after navigation."
        : "no visible matches — try a shorter text filter, or browser_read to inspect the page",
    };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

/** Wait for text to appear / a selector to become visible / a fixed delay. */
handleAppIpc("agent-browser:wait-for", async (_e, args: { text?: string; selector?: string; time?: number; timeoutMs?: number } = {}) => {
  const { view } = await getAgentView();
  const started = Date.now();
  const timeout = Math.min(Math.max(Number(args.timeoutMs) || 10000, 500), 15000);
  try {
    if (args.selector) {
      const ok = await executeJs(
        view,
        `(() => new Promise((resolve) => {
          const sel = ${JSON.stringify(args.selector)};
          const deadline = Date.now() + ${timeout};
          const tick = () => {
            const el = document.querySelector(sel);
            if (el && el.getBoundingClientRect().width > 0) return resolve({ ok: true });
            if (Date.now() >= deadline) return resolve({ ok: false, error: 'timeout waiting for selector' });
            setTimeout(tick, 120);
          };
          tick();
        }))()`
      );
      if (!ok?.ok) throw new Error(`timed out after ${timeout}ms waiting for selector "${args.selector}"`);
    } else if (args.text !== undefined) {
      const ok = await executeJs(
        view,
        `(() => new Promise((resolve) => {
          const needle = ${JSON.stringify(String(args.text).toLowerCase())};
          const deadline = Date.now() + ${timeout};
          const tick = () => {
            const hit = (document.body?.innerText || '').toLowerCase().includes(needle);
            if (hit) return resolve({ ok: true });
            if (Date.now() >= deadline) return resolve({ ok: false, error: 'timeout waiting for text' });
            setTimeout(tick, 120);
          };
          tick();
        }))()`
      );
      if (!ok?.ok) throw new Error(`timed out after ${timeout}ms waiting for text "${args.text}"`);
    } else {
      await new Promise((r) => setTimeout(r, Math.min(Math.max(Number(args.time) || 1000, 100), 10000)));
    }
    const wc = view.webContents;
    return { ok: true, waitedMs: Date.now() - started, url: wc.getURL(), title: await wc.executeJavaScript("document.title", false).catch(() => "") };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

/** Hover an element (selector or find-ref) — triggers menus/tooltips. */
handleAppIpc("agent-browser:hover", async (_e, args: { selector?: string; ref?: string } = {}) => {
  const { view } = await getAgentView();
  await waitForLoad(view);
  let selector = args.selector;
  if (!selector && args.ref) {
    const resolved = resolveRefToSelector(args.ref);
    if (resolved.error) return { ok: false, error: resolved.error };
    selector = resolved.selector;
  }
  if (!selector) return { ok: false, error: "selector (or ref) required" };
  try {
    const r = await executeJs(
      view,
      `(() => {
        ${RESOLVE_FN}
        const el = __orplexResolve(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'not found: ${String(selector).replace(/'/g, "")}' };
        el.scrollIntoView({ block: 'center' });
        const rct = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, clientX: rct.left + rct.width / 2, clientY: rct.top + rct.height / 2 };
        el.dispatchEvent(new MouseEvent('mouseover', opts));
        el.dispatchEvent(new MouseEvent('mouseenter', opts));
        el.dispatchEvent(new MouseEvent('mousemove', opts));
        return { ok: true, hovered: ((el.innerText || el.textContent || el.getAttribute('aria-label') || el.tagName) + '').trim().slice(0, 60) };
      })()`
    );
    await new Promise((res) => setTimeout(res, 300)); // reveal-on-hover UI settles
    return r;
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

/** Select an <option> in a <select> (value or visible label). */
handleAppIpc("agent-browser:select", async (_e, args: { selector?: string; ref?: string; value?: string } = {}) => {
  const { view } = await getAgentView();
  await waitForLoad(view);
  let selector = args.selector;
  if (!selector && args.ref) {
    const resolved = resolveRefToSelector(args.ref);
    if (resolved.error) return { ok: false, error: resolved.error };
    selector = resolved.selector;
  }
  if (!selector || args.value === undefined) return { ok: false, error: "value required, plus selector or ref" };
  try {
    const r = await executeJs(
      view,
      `(() => {
        ${RESOLVE_FN}
        const el = __orplexResolve(${JSON.stringify(selector)});
        if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'no <select> matches: ${String(selector).replace(/'/g, "")}' };
        const want = ${JSON.stringify(args.value)};
        let opt = [...el.options].find((o) => o.value === want) || [...el.options].find((o) => (o.textContent || '').trim().toLowerCase() === want.toLowerCase());
        if (!opt) {
          const partial = [...el.options].find((o) => (o.textContent || '').toLowerCase().includes(want.toLowerCase()));
          if (partial) opt = partial;
        }
        if (!opt) return { ok: false, error: 'no option "' + want + '" — options: ' + [...el.options].slice(0, 10).map((o) => o.value || o.textContent).join(', ') };
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, selected: opt.value, label: (opt.textContent || '').trim().slice(0, 80) };
      })()`
    );
    return r;
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

/** Agent tab management: list / new / switch / close (cap ${"MAX_AGENT_TABS"}).
 * All ops act on the ACTIVE tab set; every tab has console + network capture. */
handleAppIpc("agent-browser:tabs", async (_e, args: { action?: string; url?: string; index?: number } = {}) => {
  const action = args.action || "list";
  const summarize = async () => {
    const out: Array<{ index: number; url: string; title: string; active: boolean }> = [];
    for (let i = 0; i < agentTabs.length; i++) {
      const v = previewViews.get(agentTabs[i]);
      if (!v) continue;
      out.push({
        index: i,
        url: v.webContents.getURL().slice(0, 200),
        title: await v.webContents.executeJavaScript("document.title", false).catch(() => ""),
        active: i === agentActiveTabIdx,
      });
    }
    return out;
  };
  try {
    if (action === "list") {
      return { ok: true, tabs: await summarize() };
    }
    if (action === "new") {
      if (agentTabs.length >= MAX_AGENT_TABS) {
        return { ok: false, error: `tab limit reached (${MAX_AGENT_TABS}) — close one first with tab_action "close"` };
      }
      const id = previewNextTabId++;
      const view = createPreviewView();
      previewViews.set(id, view);
      attachAgentNetworkCapture(id, view);
      agentTabs.push(id);
      agentActiveTabIdx = agentTabs.length - 1;
      agentFindSnapshot = null;
      if (args.url) {
        const url = normalizePreviewUrl(args.url);
        if (!url) return { ok: false, error: `Invalid URL: ${args.url}` };
        await view.webContents.loadURL(url).catch((err: any) => {
          throw new Error(`navigation failed in new tab: ${String(err?.message || err).slice(0, 200)}`);
        });
        await waitForLoad(view);
      }
      return { ok: true, opened: agentActiveTabIdx, url: view.webContents.getURL(), title: await view.webContents.executeJavaScript("document.title", false).catch(() => ""), tabs: await summarize() };
    }
    if (action === "switch") {
      const idx = Number(args.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= agentTabs.length || !previewViews.has(agentTabs[idx])) {
        return { ok: false, error: `no agent tab at index ${idx} — call tabs (list) to see open tabs` };
      }
      agentActiveTabIdx = idx;
      agentFindSnapshot = null; // refs belong to the previous tab's page
      const view = previewViews.get(agentTabs[idx])!;
      return { ok: true, switchedTo: idx, url: view.webContents.getURL(), title: await view.webContents.executeJavaScript("document.title", false).catch(() => ""), tabs: await summarize() };
    }
    if (action === "close") {
      const idx = Number(args.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= agentTabs.length || !previewViews.has(agentTabs[idx])) {
        return { ok: false, error: `no agent tab at index ${idx} — call tabs (list) to see open tabs` };
      }
      if (agentTabs.length <= 1) {
        return { ok: false, error: "cannot close the last tab" };
      }
      const [closedId] = agentTabs.splice(idx, 1);
      destroyPreviewTab(closedId);
      networkBuffers.delete(closedId);
      if (agentActiveTabIdx >= agentTabs.length) agentActiveTabIdx = agentTabs.length - 1;
      if (agentActiveTabIdx > idx) agentActiveTabIdx--;
      agentFindSnapshot = null;
      return { ok: true, closed: idx, tabs: await summarize() };
    }
    return { ok: false, error: `unknown tab action "${action}" — use list | new | switch | close` };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

/** Failed requests (HTTP 4xx/5xx + aborted) since session start, active tab. */
handleAppIpc("agent-browser:network", async () => {
  const { id } = await getAgentView();
  const events = networkBuffers.get(id) ?? [];
  return {
    ok: true,
    failedRequests: events.length,
    failed4xx5xx: events.filter((e) => e.status && e.status >= 400).length,
    aborted: events.filter((e) => e.error).length,
    events: events.slice(-30),
    hint: events.length
      ? "4xx/5xx and aborted requests since session start (newest last). Investigate the failing URL or check browser_console."
      : "No failed requests (no 4xx/5xx responses, no aborted requests).",
  };
});

/** Screenshot with optional fullPage + named viewport (desktop/tablet/mobile). */
handleAppIpc("agent-browser:screenshot-advanced", async (_e, args: { fullPage?: boolean; viewpoint?: string } = {}) => {
  const { view } = await getAgentView();
  await waitForLoad(view, 8000);
  const wc = view.webContents;
  let appliedViewport: { width: number; height: number } | undefined;
  if (args.viewpoint && AGENT_VIEWPORTS[args.viewpoint]) {
    appliedViewport = AGENT_VIEWPORTS[args.viewpoint];
    await wc.executeJavaScript(`window.resizeTo(${appliedViewport.width}, ${appliedViewport.height})`, false).catch(() => {});
    // resizeTo is often ignored for WebContentsView; fall back to setBounds
    // (the view IS the viewport) and give responsive layouts a beat to settle.
    const b = view.getBounds();
    if (b.width !== appliedViewport.width || b.height !== appliedViewport.height) {
      view.setBounds({ x: b.x, y: b.y, width: appliedViewport.width, height: appliedViewport.height });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const image = await wc.capturePage();
  let dataUrl = image.toDataURL();
  if (args.fullPage) {
    // Single-capture full page: grow the view to the full scroll height,
    // capture once, restore. Cleaner and artifact-free vs scroll-stitching.
    const b = view.getBounds();
    try {
      const dims = await wc.executeJavaScript("({ h: document.documentElement.scrollHeight, vh: window.innerHeight })", false);
      if (dims && dims.h > dims.vh + 4 && dims.h <= 8000) {
        view.setBounds({ x: b.x, y: b.y, width: b.width, height: dims.h });
        await new Promise((r) => setTimeout(r, 300)); // reflow + paint
        dataUrl = (await wc.capturePage()).toDataURL();
      }
    } catch {
      // fullPage best-effort — the viewport capture above is already in hand
    } finally {
      view.setBounds(b); // always restore
    }
  }
  return {
    screenshot: dataUrl,
    url: wc.getURL(),
    fullPage: !!args.fullPage,
    ...(appliedViewport ? { viewport: appliedViewport } : {}),
  };
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
  if (!(await probeServer(`http://localhost:${port}`))) return;
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
  for (const child of [nextProcess, apiProcess]) {
    if (child && !child.killed) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        } else {
          child.kill("SIGTERM");
        }
      } catch {}
    }
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && nextProcess) createWindow();
});

app.whenReady().then(async () => {
  // (AppUserModelId is set at module top, before ready — kept here as a
  // no-op-safe reaffirm for the packaged appId parity.)
  try {
    app.setAppUserModelId("tech.orplex.app");
  } catch {}

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
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
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
      if (await probeServer(`http://localhost:${port}`)) {
        process.stdout.write(`[startup] port ${port} (${which}) held by a stale process — taking it over\n`);
        await killPortListener(port);
      }
    }
    await startNextServer("ui");
    if (!cloudApi) await startNextServer("api");
    await waitForServer(APP_URL);
    if (!cloudApi) {
      await waitForServer(`http://localhost:${API_PORT}`);
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
    await session.fromPartition(PREVIEW_PARTITION).setPermissionCheckHandler(null);
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
      for (const child of [nextProcess, apiProcess]) {
        if (child && !child.killed) {
          try {
            if (process.platform === "win32") {
              spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
            } else {
              child.kill("SIGTERM");
            }
          } catch {}
        }
      }
      writeSessionState(true);
    } finally {
      app.exit(0);
    }
  };
  process.on("SIGTERM", () => shutdownMain("SIGTERM"));
  process.on("SIGINT", () => shutdownMain("SIGINT"));
});