/**
 * preview-views.ts — the REAL-BROWSER PREVIEW + AGENT BROWSER lanes.
 *
 * The RightPanel's iframe+proxy preview breaks on JS-heavy pages (X-Frame-
 * Options rewriting has limits, HMR websockets die, SPAs glitch). Inside
 * Electron we can do what Antigravity does: render each preview tab as a
 * REAL Chromium WebContentsView layered above the app, driven over IPC and
 * positioned by the renderer. Each view runs in an isolated
 * `persist:orplex-preview` session — no shared cookies/extensions with the
 * app itself (Antigravity's isolated-profile equivalent).
 *
 * Extracted from electron/main.ts (state + helpers at ~281–538, IPC handlers
 * at ~999–1746). main.ts keeps window ownership, the IPC origin guard
 * (handleAppIpc) and the orplex: workspace handlers; this module owns every
 * preview:* and agent-browser:* channel. Pure decisions live in
 * preview-logic.ts (unit-tested); everything here is WebContentsView wiring
 * moved verbatim.
 */
import { app, BrowserWindow, session, WebContentsView } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_VIEWPORTS,
  clampFixedDelayMs,
  clampWaitTimeoutMs,
  computeBounds,
  filterFindMatches,
  formatConsoleLine,
  MAX_AGENT_TABS,
  navStateOf,
  normalizePreviewUrl,
  resolveRefFromSnapshot,
} from "./preview-logic";
import { safeConsoleWrite } from "./safeio";

const PREVIEW_PARTITION = "persist:orplex-preview";
const previewViews = new Map<number, WebContentsView>(); // renderer tabId -> view
let previewNextTabId = 1; // mirror of the renderer's tab ids (returned on create)
// Floating tabs live in their own window (preview-extras, P5). showPreviewTab
// must never re-add them to the main window while they float.
const floatingTabIds = new Set<number>();
// Private views: non-persistent partition, excluded from history (P5).
const privateTabIds = new Set<number>();

export function getPreviewView(tabId: number): WebContentsView | undefined {
  return previewViews.get(tabId);
}

export function setFloatingTab(tabId: number, floating: boolean): void {
  if (floating) floatingTabIds.add(tabId);
  else floatingTabIds.delete(tabId);
}

export function markPrivateView(tabId: number): void {
  privateTabIds.add(tabId);
}

export function registerPreviewView(tabId: number, view: WebContentsView): void {
  previewViews.set(tabId, view);
}

/** Create-and-register a view on a custom partition (private/profile lanes). */
export function createAndRegisterPreviewView(partition: string): number {
  const tabId = previewNextTabId++;
  const view = createPreviewView(partition);
  previewViews.set(tabId, view);
  return tabId;
}

/**
 * Re-create the view backing `tabId` on a different partition (profile
 * switch): the old view is destroyed and a fresh one takes the SAME renderer
 * tab id so the renderer mapping stays intact (page state resets by design).
 */
export function recreatePreviewViewOn(tabId: number, partition: string): void {
  const existing = previewViews.get(tabId);
  if (existing) {
    try {
      const win = getMainWindow();
      if (win && win.contentView.children.includes(existing)) {
        win.contentView.removeChildView(existing);
      }
    } catch {}
    try {
      (existing.webContents as any).destroy?.();
    } catch {}
  }
  const view = createPreviewView(partition);
  previewViews.set(tabId, view);
}

// === Preview history store (P5: userData/preview-history.json) =============
const HISTORY_CAP = 200;
function historyFilePath(): string {
  return path.join(app.getPath("userData"), "preview-history.json");
}
let historyCache: Array<{ url: string; at: number }> | null = null;
async function readHistoryStore(): Promise<Array<{ url: string; at: number }>> {
  if (historyCache) return historyCache;
  try {
    const raw = await fs.promises.readFile(historyFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    historyCache = Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.url === "string") : [];
  } catch {
    historyCache = [];
  }
  return historyCache;
}
async function writeHistoryStore(entries: Array<{ url: string; at: number }>): Promise<void> {
  historyCache = entries;
  try {
    await fs.promises.mkdir(path.dirname(historyFilePath()), { recursive: true });
    await fs.promises.writeFile(historyFilePath(), JSON.stringify(entries, null, 0), "utf8");
  } catch {}
}
export async function listPreviewHistory(): Promise<Array<{ url: string; at: number }>> {
  return readHistoryStore();
}
export async function clearPreviewHistory(): Promise<void> {
  await writeHistoryStore([]);
}
/** Record a navigation (did-navigate). Skips blanks + private views. */
export function recordPreviewHistory(tabId: number, url: string): void {
  if (!url || url === "about:blank" || privateTabIds.has(tabId)) return;
  void (async () => {
    const entries = await readHistoryStore();
    const last = entries[entries.length - 1];
    if (last?.url === url) return;
    const next = [...entries, { url, at: Date.now() }].slice(-HISTORY_CAP);
    await writeHistoryStore(next);
  })();
}
// Dedicated AGENT browser — the AI's own browsing session, separate from
// the user's tabs (Antigravity-style). Created lazily on first agent tool use;
// supports multiple agent tabs (see agent-browser:tabs).
// Per-view console ring buffers (agent observation) — cleared on navigation.
const consoleBuffers = new Map<number, Array<{ level: string; text: string; at: number }>>();
// === AGENT BROWSER advanced-op state (parity with the server lane) ========
// Agent tabs: preview view ids the agent owns (multi-tab). Refs from the last
// browser_find (stale after navigation/tab switch). Per-view network failure
// telemetry captured over the CDP Network domain.
const agentTabs: number[] = [];
let agentActiveTabIdx = 0;
let agentFindSnapshot: Array<{ selector: string; description: string }> | null = null;
const networkBuffers = new Map<number, Array<{ url: string; method: string; status?: number; error?: string; resourceType?: string; at: number }>>();
// Last viewport rect reported by the renderer — navigate uses this so a view
// NEVER loads stuck at a placeholder size if the post-load bounds sync hiccups.
let lastViewportRect = { x: 0, y: 0, width: 0, height: 0 };
const visiblePreviewTabs = new Set<number>();

