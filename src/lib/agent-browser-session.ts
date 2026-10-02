// agent-browser-session.ts — Server-side persistent browser sessions for the
// agent's browser_* tools ("browser as a first-class sensor").
//
// Previously the browser tools only worked inside the Electron desktop shell
// (window.orplexDesktop.agentBrowser). This module gives every agent — plain
// browser client runs via /api/agent/browser, and server-executed runs via a
// direct import — a real persistent page to navigate, read, and adapt with
// mid-task.
//
// Guardrails (inherited from the verification harness's discipline):
//  - EVERY navigation passes checkUrlPolicy (SSRF: link-local / metadata /
//    CGNAT denied), enforced again at the network layer via route interception
//  - Ephemeral profiles only — the user's real cookies/extensions never load
//  - Hard caps: MAX_SESSIONS concurrent, IDLE_REAP_MS reaping, bounded reads,
//    bounded console/network logs, MAX_TABS pages per session

// Dynamic import convention (mirrors browser-verification): Playwright is an
// optional dependency — typed as `any` via narrow local interfaces.
interface PWLocator {
  first(): PWLocator;
  click(opts?: Record<string, unknown>): Promise<void>;
  fill(text: string, opts?: Record<string, unknown>): Promise<void>;
  hover(opts?: Record<string, unknown>): Promise<void>;
  selectOption(value: string, opts?: Record<string, unknown>): Promise<void>;
  waitFor(opts?: Record<string, unknown>): Promise<void>;
  count(): Promise<number>;
}
interface PWPage {
  url(): string;
  title(): Promise<string>;
  isClosed?(): boolean;
  goto(url: string, opts?: Record<string, unknown>): Promise<{ status(): number } | null>;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state?: string): Promise<void>;
  waitForSelector(sel: string, opts?: Record<string, unknown>): Promise<unknown>;
  getByText(text: string, opts?: Record<string, unknown>): { first(): PWLocator };
  getByRole(role: string, opts?: Record<string, unknown>): { first(): PWLocator };
  locator(sel: string): PWLocator;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  mouse: { wheel(dx: number, dy: number): Promise<void> };
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T>(expression: string): Promise<T>;
  on(event: string, cb: (arg: any) => void): void;
  close(): Promise<void>;
}
interface PWContext {
  newPage(): Promise<PWPage>;
  pages(): PWPage[];
  route(pattern: string, cb: (route: any) => void): Promise<void>;
  close(): Promise<void>;
}
interface PWBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PWContext>;
  close(): Promise<void>;
}

import { checkUrlPolicy, isInstalledChromeAvailable } from "./browser-verification";

const MAX_SESSIONS = 3;
const IDLE_REAP_MS = 5 * 60_000;
const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;
const MAX_READ_CHARS = 20_000;
const MAX_CONSOLE_LINES = 100;
const REAP_SWEEP_MS = 60_000;
const MAX_TABS = 4;
const MAX_FIND_RESULTS = 40;
const MAX_NETWORK_EVENTS = 60;
const VIEWPORTS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1280, height: 720 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

export interface NetworkEvent {
  url: string;
  method: string;
  status?: number;
  error?: string;
  resourceType?: string;
  at: number;
}

/** Bounded append for the session network log (newest kept, oldest dropped). */
export function pushNetworkEvent(log: NetworkEvent[], ev: NetworkEvent): void {
  log.push(ev);
  if (log.length > MAX_NETWORK_EVENTS) {
    log.splice(0, log.length - MAX_NETWORK_EVENTS);
  }
}

export interface FindCandidate {
  role: string;
  name: string;
  selector: string;
  enabled: boolean;
}

/**
 * Resolve a `browser_find` ref ("e3") to its stored CSS selector.
 * Returns null when the ref is unknown or no find snapshot exists — callers
 * turn that into an actionable "run browser_find again" error.
 */
export function resolveRefSelector(
  lastFind: Array<{ selector: string; description: string }> | null,
  ref: string
): string | null {
  if (!lastFind || !ref) return null;
  const idx = parseInt(ref.replace(/^e/i, ""), 10) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= lastFind.length) return null;
  return lastFind[idx].selector || null;
}

