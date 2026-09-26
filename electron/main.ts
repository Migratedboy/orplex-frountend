/**
 * electron/main.ts — Electron main process for Orplex.
 *
 * Architecture: Electron is a native shell around the REAL Next.js server.
 * The main process spawns `next start` (packaged) or `next dev` (dev) as a
 * child process, waits for it to answer HTTP, then opens a BrowserWindow
 * pointing at http://localhost:PORT. API routes, next-auth, Prisma, SSE and
 * the embedded browser all work unchanged.
 */
import { app, BrowserWindow, shell, Menu, dialog, ipcMain, WebContentsView, session } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const isDev = !app.isPackaged;
const PORT = Number(process.env.ORPLEX_PORT || 5000);
const APP_URL = `http://localhost:${PORT}`;
const LOCAL_DB_PORT = Number(process.env.LOCAL_DB_PORT || 5433);

let nextProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

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
// Dedicated AGENT browser view — the AI's own browsing session, separate from
// the user's tabs (Antigravity-style). Created lazily on first agent tool use.
let agentViewId: number | null = null;
// Per-view console ring buffers (agent observation) — cleared on navigation.
const consoleBuffers = new Map<number, Array<{ level: string; text: string; at: number }>>();
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

async function getAgentView(): Promise<{ id: number; view: WebContentsView }> {
  if (agentViewId === null || !previewViews.has(agentViewId)) {
    const id = previewNextTabId++;
    const view = createPreviewView();
    previewViews.set(id, view);
    agentViewId = id;
  }
  const view = previewViews.get(agentViewId)!;
  return { id: agentViewId, view };
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
}

function normalizePreviewUrl(raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Bare host/localhost/URL-ish input gets https:// (http for localhost)
  if (/^[\w-]+(\.[\w-]+)+(\/|$|:\d)/.test(trimmed)) {
    return /^localhost(:|\/|$)/.test(trimmed) ? `http://${trimmed}` : `https://${trimmed}`;
  }
  return null; // search-engine fallback is handled by the renderer
}

/** Resolve the repo root in dev / resources dir when packaged. */
function projectRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath());
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

