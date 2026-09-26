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
//  - Hard caps: MAX_SESSIONS concurrent, IDLE_REAP_MS reaping, bounded reads

// Dynamic import convention (mirrors browser-verification): Playwright is an
// optional dependency — typed as `any` via narrow local interfaces.
interface PWPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, opts?: Record<string, unknown>): Promise<{ status(): number } | null>;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state?: string): Promise<void>;
  locator(sel: string): { first(): { click(opts?: Record<string, unknown>): Promise<void>; fill(text: string, opts?: Record<string, unknown>): Promise<void> } };
  keyboard: { press(key: string): Promise<void> };
  mouse: { wheel(dx: number, dy: number): Promise<void> };
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  evaluate<T>(fn: () => T): Promise<T>;
  on(event: string, cb: (arg: any) => void): void;
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

interface AgentBrowserSession {
  id: string;
  userId: string;
  browser: PWBrowser | null; // null for persistent contexts
  context: PWContext;
  page: PWPage;
  consoleLog: Array<{ type: string; text: string; at: number }>;
  lastUsedAt: number;
  createdAt: number;
  closing: boolean;
}

const sessions = new Map<string, AgentBrowserSession>();
let reapTimer: ReturnType<typeof setInterval> | null = null;

function sessionKey(userId: string, sessionId?: string): string {
  return sessionId || userId; // one default session per user
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
    const session: AgentBrowserSession = {
      id: key,
      userId,
      browser: null,
      context,
      page: context.pages()[0] ?? (await context.newPage()),
      consoleLog: [],
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
    page: await context.newPage(),
    consoleLog: [],
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
    closing: false,
  };
  await attachGuards(session);
  sessions.set(key, session);
  return session;
}

/** SSRF enforcement at the network layer: every request the page makes. */
async function attachGuards(s: AgentBrowserSession): Promise<void> {
  await s.context.route("**/*", (route: any) => {
    const verdict = checkUrlPolicy(route.request().url());
    if (verdict.allowed) return route.continue();
    return route.abort("blockedbyclient");
  });
  s.page.on("console", (msg: any) => {
    s.consoleLog.push({ type: String(msg.type()), text: String(msg.text()).slice(0, 500), at: Date.now() });
    if (s.consoleLog.length > MAX_CONSOLE_LINES * 2) {
      s.consoleLog.splice(0, s.consoleLog.length - MAX_CONSOLE_LINES);
    }
  });
  s.page.on("pageerror", (err: any) => {
    s.consoleLog.push({ type: "error", text: `[PageError] ${String(err?.message || err).slice(0, 500)}`, at: Date.now() });
  });
}

export interface BrowserOpResult {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

/** Extract bounded page sensor data: URL, title, text, headings, interactives. */
async function readPage(s: AgentBrowserSession): Promise<Record<string, unknown>> {
  const url = s.page.url();
  const title = await s.page.title().catch(() => "");
  const body = await s.page
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

/** Execute one browser operation. All navigation is SSRF-guarded. */
export async function runBrowserOp(
  userId: string,
  op: string,
  args: { url?: string; selector?: string; text?: string; key?: string; dx?: number; dy?: number; sessionId?: string } = {}
): Promise<BrowserOpResult> {
  const VALID_OPS = new Set(["navigate", "read", "click", "type", "press", "scroll", "console", "screenshot", "close"]);
  try {
    // Op validation BEFORE any session exists — garbage ops must not pay the
    // cost of launching a browser just to be told they're garbage.
    if (!VALID_OPS.has(op)) {
      return { ok: false, error: `unknown op "${op}" — use navigate | read | click | type | press | scroll | console | screenshot | close` };
    }

    // Navigation ops: policy-check BEFORE the browser even opens.
    if (op === "navigate" && args.url) {
      const verdict = checkUrlPolicy(args.url);
      if (!verdict.allowed) {
        return { ok: false, error: `blocked by URL policy: ${verdict.reason}` };
      }
    }

    const s = await getOrCreateSession(userId, args.sessionId);
    s.lastUsedAt = Date.now();

    switch (op) {
      case "navigate": {
        const url = args.url;
        if (!url) return { ok: false, error: "url required" };
        const resp = await s.page
          .goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
          .catch((err: unknown) => {
            throw new Error(`navigation failed: ${(err as Error).message.slice(0, 200)}`);
          });
        await s.page.waitForTimeout(500); // settle
        const status = resp?.status() ?? null;
        const read = await readPage(s);
        return { ok: true, data: { status, ...read } };
      }

      case "read": {
        const read = await readPage(s);
        return { ok: true, data: read };
      }

      case "click": {
        if (!args.selector) return { ok: false, error: "selector required" };
        await s.page.locator(args.selector).first().click({ timeout: ACTION_TIMEOUT_MS });
        await s.page.waitForLoadState("domcontentloaded").catch(() => {});
        await s.page.waitForTimeout(300);
        const read = await readPage(s);
        return { ok: true, data: { clicked: args.selector, ...read } };
      }

      case "type": {
        if (!args.selector || args.text === undefined) return { ok: false, error: "selector and text required" };
        const loc = s.page.locator(args.selector).first();
        await loc.fill(args.text, { timeout: ACTION_TIMEOUT_MS });
        return { ok: true, data: { typed: args.selector, length: args.text.length } };
      }

      case "press": {
        if (!args.key) return { ok: false, error: "key required" };
        await s.page.keyboard.press(args.key);
        return { ok: true, data: { pressed: args.key } };
      }

      case "scroll": {
        const dx = Number(args.dx ?? 0);
        const dy = Number(args.dy ?? 600);
        await s.page.mouse.wheel(dx, dy);
        await s.page.waitForTimeout(200);
        return { ok: true, data: { scrolled: dy } };
      }

      case "console": {
        return { ok: true, data: { messages: s.consoleLog.slice(-MAX_CONSOLE_LINES) } };
      }

      case "screenshot": {
        const buf = await s.page.screenshot({ fullPage: false });
        return { ok: true, data: { screenshotBase64: buf.toString("base64").slice(0, 4_000_000), url: s.page.url() } };
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