/**
 * Evaluate attempts for browser_evaluate, in order: a bare expression first,
 * then the same code wrapped as an IIFE so multi-statement snippets
 * ("const x = …; …") work without the model needing to know the protocol.
 */
export function evaluateAttempts(code: string): Array<{ mode: "direct" | "wrapped"; code: string }> {
  const trimmed = code.trim();
  const attempts: Array<{ mode: "direct" | "wrapped"; code: string }> = [{ mode: "direct", code: trimmed }];
  const wrapped = `(() => { ${trimmed} })()`;
  if (wrapped !== trimmed) attempts.push({ mode: "wrapped", code: wrapped });
  return attempts;
}

interface AgentBrowserSession {
  id: string;
  userId: string;
  browser: PWBrowser | null; // null for persistent contexts
  context: PWContext;
  pages: PWPage[]; // open tabs; pages[active] is the one the tools act on
  active: number;
  consoleLog: Array<{ type: string; text: string; at: number }>;
  networkLog: NetworkEvent[];
  lastFind: Array<{ selector: string; description: string }> | null;
  lastUsedAt: number;
  createdAt: number;
  closing: boolean;
}

const sessions = new Map<string, AgentBrowserSession>();
let reapTimer: ReturnType<typeof setInterval> | null = null;

function sessionKey(userId: string, sessionId?: string): string {
  return sessionId || userId; // one default session per user
}

function activePage(s: AgentBrowserSession): PWPage {
  return s.pages[s.active] || s.pages[0];
}

function startReaper(): void {
  if (reapTimer) return;
  reapTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) {
      if (now - s.lastUsedAt > IDLE_REAP_MS) {
        void closeSession(key);
      }
    }
  }, REAP_SWEEP_MS);
  reapTimer.unref?.();
}

async function closeSession(key: string): Promise<void> {
  const s = sessions.get(key);
  if (!s || s.closing) return;
  s.closing = true;
  sessions.delete(key);
  try {
    await s.context.close().catch(() => {});
    await s.browser?.close().catch(() => {});
  } catch {}
}

async function getOrCreateSession(userId: string, sessionId?: string): Promise<AgentBrowserSession> {
  const key = sessionKey(userId, sessionId);
  const existing = sessions.get(key);
  if (existing && !existing.closing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  if (existing?.closing) await closeSession(key);

  // Session cap — the agent (or an attacker) cannot fork unlimited browsers.
  if (sessions.size >= MAX_SESSIONS) {
    // Reap the most-idle session to make room.
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (oldest) await closeSession(oldest[0]);
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error(`browser session limit reached (${MAX_SESSIONS})`);
    }
  }

  startReaper();

  const { chromium } = await import("playwright");
  const useChrome = await isInstalledChromeAvailable().catch(() => false);
  const { mkdtemp } = await import("fs/promises");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const profileDir = await mkdtemp(join(tmpdir(), "orplex-agent-browser-"));
  const chromiumAny = chromium as any;

  if (useChrome) {
    // Installed Chrome via persistent context (Playwright constraint: channel
    // launches require persistent contexts). Fresh throwaway profile.
    const context = (await chromiumAny.launchPersistentContext(profileDir, {
      headless: true,
      channel: "chrome",
      timeout: NAV_TIMEOUT_MS,
    })) as PWContext;
    const page = context.pages()[0] ?? (await context.newPage());
    const session: AgentBrowserSession = {
      id: key,
      userId,
      browser: null,
      context,
      pages: [page],
      active: 0,
      consoleLog: [],
      networkLog: [],
      lastFind: null,
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
      closing: false,
    };
    await attachGuards(session);
    sessions.set(key, session);
    return session;
  }

  const browser = (await chromiumAny.launch({ headless: true })) as PWBrowser;
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const session: AgentBrowserSession = {
    id: key,
    userId,
    browser,
    context,
    pages: [],
    active: 0,
    consoleLog: [],
    networkLog: [],
    lastFind: null,
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
    closing: false,
  };
  const page = await context.newPage();
  session.pages = [page];
  await attachGuards(session);
  sessions.set(key, session);
  return session;
}

