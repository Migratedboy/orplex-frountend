/**
 * browser-lane.ts — the browser_* tool lane, extracted verbatim from
 * native-tools.ts (Operation Modularity).
 *
 * Three transports behind one shared contract (agent/contract/browser.ts):
 * the Electron IPC bridge, the server Playwright-via-API fallback, and the
 * inline screenshot attach. runBrowserLane returns null for a non-browser
 * call (the dispatcher gates on the browser_ prefix, so in practice the
 * lane always handles it).
 */
import { screenshotMarkdown, downscaleDataUrl } from "../tool-text";
import { emitPreview } from "../agent-events";
import { apiFetch } from "@/lib/api-base";
import type { ToolCall } from "../stream-reader";
import type { ToolContext, DispatchOutcome } from "./native-tools";

/**
 * Shared screenshot landing: embed the capture inline in the chat transcript
 * (the markdown renderer turns it into an <img>) and return the pixels so
 * the caller can forward them to the vision channel. Never throws — worst
 * case it returns undefined and the chat shows text only, exactly like
 * before. NOTE: resultXml stays text-only on purpose — pixels travel via
 * the return value (vision) + the display transcript (chat <img>).
 */
export async function attachScreenshot(
  ctx: ToolContext,
  rawDataUrl: unknown,
  label: string
): Promise<string | undefined> {
  try {
    if (typeof rawDataUrl === "string" && rawDataUrl.startsWith("data:image/")) {
      const shot = await downscaleDataUrl(rawDataUrl);
      ctx.appendDisplay(screenshotMarkdown(shot, label));
      ctx.syncDisplay();
      return shot;
    }
  } catch {}
  return undefined;
}

