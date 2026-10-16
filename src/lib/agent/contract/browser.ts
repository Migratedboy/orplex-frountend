// contract/browser.ts — Single browser contract, two backends (Step A).
//
// ONE op set, ONE arg-validation table, ONE result format. The two backends:
//   - "electron": desktop shell WebContentsView via window.orplexDesktop.agentBrowser IPC
//   - "playwright": headless session via agent-browser-session.runBrowserOp
// Client worker and server executor both go through runBrowserTool() — they
// never re-implement op mapping, validation, or result strings.

import { formatToolError, formatToolResult } from "./results";
import type { BrowserOpArgs, BrowserOpResult } from "../../agent-browser-session";

// Re-exported for server lanes (type-only: erased at build, zero bundle cost).
export type { BrowserOpArgs, BrowserOpResult } from "../../agent-browser-session";

/** Canonical op names (tool name minus the `browser_` prefix). */
export const BROWSER_OPS = [
  "navigate",
  "read",
  "find",
  "click",
  "type",
  "select",
  "hover",
  "press",
  "scroll",
  "wait_for",
  "tabs",
  "console",
  "network",
  "screenshot",
  "evaluate",
] as const;

export type BrowserOpName = (typeof BROWSER_OPS)[number];

/** Map `browser_click` → `click` etc. Returns null for non-browser tools. */
export function browserOpOf(toolName: string): BrowserOpName | null {
  if (!toolName.startsWith("browser_")) return null;
  const op = toolName.slice("browser_".length) as BrowserOpName;
  return (BROWSER_OPS as readonly string[]).includes(op) ? op : null;
}

export interface BrowserBackend {
  readonly kind: "electron" | "playwright";
  run(op: BrowserOpName, args: BrowserOpArgs): Promise<BrowserOpResult>;
}

/**
 * Shared argument validation — runs BEFORE any browser launch in every lane.
 * Mirrors the server's pre-session checks (agent-browser-session.ts) exactly:
 * same accept/reject on the same inputs, so lanes never disagree about what
 * is well-formed. Returns an error string, or null when acceptable.
 */
export function validateBrowserArgs(op: BrowserOpName, args: BrowserOpArgs): string | null {
  switch (op) {
    case "navigate":
      return args.url ? null : "url required";
    case "click":
    case "hover":
      return args.selector || args.ref ? null : "selector (or ref) required";
    case "type":
      // Server fills args.text only — a value-only call would fill undefined.
      if (!args.selector && !args.ref) return "selector or ref required";
      return args.text !== undefined ? null : "text required";
    case "select":
      if (!args.selector && !args.ref) return "selector or ref required";
      return args.value ? null : "value required";
    case "press":
      return args.key ? null : "key required";
    case "wait_for":
      // Server uses undefined-checks (empty string / 0 are accepted, then clamped).
      return args.text !== undefined || args.selector || args.time !== undefined
        ? null
        : "text, selector, or time required";
    case "tabs": {
      // Missing action defaults to "list" server-side — accept it here too.
      const action = args.tabAction || "list";
      if (!["list", "new", "switch", "close"].includes(action))
        return "tabAction must be list | new | switch | close";
      // Server requires a numeric index for BOTH switch and close.
      return (action === "switch" || action === "close") && args.index === undefined
        ? "index required"
        : null;
    }
    case "evaluate":
      return args.code ? null : "code required";
    default:
      return null;
  }
}

function str(v: unknown, max = 4000): string {
  return String(v ?? "").slice(0, max);
}

/**
 * Single result formatter for browser ops — both backends, both loops.
 * data is the backend's BrowserOpResult.data payload. Every op has an
 * explicit case: falling through to "ok" would silently drop the content
 * the model needs (matches, console lines, network events, tabs).
 */