/** SSRF enforcement at the network layer: every request any tab makes. */
async function attachGuards(s: AgentBrowserSession): Promise<void> {
  await s.context.route("**/*", (route: any) => {
    const verdict = checkUrlPolicy(route.request().url());
    if (verdict.allowed) return route.continue();
    return route.abort("blockedbyclient");
  });
  for (const page of s.context.pages()) attachPageListeners(s, page);
}

/** Per-page console/pageerror/network capture (every tab, attach on create). */
function attachPageListeners(s: AgentBrowserSession, page: PWPage): void {
  page.on("console", (msg: any) => {
    s.consoleLog.push({ type: String(msg.type()), text: String(msg.text()).slice(0, 500), at: Date.now() });
    if (s.consoleLog.length > MAX_CONSOLE_LINES * 2) {
      s.consoleLog.splice(0, s.consoleLog.length - MAX_CONSOLE_LINES);
    }
  });
  page.on("pageerror", (err: any) => {
    s.consoleLog.push({ type: "error", text: `[PageError] ${String(err?.message || err).slice(0, 500)}`, at: Date.now() });
  });
  // Failed responses (4xx/5xx) and aborted requests — the model sees them via
  // browser_network instead of staring at a blank page wondering why.
  page.on("response", (resp: any) => {
    try {
      const status = typeof resp.status === "function" ? resp.status() : 0;
      if (status >= 400) {
        pushNetworkEvent(s.networkLog, {
          url: String(resp.url()).slice(0, 300),
          method: String(resp.request?.()?.method?.() || "GET"),
          status,
          resourceType: String(resp.request?.()?.resourceType?.() || ""),
          at: Date.now(),
        });
      }
    } catch {}
  });
  page.on("requestfailed", (req: any) => {
    try {
      pushNetworkEvent(s.networkLog, {
        url: String(req.url()).slice(0, 300),
        method: String(req.method?.() || "GET"),
        error: String(req.failure?.()?.errorText || "request failed").slice(0, 120),
        resourceType: String(req.resourceType?.() || ""),
        at: Date.now(),
      });
    } catch {}
  });
}

export interface BrowserOpResult {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

/** Extract bounded page sensor data: URL, title, text, headings, interactives. */
async function readPage(s: AgentBrowserSession): Promise<Record<string, unknown>> {
  const page = activePage(s);
  const url = page.url();
  const title = await page.title().catch(() => "");
  const body = await page
    .evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 12000);
      const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
        .slice(0, 15)
        .map((h) => `${h.tagName.toLowerCase()}: ${(h.textContent || "").trim().slice(0, 120)}`);
      const interactives = Array.from(
        document.querySelectorAll('a[href], button, input, textarea, select, [role="button"]')
      )
        .slice(0, 30)
        .map((el, i) => {
          const tag = el.tagName.toLowerCase();
          const label = ((el as HTMLElement).innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "")
            .trim()
            .slice(0, 80);
          const href = tag === "a" ? (el as HTMLAnchorElement).href : undefined;
          const selector =
            el.id ? `#${el.id}` : el.getAttribute("data-testid") ? `[data-testid="${el.getAttribute("data-testid")}"]` : `${tag}:nth-of-type(${i + 1})`;
          return href ? `${tag} "${label}" → ${href.slice(0, 100)}` : `${tag} "${label}" [${selector}]`;
        });
      return { text, headings, interactives };
    })
    .catch(() => ({ text: "(page read failed)", headings: [], interactives: [] }));

  return {
    url,
    title,
    text: String(body.text).slice(0, MAX_READ_CHARS),
    headings: body.headings,
    interactives: body.interactives,
  };
}

/**
 * Discover actionable elements with stable selector hints + refs. Refs let the
 * model click/type WITHOUT inventing CSS selectors — and survive pages whose
 * class names are minified or generated.
 */