export async function runBrowserLane(
  call: ToolCall,
  ctx: ToolContext
): Promise<DispatchOutcome | null> {
  let toolResults = "";
  const result = (xml: string) => {
    toolResults += xml;
  };

  if (call.name?.startsWith("browser_")) {
    const bridge = (typeof window !== "undefined" ? (window as any).orplexDesktop?.agentBrowser : null) as any;
    if (!bridge) {
      // SERVER FALLBACK — one contract, Playwright-via-API backend. Op mapping,
      // arg validation, and result formatting live in agent/contract/browser.ts
      // (shared with the server executor); only transport (HTTP POST) + the
      // screenshot inline-attach stay lane-specific.
      try {
        const { browserOpOf, validateBrowserArgs, formatBrowserResult } = await import("./contract/browser");
        const toolName = String(call.name);
        const op = browserOpOf(toolName);
        if (!op) {
          result(`<tool_result name="${call.name}">error - browser op "${call.name}" is not available in server browser mode.</tool_result>\n`);
          ctx.replaceStatus(`[WARN] ${call.name} unsupported in server browser mode`);
          ctx.syncDisplay();
          return { resultXml: toolResults, blocked: false };
        }
        const argError = validateBrowserArgs(op, call as unknown as Record<string, unknown>);
        if (argError) {
          result(`<tool_result name="${call.name}">error - ${argError}</tool_result>\n`);
          ctx.replaceStatus(`[FAIL] ${call.name}: ${argError.slice(0, 60)}`);
          ctx.syncDisplay();
          return { resultXml: toolResults, blocked: false };
        }
        ctx.setStatus("tool_executing", `Browser ${op}…`);
        ctx.syncDisplay();
        const { url, selector, ref, text, value, key, dx, dy, amount, time, timeoutMs, role, action, index, fullPage, viewpoint, code } = call as unknown as Record<string, unknown>;
        const res = await apiFetch("/api/agent/browser", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op, url, selector, ref, text, value, key, dx, dy: (dy as number) ?? (amount as number), time, timeoutMs, role, tabAction: action, index, fullPage, viewpoint, code }),
          signal: ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
        });
        const r = await res.json().catch(() => ({ ok: false, error: "bad response from browser API" }));
        if (!r.ok) {
          result(`<tool_result name="${call.name}">error - ${r.error || "browser op failed"}</tool_result>\n`);
          ctx.replaceStatus(`[FAIL] ${call.name}: ${String(r.error || "failed").slice(0, 60)}`);
          ctx.syncDisplay();
          return { resultXml: toolResults, blocked: false };
        }
        const d = r.data || {};
        // Screenshot bytes ride out-of-band (inline attach); the text contract
        // still comes from the single formatter. The API lane returns raw
        // base64 (screenshotBase64); the bridge returns a data: URL — accept both.
        if (op === "screenshot") {
          const dd = d as Record<string, unknown>;
          const rawShot =
            typeof dd.screenshot === "string"
              ? dd.screenshot
              : typeof dd.screenshotBase64 === "string" && dd.screenshotBase64.length > 0
                ? `data:image/png;base64,${dd.screenshotBase64}`
                : undefined;
          const shot = await attachScreenshot(ctx, rawShot, `browser screenshot — ${String(dd.url || "page")}`);
          result(formatBrowserResult(toolName, op, { ok: true, data: d }));
          ctx.replaceStatus(`[OK] Screenshot captured`);
          if (shot) return { resultXml: toolResults, blocked: false, imageDataUrl: shot };
          ctx.syncDisplay();
          return { resultXml: toolResults, blocked: false };
        }
        result(formatBrowserResult(toolName, op, { ok: true, data: d }));
        ctx.replaceStatus(`[OK] Browser: ${String((d as Record<string, unknown>).title || (d as Record<string, unknown>).url || op)}`);
        ctx.syncDisplay();
        return { resultXml: toolResults, blocked: false };
      } catch (err) {
        result(`<tool_result name="${call.name}">error - server browser: ${(err as Error).message}</tool_result>\n`);
        ctx.replaceStatus(`[FAIL] ${call.name}`);
        ctx.syncDisplay();
        return { resultXml: toolResults, blocked: false };
      }
    }
    // Electron lane: transport is the IPC bridge (see electronBackend() in
    // contract/browser.ts for the backend adapter); arg validation is the
    // shared contract so all three browser lanes reject bad args identically.
    try {
      const { browserOpOf, validateBrowserArgs } = await import("./contract/browser");
      const { formatToolError } = await import("./contract/results");
      const laneOp = browserOpOf(String(call.name));
      const laneArgError = laneOp ? validateBrowserArgs(laneOp, call as unknown as Record<string, unknown>) : null;
      if (laneOp && laneArgError) {
        result(formatToolError(String(call.name), {}, laneArgError));
        ctx.replaceStatus(`[FAIL] ${call.name}: ${laneArgError.slice(0, 60)}`);
        ctx.syncDisplay();
        return { resultXml: toolResults, blocked: false };
      }
      if (call.name === "browser_navigate" && call.url) {
        ctx.setStatus("tool_executing", `Browsing to ${call.url}…`);
        ctx.appendDisplay(`browsing [${String(call.url).slice(0, 60)}]\n`);
        ctx.syncDisplay();
        // No floating overlay: bridge.show() lifted the agent's WebContentsView
        // over the whole app (stale bounds = a window floating on the chat).
        // Open the right panel on Preview and hand the URL to that panel's
        // EXISTING webview through the preview bus instead — the panel's own
        // URL bar, tabs, loading state and nav buttons drive it from there.
        window.dispatchEvent(new CustomEvent("orplex:open-panel", { detail: { tab: "preview" } }));
        emitPreview(String(call.url), "preview_browser");
        // The agent's own view still loads the page (headless — never shown)
        // so browser_read / browser_click keep working against it.
        const r = await bridge.navigate(String(call.url));
        if (r.ok) {
          result(`<tool_result name="browser_navigate" url="${r.url}">success — now on "${r.title || r.url}". Use browser_read to see the page content.</tool_result>\n`);
          ctx.replaceStatus(`[OK] Browser: ${r.title || r.url}`);
        } else {
          result(`<tool_result name="browser_navigate" url="${call.url}">error - ${r.error || "load failed"}</tool_result>\n`);
          ctx.replaceStatus(`[FAIL] Browser navigation failed`);
        }
      } else if (call.name === "browser_read") {
        ctx.setStatus("tool_executing", "Reading page…");
        const r = await bridge.read();
        if (r.ok) {
          const elements = await bridge.elements().catch(() => ({ ok: false }));
          const el = elements.ok ? elements : { links: [], buttons: [], inputs: [] };
          const linkList = (el.links || []).slice(0, 25).map((l: any) => `- "${l.text}" → ${l.href}`).join("\n");
          const buttonList = (el.buttons || []).slice(0, 15).map((b: any) => `- "${b.text}"`).join("\n");
          const inputList = (el.inputs || []).slice(0, 15).map((i: any) => `- ${i.tag}${i.name ? `[name=${i.name}]` : ""}${i.placeholder ? ` ("${i.placeholder}")` : ""}`).join("\n");
          result(`<tool_result name="browser_read">\nURL: ${r.url}\nTitle: ${r.title}\n\nPAGE TEXT (first 4000 chars):\n${String(r.text || "").slice(0, 4000)}\n\nHEADINGS:\n${(r.headings || []).join("\n")}\n\nLINKS:\n${linkList}\n\nBUTTONS:\n${buttonList}\n\nINPUTS:\n${inputList}\n</tool_result>\n`);
          ctx.replaceStatus(`[OK] Read "${r.title}" (${String(r.text || "").length} chars)`);
        } else {
          result(`<tool_result name="browser_read">error - ${r.error || "nothing loaded yet — navigate first"}</tool_result>\n`);
        }
      } else if (call.name === "browser_click" && (call.selector || call.ref)) {
        const target = String(call.ref || call.selector);
        ctx.setStatus("tool_executing", `Clicking ${target}…`);
        ctx.appendDisplay(`clicking [${target}]\n`);
        ctx.syncDisplay();
        const r = await bridge.interact({ kind: "click", selector: call.selector ? String(call.selector) : undefined, ref: call.ref ? String(call.ref) : undefined });
        result(r.ok
          ? `<tool_result name="browser_click" selector="${target}">success — clicked "${r.clicked ?? target}". Use browser_read to see the result.</tool_result>\n`
          : `<tool_result name="browser_click" selector="${target}">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Clicked ${target}` : `[FAIL] Click: ${r.error}`);
      } else if (call.name === "browser_type" && (call.selector || call.ref) && call.text !== undefined) {
        const target = String(call.ref || call.selector);
        const r = await bridge.interact({ kind: "type", selector: call.selector ? String(call.selector) : undefined, ref: call.ref ? String(call.ref) : undefined, text: String(call.text) });
        result(r.ok
          ? `<tool_result name="browser_type" selector="${target}">success — typed "${String(call.text).slice(0, 50)}" into "${r.typed ?? target}"</tool_result>\n`
          : `<tool_result name="browser_type" selector="${target}">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Typed ${String(call.text).length} chars` : `[FAIL] Type: ${r.error}`);
      } else if (call.name === "browser_press" && call.key) {
        const r = await bridge.interact({ kind: "press", key: String(call.key) });
        result(r.ok
          ? `<tool_result name="browser_press" key="${call.key}">success — key sent</tool_result>\n`
          : `<tool_result name="browser_press">error - ${r.error}</tool_result>\n`);
      } else if (call.name === "browser_scroll") {
        const r = await bridge.interact({ kind: "scroll", amount: typeof call.amount === "number" ? call.amount : 600 });
        result(`<tool_result name="browser_scroll">success — scrolled ${r.scrolled}px. Use browser_read to see the new content.</tool_result>\n`);
      } else if (call.name === "browser_console") {
        const r = await bridge.console();
        const msgs = (r.messages || []).map((m: any) => `[${m.level}] ${m.text}`).join("\n");
        result(`<tool_result name="browser_console">${msgs.length ? msgs : "No console messages since last navigation — no JS errors."}</tool_result>\n`);
        ctx.replaceStatus(`[OK] Console: ${(r.messages || []).length} message(s)`);
      } else if (call.name === "browser_screenshot") {
        ctx.setStatus("tool_executing", "Capturing browser…");
        ctx.syncDisplay();
        // Never bridge.show() — that attached the agent view above the app.
        // Ask the panel to display it as a tab instead (in-panel only).
        window.dispatchEvent(new CustomEvent("orplex:agent-browser-tab"));
        const d = await bridge.screenshot({ fullPage: !!call.fullPage, viewpoint: call.viewpoint });
        const vp = d?.viewport ? ` at ${d.viewport.width}x${d.viewport.height}` : "";
        const shot = await attachScreenshot(ctx, (d as any)?.screenshot, `browser screenshot — ${d?.url ?? "page"}`);
        result(`<tool_result name="browser_screenshot">success — screenshot captured${d?.fullPage ? " (full page)" : ""}${vp} (${d?.url ?? ""}) and attached inline in the chat below. The live view is shown in the preview panel; use browser_read for the text content.</tool_result>\n`);
        ctx.replaceStatus(`[OK] Screenshot captured`);
        ctx.syncDisplay();
        if (shot) return { resultXml: toolResults, blocked: false, imageDataUrl: shot };
      } else if (call.name === "browser_evaluate" && call.code) {
        const r = await bridge.evaluate(String(call.code));
        result(r.ok
          ? `<tool_result name="browser_evaluate">result: ${JSON.stringify(r.result)?.slice(0, 2000)}</tool_result>\n`
          : `<tool_result name="browser_evaluate">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Evaluated` : `[FAIL] Evaluate: ${r.error}`);
      } else if (call.name === "browser_find") {
        ctx.setStatus("tool_executing", "Finding elements…");
        ctx.syncDisplay();
        const r = await bridge.find({ text: call.text, role: call.role });
        if (!r.ok) {
          result(`<tool_result name="browser_find">error - ${r.error}</tool_result>\n`);
          ctx.replaceStatus(`[FAIL] Find: ${r.error}`);
        } else {
          const list = (r.matches || []).slice(0, 25).map((m: any) => `${m.ref}: ${m.role} "${m.name}" [${m.selector}]${m.enabled ? "" : " (disabled)"}`).join("\n");
          result(`<tool_result name="browser_find">\nMATCHES (${r.matches?.length ?? 0} of ${r.total} actionable elements):\n${list || "none"}\n\n${r.hint || ""}\n</tool_result>\n`);
          ctx.replaceStatus(`[OK] Find: ${r.matches?.length ?? 0} match(es)`);
        }
      } else if (call.name === "browser_wait_for" && (call.text !== undefined || call.selector || call.time !== undefined)) {
        ctx.setStatus("tool_executing", "Waiting…");
        ctx.syncDisplay();
        const r = await bridge.waitFor({ text: call.text, selector: call.selector, time: call.time, timeoutMs: call.timeoutMs });
        result(r.ok
          ? `<tool_result name="browser_wait_for">success — condition met after ${r.waitedMs}ms. Now on "${r.title || r.url}".</tool_result>\n`
          : `<tool_result name="browser_wait_for">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Wait ${r.waitedMs}ms` : `[FAIL] Wait: ${r.error}`);
      } else if (call.name === "browser_hover" && (call.selector || call.ref)) {
        const r = await bridge.hover({ selector: call.selector ? String(call.selector) : undefined, ref: call.ref ? String(call.ref) : undefined });
        result(r.ok
          ? `<tool_result name="browser_hover" selector="${r.hovered ?? (call.ref || call.selector)}">success — hovered. Check browser_screenshot/browser_read for what appeared.</tool_result>\n`
          : `<tool_result name="browser_hover">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Hovered` : `[FAIL] Hover: ${r.error}`);
      } else if (call.name === "browser_select" && call.value !== undefined && (call.selector || call.ref)) {
        const r = await bridge.select({ selector: call.selector ? String(call.selector) : undefined, ref: call.ref ? String(call.ref) : undefined, value: String(call.value) });
        result(r.ok
          ? `<tool_result name="browser_select" selector="${call.ref || call.selector}">success — selected "${r.selected}"${r.label ? ` (${r.label})` : ""}</tool_result>\n`
          : `<tool_result name="browser_select">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Selected` : `[FAIL] Select: ${r.error}`);
      } else if (call.name === "browser_tabs") {
        ctx.setStatus("tool_executing", "Tabs…");
        ctx.syncDisplay();
        const r = await bridge.tabs({ action: call.action, url: call.url, index: call.index });
        if (!r.ok) {
          result(`<tool_result name="browser_tabs">error - ${r.error}</tool_result>\n`);
          ctx.replaceStatus(`[FAIL] Tabs: ${r.error}`);
        } else {
          const tabs = (r.tabs || []).map((t: any) => `${t.active ? "→" : " "} [${t.index}] ${t.title || "(untitled)"} — ${t.url}`).join("\n");
          const head = r.opened !== undefined ? `opened tab [${r.opened}] ${r.url}` : r.switchedTo !== undefined ? `switched to tab [${r.switchedTo}]` : r.closed !== undefined ? `closed tab [${r.closed}]` : `${(r.tabs || []).length} tab(s) open`;
          result(`<tool_result name="browser_tabs">${head}\n${tabs}</tool_result>\n`);
          ctx.replaceStatus(`[OK] Tabs: ${(r.tabs || []).length} open`);
          if (r.opened !== undefined || r.switchedTo !== undefined) {
            // In-panel display only — never lift the view over the app.
            window.dispatchEvent(new CustomEvent("orplex:agent-browser-tab"));
          }
        }
      } else if (call.name === "browser_network") {
        const r = await bridge.network();
        const events = (r.events || []).map((e: any) => `${e.status ? `HTTP ${e.status}` : "ABORTED"} ${e.method} ${e.url}${e.error ? ` (${e.error})` : ""}`).join("\n");
        result(`<tool_result name="browser_network">${events || "No failed requests (no 4xx/5xx responses, no aborted requests)."}</tool_result>\n`);
        ctx.replaceStatus(`[OK] Network: ${r.failedRequests ?? 0} failed`);
      } else {
        result(`<tool_result name="${call.name}">error - missing required argument (url/selector/ref/key/code/value)</tool_result>\n`);
      }
    } catch (err) {
      result(`<tool_result name="${call.name}">error - ${(err as Error).message}</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] ${call.name}: ${(err as Error).message.slice(0, 60)}`);
    }
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // Unreachable when the dispatcher gated on the browser_ prefix; keeps the
  // promise type honest for the null return path.
  return null;
}