export function formatBrowserResult(
  toolName: string,
  op: BrowserOpName,
  res: BrowserOpResult
): string {
  const d = (res.data ?? {}) as Record<string, unknown>;
  if (!res.ok) return formatToolError(toolName, pickAttrs(op, d), str(res.error || "failed"));
  switch (op) {
    case "navigate":
      return formatToolResult(
        toolName,
        { url: str(d.url) },
        `success — now on "${str(d.title || d.url, 200)}". Use browser_read to see the page content.`
      );
    case "read": {
      const interactives = Array.isArray(d.interactives)
        ? (d.interactives as unknown[]).map((e) => String(e))
        : [
            ...((d.links as unknown[]) || []).map((e) => String(e)),
            ...((d.buttons as unknown[]) || []).map((e) => String(e)),
            ...((d.inputs as unknown[]) || []).map((e) => String(e)),
          ];
      return formatToolResult(
        toolName,
        {},
        `\nURL: ${str(d.url, 300)}\nTitle: ${str(d.title, 200)}\n\nPAGE TEXT (first 4000 chars):\n${str(d.text)}\n\nHEADINGS:\n${((d.headings as string[]) || []).join("\n")}\n\nINTERACTIVE ELEMENTS:\n${interactives.slice(0, 30).join("\n")}\n`
      );
    }
    case "find": {
      const matches = (d.matches as Array<{ ref?: string; role?: string; name?: string; selector?: string; enabled?: boolean }> | undefined) || [];
      const list = matches
        .slice(0, 25)
        .map((m) => `${m.ref ?? "?"}: ${m.role ?? "?"} "${m.name ?? ""}" [${m.selector ?? ""}]${m.enabled === false ? " (disabled)" : ""}`)
        .join("\n");
      const total = d.total !== undefined ? ` (${matches.length} of ${String(d.total)})` : "";
      return formatToolResult(
        toolName,
        {},
        `\nMATCHES${total}:\n${list || "none"}\n\n${str(d.hint, 300)}\n`
      );
    }
    case "click":
      return formatToolResult(
        toolName,
        { selector: str((d.clicked as string) || (d.selector as string), 300) },
        `success — clicked "${str(d.clicked || d.selector, 200)}". Use browser_read to see the result.`
      );
    case "type":
      return formatToolResult(
        toolName,
        { selector: str((d.typed as string) || (d.selector as string), 300) },
        `success — typed ${str(d.length, 20) || "?"} chars into "${str(d.typed || d.selector, 200)}"`
      );
    case "press":
      return formatToolResult(toolName, { key: str(d.pressed || d.key, 100) }, "success — key sent");
    case "scroll":
      return formatToolResult(
        toolName,
        {},
        `success — scrolled ${str(d.scrolled, 20) || "?"}px. Use browser_read to see the new content.`
      );
    case "wait_for":
      return formatToolResult(
        toolName,
        {},
        `success — condition met after ${str(d.waitedMs, 20) || "?"}ms. Now on "${str(d.title || d.url, 200)}".`
      );
    case "hover":
      return formatToolResult(
        toolName,
        { selector: str((d.hovered as string) || (d.selector as string), 300) },
        "success — hovered. Check browser_screenshot/browser_read for what appeared."
      );
    case "select":
      return formatToolResult(
        toolName,
        { selector: str(d.in as string, 300) },
        `success — selected "${str(d.selected, 200)}" in "${str(d.in, 200)}"`
      );
    case "tabs": {
      const tabs = ((d.tabs as Array<{ active?: boolean; index?: number; title?: string; url?: string }> | undefined) || [])
        .map((t) => `${t.active ? "→" : " "} [${t.index ?? "?"}] ${t.title || "(untitled)"} — ${t.url ?? ""}`)
        .join("\n");
      const head =
        d.opened !== undefined
          ? `opened tab [${String(d.opened)}] ${str(d.url, 200)}`
          : d.switchedTo !== undefined
            ? `switched to tab [${String(d.switchedTo)}]`
            : d.closed !== undefined
              ? `closed tab [${String(d.closed)}]`
              : `${((d.tabs as unknown[]) || []).length} tab(s) open`;
      return formatToolResult(toolName, {}, `${head}\n${tabs}`);
    }
    case "console": {
      const msgs = ((d.messages as Array<{ type?: string; level?: string; text?: string }> | undefined) || [])
        .map((m) => `[${m.type ?? m.level ?? "?"}] ${m.text ?? ""}`)
        .join("\n");
      return formatToolResult(
        toolName,
        {},
        msgs || "No console messages — no JS errors."
      );
    }
    case "network": {
      const events = ((d.events as Array<{ status?: number; method?: string; url?: string; error?: string }> | undefined) || [])
        .map((e) => `${e.status ? `HTTP ${e.status}` : "ABORTED"} ${e.method ?? ""} ${e.url ?? ""}${e.error ? ` (${e.error})` : ""}`)
        .join("\n");
      return formatToolResult(
        toolName,
        {},
        events || str(d.hint, 300) || "No failed requests (no 4xx/5xx responses, no aborted requests)."
      );
    }
    case "screenshot": {
      const vp = d.viewport
        ? ` at ${str((d.viewport as { width?: number }).width)}x${str((d.viewport as { height?: number }).height)}`
        : "";
      return formatToolResult(
        toolName,
        {},
        `success — screenshot captured${d.fullPage ? " (full page)" : ""}${vp} (${str(d.url, 200)}) and attached inline in the chat below. Use browser_read for the text content.`
      );
    }
    case "evaluate":
      // Backends pre-stringify the value — never double-encode.
      return formatToolResult(toolName, {}, `result: ${str(d.result, 2000) || "undefined"}`);
    default:
      return formatToolResult(toolName, {}, str(d.summary || d.result || "ok", 2000));
  }
}