async function findElements(
  s: AgentBrowserSession,
  filter: { role?: string; text?: string; purpose?: string } = {}
): Promise<{ matches: FindCandidate[]; total: number }> {
  const page = activePage(s);
  const raw = await page
    .evaluate(() => {
      const cssPath = (el: Element): string => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const dt = el.getAttribute("data-testid");
        if (dt) return `[data-testid="${dt}"]`;
        const parts: string[] = [];
        let cur: Element | null = el;
        for (let depth = 0; cur && depth < 4 && cur !== document.body; depth++) {
          const tag = cur.tagName.toLowerCase();
          const parent: Element | null = cur.parentElement;
          if (parent) {
            const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
            const idx = same.indexOf(cur!) + 1;
            parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
          } else parts.unshift(tag);
          cur = parent;
        }
        return parts.join(" > ");
      };
      const roleOf = (el: Element): string => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === "a" && el.getAttribute("href")) return "link";
        if (tag === "button") return "button";
        if (tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable) return "textbox";
        if (tag === "select") return "combobox";
        if (tag === "summary") return "button";
        if (/^h[1-6]$/.test(tag)) return "heading";
        return tag;
      };
      const nameOf = (el: Element): string => {
        const aria = el.getAttribute("aria-label");
        if (aria) return aria.trim();
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          const lbl = document.getElementById(labelledby);
          if (lbl) return (lbl.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
        }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const labels = (el as HTMLInputElement).labels;
          if (labels && labels[0]) return (labels[0].textContent || "").trim().slice(0, 120);
          return el.placeholder || el.name || el.value || "";
        }
        if (el instanceof HTMLSelectElement) {
          const labels = (el as HTMLSelectElement).labels;
          if (labels && labels[0]) return (labels[0].textContent || "").trim().slice(0, 120);
          return el.name || "";
        }
        return (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
      };
      const els = Array.from(
        document.querySelectorAll('a[href], button, input, textarea, select, [role], summary, [contenteditable="true"], [onclick]')
      );
      const out: Array<{ role: string; name: string; selector: string; enabled: boolean }> = [];
      for (const el of els.slice(0, 400)) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue; // not visible
        if (out.length >= 40) break;
        out.push({
          role: roleOf(el),
          name: nameOf(el),
          selector: cssPath(el),
          enabled: !(el as HTMLButtonElement | HTMLInputElement).disabled,
        });
      }
      return out;
    })
    .catch(() => [] as Array<{ role: string; name: string; selector: string; enabled: boolean }>);

  const needle = (filter.text || "").toLowerCase();
  const matches = raw
    .filter((c) => (filter.role ? c.role === filter.role : true))
    .filter((c) => (needle ? (c.name || "").toLowerCase().includes(needle) || c.selector.toLowerCase().includes(needle) : true))
    .slice(0, MAX_FIND_RESULTS);

  s.lastFind = matches.map((m) => ({ selector: m.selector, description: `${m.role} "${m.name}"` }));
  return { matches, total: raw.length };
}

/** Selector from args.selector or a browser_find ref; stale refs get caught by the caller. */
function resolveTarget(s: AgentBrowserSession, args: BrowserOpArgs): { selector: string; fromRef: boolean } | null {
  if (args.ref) {
    const sel = resolveRefSelector(s.lastFind, args.ref);
    if (sel) return { selector: sel, fromRef: true };
  }
  if (args.selector) return { selector: args.selector, fromRef: false };
  return null;
}

async function tabSummary(s: AgentBrowserSession): Promise<Array<{ index: number; url: string; title: string; active: boolean }>> {
  const out: Array<{ index: number; url: string; title: string; active: boolean }> = [];
  for (let i = 0; i < s.pages.length; i++) {
    const p = s.pages[i];
    if (p.isClosed?.()) continue;
    out.push({
      index: i,
      url: p.url().slice(0, 200),
      title: (await p.title().catch(() => "")) || "",
      active: i === s.active,
    });
  }
  return out;
}