// Injected by registerPreviewBrowser — main.ts owns the window and the
// origin-guarded IPC entry point.
let handleAppIpc: (channel: string, handler: (event: any, ...args: any[]) => any) => void;
let getMainWindow: () => BrowserWindow | null;

function applyBounds(view: WebContentsView, rect: { x: number; y: number; width: number; height: number }) {
  view.setBounds(computeBounds(rect));
}

function createPreviewView(partition: string = PREVIEW_PARTITION): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      partition,
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
    // Real nav state (v2 D15): Back/Forward disabled state + omnibox text
    // come from these events, never from drum-beat local state.
    emit("navigated", { url, ...navStateOf(wc.navigationHistory) });
    recordPreviewHistory(viewToId(view), url);
  });
  wc.on("did-navigate-in-page", (_e, url) =>
    emit("navigated", { url, inPage: true, ...navStateOf(wc.navigationHistory) })
  );
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
      const { level, text } = formatConsoleLine(details);
      buf.push({ level, text, at: Date.now() });
    }
    consoleBuffers.set(id, buf);
  });
  wc.on("did-finish-load", () => {
    const b = view.getBounds();
    const myId = [...previewViews.entries()].find(([, v]) => v === view)?.[0];
    safeConsoleWrite(process.stdout, `[preview] did-finish-load url=${wc.getURL().slice(0, 60)} bounds=${JSON.stringify(b)} visible=${myId !== undefined && visiblePreviewTabs.has(myId)}\n`);
  });
  wc.on("render-process-gone", (_e, details) => {
    safeConsoleWrite(process.stdout, `[preview] RENDERER GONE: ${details.reason}\n`);
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
  return resolveRefFromSnapshot(agentFindSnapshot, ref);
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
    // Floating tabs live in their own window — never re-parent them here.
    if (floatingTabIds.has(id)) continue;
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

// === IPC registration ======================================================

/**
 * Register every preview:* and agent-browser:* IPC channel. Called ONCE from
 * main.ts at the same module scope where these handlers used to live inline,
 * so registration order is preserved. `handleAppIpc` is main.ts's
 * origin-guarded ipcMain.handle wrapper (the preview/agent views are
 * sandboxed with no preload — handlers must only answer the app's own
 * origin).
 */
export function registerPreviewBrowser(deps: {
  handleAppIpc: (channel: string, handler: (event: any, ...args: any[]) => any) => void;
  getMainWindow: () => BrowserWindow | null;
}): void {
  handleAppIpc = deps.handleAppIpc;
  getMainWindow = deps.getMainWindow;

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
    safeConsoleWrite(process.stdout, `[preview] navigate tab=${tabId} url=${url.slice(0, 80)} bounds=${JSON.stringify(view.getBounds())}\n`);
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
    safeConsoleWrite(process.stdout, `[preview-diag] children=${children} ${JSON.stringify(views)}\n`);
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
      const matches = filterFindMatches(raw, filter);
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
    const timeout = clampWaitTimeoutMs(args.timeoutMs);
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
        await new Promise((r) => setTimeout(r, clampFixedDelayMs(args.time)));
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

  /** Agent tab management: list / new / switch / close (cap MAX_AGENT_TABS).
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
}

/**
 * One-time partition preparation (called from main.ts's startup exactly where
 * the inline call used to live): real-browser preview sessions persist
 * cookies/storage in userData — clear the special-page restriction so the
 * isolated partition behaves like a normal browser profile.
 */
export async function preparePreviewPartition(): Promise<void> {
  await session.fromPartition(PREVIEW_PARTITION).setPermissionCheckHandler(null);
}