/** Small helper: attributes worth echoing per op. */
function pickAttrs(op: BrowserOpName, d: Record<string, unknown>): Record<string, string> {
  if (op === "navigate" && d.url) return { url: str(d.url, 300) };
  if ((op === "click" || op === "hover") && (d.clicked || d.selector))
    return { selector: str(d.clicked || d.selector, 300) };
  return {};
}

/**
 * Run one browser tool through a backend: validate → run → format.
 * This is what both execution modes call. Tool-call-shaped input in,
 * `<tool_result>` XML out.
 */
export async function runBrowserTool(
  backend: BrowserBackend,
  toolName: string,
  call: Record<string, unknown>
): Promise<string> {
  return (await runBrowserToolRaw(backend, toolName, call)).xml;
}

/**
 * Raw variant: returns the formatted XML plus the backend's data payload.
 * Lanes that need out-of-band bytes (screenshot attach) use this; the text
 * contract is still the single formatter above.
 */
export async function runBrowserToolRaw(
  backend: BrowserBackend,
  toolName: string,
  call: Record<string, unknown>
): Promise<{ xml: string; data: Record<string, unknown> | null }> {
  const op = browserOpOf(toolName);
  if (!op) return { xml: formatToolError(toolName, {}, `unknown browser tool`), data: null };
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const b = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  const args: BrowserOpArgs = {
    url: s(call.url),
    selector: s(call.selector),
    ref: s(call.ref),
    text: s(call.text),
    value: s(call.value),
    key: s(call.key),
    dx: n(call.dx),
    dy: n(call.dy) ?? n(call.amount),
    time: n(call.time),
    timeoutMs: n(call.timeoutMs),
    role: s(call.role),
    tabAction: s(call.action) || s(call.tabAction),
    index: n(call.index),
    fullPage: b(call.fullPage),
    viewpoint: s(call.viewpoint),
    code: s(call.code),
    sessionId: s(call.sessionId),
  };
  const invalid = validateBrowserArgs(op, args);
  if (invalid) return { xml: formatToolError(toolName, {}, invalid), data: null };
  const res = await backend.run(op, args);
  return { xml: formatBrowserResult(toolName, op, res), data: (res.data ?? null) as Record<string, unknown> | null };
}

/**
 * Server-only backends live in ./browser-server (NOT here): this module must
 * stay free of Node-only imports so the interactive client worker
 * (background-worker → native-tools, bundled for the browser) can import the
 * contract without dragging Playwright/child_process into the client build.
 */

/**
 * Electron backend: wraps the desktop shell's dedicated agent view
 * (window.orplexDesktop.agentBrowser IPC bridge). Normalizes bridge results
 * into the shared BrowserOpResult.data shapes so formatBrowserResult renders
 * the same dialect as the Playwright lane.
 */