export interface BrowserOpArgs {
  url?: string;
  selector?: string;
  ref?: string;
  text?: string;
  value?: string;
  key?: string;
  dx?: number;
  dy?: number;
  // wait_for
  time?: number;
  timeoutMs?: number;
  // find
  purpose?: string;
  role?: string;
  // tabs
  tabAction?: string;
  index?: number;
  // screenshot
  fullPage?: boolean;
  viewpoint?: string;
  // evaluate
  code?: string;
  sessionId?: string;
}

/** Execute one browser operation. All navigation is SSRF-guarded. */
export async function runBrowserOp(userId: string, op: string, args: BrowserOpArgs = {}): Promise<BrowserOpResult> {
  const VALID_OPS = new Set([
    "navigate", "read", "click", "type", "press", "scroll", "console", "screenshot", "close",
    // Advanced: conditional waiting, ref-based discovery, rich interactions,
    // multi-tab, network telemetry, and page-J execution.
    "wait_for", "find", "hover", "select", "tabs", "network", "evaluate",
  ]);
  try {
    // Op validation BEFORE any session exists — garbage ops must not pay the
    // cost of launching a browser just to be told they're garbage.
    if (!VALID_OPS.has(op)) {
      return { ok: false, error: `unknown op "${op}" — use navigate | read | click | type | press | scroll | console | screenshot | close | wait_for | find | hover | select | tabs | network | evaluate` };
    }

    // Argument validation, also pre-session.
    if (op === "navigate" && !args.url) return { ok: false, error: "url required" };
    if (op === "navigate" && args.url) {
      const verdict = checkUrlPolicy(args.url);
      if (!verdict.allowed) {
        return { ok: false, error: `blocked by URL policy: ${verdict.reason}` };
      }
    }
    if (op === "click" || op === "type") {
      if (!args.selector && !args.ref) return { ok: false, error: "selector (or ref from browser_find) required" };
      if (op === "type" && args.text === undefined) return { ok: false, error: "text required" };
    }
    if (op === "press" && !args.key) return { ok: false, error: "key required" };
    if (op === "hover" && !args.selector && !args.ref) return { ok: false, error: "selector (or ref) required" };
    if (op === "select" && (!args.value || (!args.selector && !args.ref))) return { ok: false, error: "value required, plus selector or ref" };
    if (op === "wait_for" && args.text === undefined && !args.selector && args.time === undefined) {
      return { ok: false, error: "text, selector, or time (ms) required" };
    }
    if (op === "evaluate" && !args.code) return { ok: false, error: "code required" };
    if (op === "tabs") {
      const action = args.tabAction || "list";
      if (!["list", "new", "switch", "close"].includes(action)) return { ok: false, error: `unknown tab_action "${action}" — use list | new | switch | close` };
      if ((action === "switch" || action === "close") && typeof args.index !== "number") return { ok: false, error: `numeric index required for tab_action "${action}"` };
    }

    const s = await getOrCreateSession(userId, args.sessionId);
    s.lastUsedAt = Date.now();
    const page = activePage(s);

    switch (op) {
      case "navigate": {
        const url = args.url!;
        const resp = await page
          .goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
          .catch((err: unknown) => {
            throw new Error(`navigation failed: ${(err as Error).message.slice(0, 200)}`);
          });
        await page.waitForTimeout(500); // settle
        s.lastFind = null; // stale after navigation
        const status = resp?.status() ?? null;
        const read = await readPage(s);
        return { ok: true, data: { status, ...read } };
      }

      case "read": {
        const read = await readPage(s);
        return { ok: true, data: read };
      }

      case "find": {
        const { matches, total } = await findElements(s, { role: args.role, text: args.text, purpose: args.purpose });
        return {
          ok: true,
          data: {
            matches: matches.map((m, i) => ({ ref: `e${i + 1}`, ...m })),
            total,
            hint: matches.length ? "click/type/hover/select with ref=eN (or the selector). Refs come from THIS list — run find again after navigation." : "no visible matches — try a shorter text filter, or browser_read to inspect the page",
          },
        };
      }

      case "click": {
        const target = resolveTarget(s, args)!;
        const loc = page.locator(target.selector).first();
        if ((await loc.count().catch(() => 0)) === 0) {
          return { ok: false, error: target.fromRef ? `ref ${args.ref} is stale (element gone) — run browser_find again` : `no element matches ${target.selector}` };
        }
        await loc.click({ timeout: ACTION_TIMEOUT_MS });
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(300);
        const read = await readPage(s);
        return { ok: true, data: { clicked: target.fromRef ? `${args.ref} (${target.selector})` : target.selector, ...read } };
      }

      case "type": {
        const target = resolveTarget(s, args)!;
        const loc = page.locator(target.selector).first();
        if ((await loc.count().catch(() => 0)) === 0) {
          return { ok: false, error: target.fromRef ? `ref ${args.ref} is stale (element gone) — run browser_find again` : `no element matches ${target.selector}` };
        }
        await loc.fill(args.text!, { timeout: ACTION_TIMEOUT_MS });
        return { ok: true, data: { typed: target.fromRef ? `${args.ref} (${target.selector})` : target.selector, length: args.text!.length } };
      }

      case "hover": {
        const target = resolveTarget(s, args)!;
        const loc = page.locator(target.selector).first();
        if ((await loc.count().catch(() => 0)) === 0) {
          return { ok: false, error: target.fromRef ? `ref ${args.ref} is stale — run browser_find again` : `no element matches ${target.selector}` };
        }
        await loc.hover({ timeout: ACTION_TIMEOUT_MS });
        await page.waitForTimeout(300);
        return { ok: true, data: { hovered: target.fromRef ? `${args.ref} (${target.selector})` : target.selector, url: page.url(), title: await page.title().catch(() => "") } };
      }

      case "select": {
        const target = resolveTarget(s, args)!;
        const loc = page.locator(target.selector).first();
        if ((await loc.count().catch(() => 0)) === 0) {
          return { ok: false, error: target.fromRef ? `ref ${args.ref} is stale — run browser_find again` : `no element matches ${target.selector}` };
        }
        await loc.selectOption(args.value!, { timeout: ACTION_TIMEOUT_MS });
        return { ok: true, data: { selected: args.value, in: target.fromRef ? `${args.ref} (${target.selector})` : target.selector } };
      }

      case "wait_for": {
        const timeout = Math.min(Math.max(Number(args.timeoutMs) || ACTION_TIMEOUT_MS, 500), 15_000);
        const started = Date.now();
        try {
          if (args.selector) {
            await page.waitForSelector(args.selector, { state: "visible", timeout });
          } else if (args.text !== undefined) {
            await page.getByText(args.text).first().waitFor({ state: "visible", timeout });
          } else {
            await page.waitForTimeout(Math.min(Math.max(Number(args.time) || 1000, 100), 10_000));
          }
        } catch (err) {
          throw new Error(`timed out after ${timeout}ms waiting for ${args.selector ? `selector "${args.selector}"` : args.text !== undefined ? `text "${args.text}"` : "delay"} — ${(err as Error).message.slice(0, 120)}`);
        }
        return { ok: true, data: { waitedMs: Date.now() - started, url: page.url(), title: await page.title().catch(() => "") } };
      }

      case "press": {
        await page.keyboard.press(args.key!);
        return { ok: true, data: { pressed: args.key } };
      }

      case "scroll": {
        const dx = Number(args.dx ?? 0);
        const dy = Number(args.dy ?? 600);
        await page.mouse.wheel(dx, dy);
        await page.waitForTimeout(200);
        return { ok: true, data: { scrolled: dy } };
      }

      case "console": {
        return { ok: true, data: { messages: s.consoleLog.slice(-MAX_CONSOLE_LINES) } };
      }

      case "network": {
        const events = s.networkLog;
        const summary = {
          failedRequests: events.length,
          failed4xx5xx: events.filter((e) => e.status && e.status >= 400).length,
          aborted: events.filter((e) => e.error).length,
          events: events.slice(-30),
          hint: events.length ? "4xx/5xx and aborted requests since session start (newest last). Investigate the failing URL or check browser_console." : "No failed requests (no 4xx/5xx responses, no aborted requests).",
        };
        return { ok: true, data: summary };
      }

      case "screenshot": {
        let appliedViewport: { width: number; height: number } | undefined;
        if (args.viewpoint && VIEWPORTS[args.viewpoint]) {
          appliedViewport = VIEWPORTS[args.viewpoint];
          await page.setViewportSize(appliedViewport);
          await page.waitForTimeout(300); // let responsive layouts settle
        }
        const buf = await page.screenshot({ fullPage: !!args.fullPage });
        return {
          ok: true,
          data: {
            screenshotBase64: buf.toString("base64").slice(0, 4_000_000),
            url: page.url(),
            fullPage: !!args.fullPage,
            ...(appliedViewport ? { viewport: appliedViewport } : {}),
          },
        };
      }

      case "evaluate": {
        let lastErr: Error | null = null;
        for (const attempt of evaluateAttempts(args.code!)) {
          try {
            const result = await (page as any).evaluate(attempt.code);
            return { ok: true, data: { result: JSON.stringify(result)?.slice(0, 2000) ?? "undefined", mode: attempt.mode } };
          } catch (err) {
            lastErr = err as Error;
          }
        }
        throw new Error(`evaluate failed: ${lastErr?.message.slice(0, 200)}`);
      }

      case "tabs": {
        const action = args.tabAction || "list";
        if (action === "list") {
          return { ok: true, data: { tabs: await tabSummary(s) } };
        }
        if (action === "new") {
          if (s.pages.filter((p) => !p.isClosed?.()).length >= MAX_TABS) {
            return { ok: false, error: `tab limit reached (${MAX_TABS}) — close one first with tab_action "close"` };
          }
          if (args.url) {
            const verdict = checkUrlPolicy(args.url);
            if (!verdict.allowed) return { ok: false, error: `blocked by URL policy: ${verdict.reason}` };
          }
          const newPage = await s.context.newPage();
          attachPageListeners(s, newPage);
          s.pages.push(newPage);
          s.active = s.pages.length - 1;
          s.lastFind = null;
          if (args.url) {
            await newPage.goto(args.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch((err: unknown) => {
              throw new Error(`navigation failed in new tab: ${(err as Error).message.slice(0, 200)}`);
            });
            await newPage.waitForTimeout(500);
          }
          return { ok: true, data: { opened: s.active, url: newPage.url(), title: await newPage.title().catch(() => ""), tabs: await tabSummary(s) } };
        }
        if (action === "switch") {
          const idx = args.index!;
          if (idx < 0 || idx >= s.pages.length || s.pages[idx].isClosed?.()) {
            return { ok: false, error: `no tab at index ${idx} — call tabs (list) to see open tabs` };
          }
          s.active = idx;
          s.lastFind = null;
          const p = s.pages[idx];
          return { ok: true, data: { switchedTo: idx, url: p.url(), title: await p.title().catch(() => ""), tabs: await tabSummary(s) } };
        }
        // close
        const idx = args.index!;
        if (idx < 0 || idx >= s.pages.length || s.pages[idx].isClosed?.()) {
          return { ok: false, error: `no tab at index ${idx} — call tabs (list) to see open tabs` };
        }
        if (s.pages.filter((p) => !p.isClosed?.()).length <= 1) {
          return { ok: false, error: "cannot close the last tab — use op close to end the whole session" };
        }
        await s.pages[idx].close().catch(() => {});
        if (s.active === idx) {
          s.active = Math.max(0, s.pages.findIndex((p) => !p.isClosed?.()));
        }
        return { ok: true, data: { closed: idx, tabs: await tabSummary(s) } };
      }

      case "close": {
        await closeSession(sessionKey(userId, args.sessionId));
        return { ok: true, data: { closed: true } };
      }
    }
    // Unreachable: the switch above covers every VALID_OPS member.
    return { ok: false, error: `unhandled op "${op}"` };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 300) };
  }
}

/** Test/debug introspection. */
export function activeSessionCount(): number {
  return sessions.size;
}

/** Close everything (shutdown / tests). */
export async function closeAllSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map(closeSession));
}