/** Start the Next.js server as a child process. */
async function startNextServer(): Promise<void> {
  const runAsNode = {
    ...process.env,
    ELECTRON: "1",
    ELECTRON_RUN_AS_NODE: "1", // make electron.exe behave as plain node for the child
  } as NodeJS.ProcessEnv;

  const wireChild = (child: ChildProcess) => {
    child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[next] ${d}`));
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[next] ${d}`));
    // A spawn failure (ENOENT, EINVAL, permissions) must never kill the main
    // process silently — surface it and exit cleanly.
    child.on("error", (err) => {
      process.stderr.write(`[next] spawn error: ${err?.message || err}\n`);
      if (!quitting) {
        dialog.showErrorBox("Orplex server failed", `Could not launch the internal server: ${err?.message || err}`);
        app.exit(1);
      }
    });
    child.on("exit", (code) => {
      if (!quitting) {
        dialog.showErrorBox(
          "Orplex server exited",
          `The internal server exited unexpectedly (code ${code ?? "?"}).`
        );
        app.quit();
      }
    });
  };

  if (isDev) {
    // Dev: run `next dev` directly with node — no npm.cmd wrapper (spawning
    // .cmd/.bat without a shell is blocked on modern Node and crashes us).
    const nextBin = path.join(projectRoot(), "node_modules", "next", "dist", "bin", "next");
    nextProcess = spawn(process.execPath, [nextBin, "dev", "-p", String(PORT)], {
      cwd: projectRoot(),
      env: runAsNode,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } else {
    // Packaged: run Next's server entry with Electron's bundled Node via
    // ELECTRON_RUN_AS_NODE (no separate node.exe needs to ship).
    const root = projectRoot();
    const nextBin = path.join(root, "app", "node_modules", "next", "dist", "bin", "next");
    nextProcess = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
      cwd: path.join(root, "app"),
      env: { ...runAsNode, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  wireChild(nextProcess);
}

/** Single TCP probe: resolves true if something accepts on 127.0.0.1:port. */
function isPortOpen(port: number, timeout = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Ensure the embedded local Postgres is running (dev cluster in .localpg/).
 * We spawn `next dev` directly — bypassing any npm pre-hooks — so WITHOUT
 * this the app boots with PrismaClientInitializationError and every
 * DB-backed feature (auth, chat, history, quota) fails. The DB is left
 * running on quit: it holds no ports we need back and restarts are cheap.
 */
async function ensureLocalDb(): Promise<void> {
  if (await isPortOpen(LOCAL_DB_PORT)) return;
  const script = path.join(projectRoot(), "scripts", "local-db.mjs");
  // Packaged/remote-DB setups manage their own database — nothing to do.
  if (!fs.existsSync(script)) return;
  process.stdout.write("[db] starting local postgres…\n");
  const child = spawn(process.execPath, [script, "start"], {
    cwd: projectRoot(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[db] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[db] ${d}`));
  const started = Date.now();
  while (!(await isPortOpen(LOCAL_DB_PORT))) {
    if (Date.now() - started > 30000) {
      throw new Error(`Local database did not become ready on port ${LOCAL_DB_PORT}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  process.stdout.write("[db] local postgres is up\n");
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: "#1a1c1d",
    show: false,
    title: "Orplex Tech — starting server…",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require() for the bridge
      webviewTag: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.setTitle("Orplex Tech");
    mainWindow?.show();
  });

  // Open target=_blank / window.open in the OS browser, not a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
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
    ])
  );
}

app.on("before-quit", () => {
  quitting = true;
});

// === PREVIEW IPC (registered once, guarded by partition session) =========
ipcMain.handle("preview:create-tab", () => {
  const tabId = previewNextTabId++;
  previewViews.set(tabId, createPreviewView());
  return tabId;
});

ipcMain.handle("preview:navigate", (_e, tabId: number, rawUrl: string) => {
  const view = previewViews.get(tabId);
  const url = normalizePreviewUrl(rawUrl);
  if (!view || !url) return false;
  showPreviewTab(tabId);
  // Position BEFORE load using the renderer's last-reported viewport rect so
  // the page never paints into a 1×1 view.
  applyBounds(view, lastViewportRect.width > 1 ? lastViewportRect : { x: 0, y: 80, width: 800, height: 600 });
  void view.webContents.loadURL(url);
  process.stdout.write(`[preview] navigate tab=${tabId} url=${url.slice(0, 80)} bounds=${JSON.stringify(view.getBounds())}\n`);
  return true;
});

ipcMain.handle("preview:set-bounds", (_e, tabId: number, rect: { x: number; y: number; width: number; height: number }) => {
  const view = previewViews.get(tabId);
  if (!view) return false;
  // Real rects only (renderer sends 0-sizes while hidden) — cache for navigate.
  if (rect.width > 2 && rect.height > 2) {
    lastViewportRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  applyBounds(view, rect);
  return true;
});

ipcMain.handle("preview:show-tab", (_e, tabId: number | null) => {
  showPreviewTab(tabId);
  return true;
});

// DEV DIAGNOSTIC: dump native-preview state shortly after a tab is created —
// proves the view is attached, visible, sized, and which URL it holds.
ipcMain.handle("preview:diag", () => {
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

ipcMain.handle("preview:close-tab", (_e, tabId: number) => {
  destroyPreviewTab(tabId);
  return true;
});

ipcMain.handle("preview:go-back", (_e, tabId: number) => {
  const view = previewViews.get(tabId);
  if (view?.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack();
  return true;
});

ipcMain.handle("preview:go-forward", (_e, tabId: number) => {
  const view = previewViews.get(tabId);
  if (view?.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward();
  return true;
});

ipcMain.handle("preview:reload", (_e, tabId: number) => {
  previewViews.get(tabId)?.webContents.reload();
  return true;
});

ipcMain.handle("preview:stop", (_e, tabId: number) => {
  previewViews.get(tabId)?.webContents.stop();
  return true;
});

ipcMain.handle("preview:screenshot", async (_e, tabId: number) => {
  const view = previewViews.get(tabId);
  if (!view) return null;
  const image = await view.webContents.capturePage();
  return image.toDataURL();
});

// === AGENT BROWSER IPC — the AI drives a real browser =====================

/** Show the agent's view in the panel (so the user watches it work). */
ipcMain.handle("agent-browser:show", async () => {
  const { id, view } = await getAgentView();
  showPreviewTab(id);
  if (lastViewportRect.width > 2) applyBounds(view, lastViewportRect);
  return id;
});

/** The agent view's id so the renderer can map a tab to it. */
ipcMain.handle("agent-browser:get-id", async () => {
  const { id } = await getAgentView();
  return id;
});

/** Navigate + wait for load. Returns final URL + title. */
ipcMain.handle("agent-browser:navigate", async (_e, rawUrl: string) => {
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
ipcMain.handle("agent-browser:read", async () => {
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
ipcMain.handle("agent-browser:elements", async () => {
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

/** Interact: click / type / press key / scroll, by CSS selector. */
ipcMain.handle("agent-browser:interact", async (_e, action: { kind: string; selector?: string; text?: string; key?: string; amount?: number }) => {
  const { view } = await getAgentView();
  await waitForLoad(view);
  const wc = view.webContents;
  try {
    switch (action.kind) {
      case "click": {
        if (!action.selector) return { ok: false, error: "selector required" };
        const clicked = await executeJs(view, `
          (() => {
            const el = document.querySelector(${JSON.stringify(action.selector)});
            if (!el) return { ok: false, error: 'not found: ${action.selector.replace(/'/g, "")}' };
            el.scrollIntoView({ block: 'center' });
            el.click();
            return { ok: true, clicked: (el.textContent || el.tagName).toString().slice(0, 60) };
          })()
        `);
        await new Promise((r) => setTimeout(r, 600)); // let SPA routing settle
        await waitForLoad(view, 5000);
        return clicked;
      }
      case "type": {
        if (!action.selector || typeof action.text !== "string") return { ok: false, error: "selector + text required" };
        const typed = await executeJs(view, `
          (() => {
            const el = document.querySelector(${JSON.stringify(action.selector)});
            if (!el) return { ok: false, error: 'not found' };
            el.focus();
            el.value = ${JSON.stringify(action.text)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, typed: el.value.slice(0, 60) };
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
ipcMain.handle("agent-browser:console", async () => {
  const { id } = await getAgentView();
  return { ok: true, messages: consoleBuffers.get(id) ?? [] };
});

/** Screenshot of the agent view as data URL. */
ipcMain.handle("agent-browser:screenshot", async () => {
  const { view } = await getAgentView();
  await waitForLoad(view, 8000);
  const image = await view.webContents.capturePage();
  return image.toDataURL();
});

/** Arbitrary read-only JS evaluation in the page context. */
ipcMain.handle("agent-browser:evaluate", async (_e, code: string) => {
  const { view } = await getAgentView();
  await waitForLoad(view);
  try {
    const result = await executeJs(view, code);
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

/** Kill whatever process is listening on the given port (Windows + POSIX). */
async function killPortListener(port: number): Promise<void> {
  const { execSync } = await import("node:child_process");
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: "utf8" });
      const pid = out.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
      }
    } else {
      execSync(`lsof -ti tcp:${port} | xargs -r kill -9`, { stdio: "ignore" });
    }
  } catch {}
}

app.on("will-quit", () => {
  // Kill the Next.js child so no orphaned node process holds the port.
  if (nextProcess && !nextProcess.killed) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(nextProcess.pid), "/T", "/F"]);
      } else {
        nextProcess.kill("SIGTERM");
      }
    } catch {}
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && nextProcess) createWindow();
});

app.whenReady().then(async () => {
  // Renderer → main: open http(s) links in the OS default browser.
  ipcMain.handle("orplex:open-external", (_event, url: string) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });

  try {
    // Electron owns the server lifecycle — it ALWAYS spawns its own Next
    // instance and kills it on quit (close window = server stops). A stray
    // server on the port is ours to take over from a crashed previous run:
    // kill the listener, then start fresh.
    await ensureLocalDb();
    if (await probeServer(APP_URL)) {
      await killPortListener(PORT);
    }
    await startNextServer();
    await waitForServer(APP_URL);
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
});