export function electronBackend(bridge: {
  navigate(url: string): Promise<Record<string, unknown>>;
  read(): Promise<Record<string, unknown>>;
  elements(): Promise<Record<string, unknown>>;
  interact(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  console(): Promise<Record<string, unknown>>;
  screenshot(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluate(code: string): Promise<Record<string, unknown>>;
  find(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  waitFor(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  hover(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  select(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  tabs(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  network(): Promise<Record<string, unknown>>;
}): BrowserBackend {
  const ok = (r: Record<string, unknown>) => r.ok !== false;
  return {
    kind: "electron",
    async run(op: BrowserOpName, args: BrowserOpArgs): Promise<BrowserOpResult> {
      try {
        switch (op) {
          case "navigate": {
            const r = await bridge.navigate(String(args.url));
            return { ok: ok(r), error: typeof r.error === "string" ? r.error : undefined, data: r };
          }
          case "read": {
            const r = await bridge.read();
            const el = await bridge.elements().catch(() => ({ ok: false }));
            const elk = (el || {}) as Record<string, unknown>;
            // Normalize the bridge's structured elements to the Playwright
            // lane's plain-string interactives so the formatter renders text,
            // never "[object Object]".
            const links = (((elk.links as unknown[]) || []) as Array<{ text?: string; href?: string }>).map(
              (l) => `- "${l.text ?? ""}" → ${l.href ?? ""}`
            );
            const buttons = (((elk.buttons as unknown[]) || []) as Array<{ text?: string }>).map(
              (b) => `- "${b.text ?? ""}"`
            );
            const inputs = (((elk.inputs as unknown[]) || []) as Array<{ tag?: string; name?: string; placeholder?: string }>).map(
              (i) => `- ${i.tag ?? "input"}${i.name ? `[name=${i.name}]` : ""}${i.placeholder ? ` ("${i.placeholder}")` : ""}`
            );
            return {
              ok: ok(r),
              error: typeof r.error === "string" ? r.error : undefined,
              data: { ...r, interactives: [...links, ...buttons, ...inputs] },
            };
          }
          case "find": {
            const r = await bridge.find({ text: args.text, role: args.role });
            return { ok: ok(r), error: typeof r.error === "string" ? r.error : undefined, data: r };
          }
          case "click":
          case "type":
          case "press":
          case "scroll": {
            const kind = op === "click" ? "click" : op === "type" ? "type" : op === "press" ? "press" : "scroll";
            const r = await bridge.interact({
              kind,
              selector: args.selector,
              ref: args.ref,
              text: args.text ?? args.value,
              key: args.key,
              amount: args.dy ?? 600,
            });
            return { ok: ok(r), error: typeof r.error === "string" ? r.error : undefined, data: r };
          }
          case "hover": {
            const r = await bridge.hover({ selector: args.selector, ref: args.ref });
            return { ok: ok(r), error: typeof r.error === "string" ? r.error : undefined, data: r };
          }
          case "select": {
            const r = await bridge.select({ selector: args.selector, ref: args.ref, value: args.value });
            return { ok: ok(r), error: typeof r.error === "string" ? r.error : undefined, data: r };
          }
          case "wait_for": {
            const r = await bridge.waitFor({ text: args.text, selector: args.selector, time: args.time, timeoutMs: args.timeoutMs });
            return { ok: ok(r), error: typeof r.error === "string" ? r.error : undefined, data: r };
          }
          case "tabs": {
            const r = await bridge.tabs({ action: args.tabAction, url: args.url, index: args.index });
            return { ok: ok(r), error: typeof r.error === "string" ? r.error : undefined, data: r };
          }
          case "console": {
            const r = await bridge.console();
            // Bridge reports { level, text }; Playwright lane { type, text } —
            // normalize to type so the formatter covers both.
            const messages = (((r.messages as unknown[]) || []) as Array<{ level?: string; type?: string; text?: string }>).map(
              (m) => ({ type: m.type ?? m.level ?? "?", text: m.text ?? "" })
            );
            return { ok: ok(r), error: typeof r.error === "string" ? r.error : undefined, data: { ...r, messages } };
          }
          case "network": {
            const r = await bridge.network();
            return { ok: ok(r), error: typeof r.error === "string" ? r.error : undefined, data: r };
          }
          case "screenshot": {
            const r = await bridge.screenshot({ fullPage: !!args.fullPage, viewpoint: args.viewpoint });
            return { ok: ok(r), error: typeof r.error === "string" ? r.error : undefined, data: r };
          }
          case "evaluate": {
            const r = await bridge.evaluate(String(args.code));
            return { ok: ok(r), error: typeof r.error === "string" ? r.error : undefined, data: r };
          }
          default:
            return { ok: false, error: `unsupported op "${op}"` };
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  };
}
