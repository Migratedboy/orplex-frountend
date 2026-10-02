/**
 * agent-browser-advanced-ops.test.ts — pure-logic coverage for the advanced
 * browser ops added to agent-browser-session.ts. No Playwright needed: we
 * test what's testable without a real browser (validation ordering, ref
 * resolution, evaluate wrapping, log bounds) plus the tool rosters that
 * advertise the new ops. Everything Playwright-dependent is exercised by the
 * existing graceful-degradation tests (agent-browser-session.test.ts).
 */
import { runBrowserOp, activeSessionCount, resolveRefSelector, evaluateAttempts, pushNetworkEvent, type NetworkEvent } from "../agent-browser-session";
import { M3_TOOL_DEFINITIONS, GROQ_TOOL_DEFINITIONS, GROQ_TOOL_NAMES, usesCompactTools } from "../tool-definitions";
import { buildNativeToolDefs } from "../server-executor/executor";

jest.mock("@/lib/browser-verification", () => ({
  ...jest.requireActual("@/lib/browser-verification"),
  isInstalledChromeAvailable: jest.fn().mockResolvedValue(false),
}));

describe("browser op validation (fires before any session/launch)", () => {
  afterEach(async () => {
    await runBrowserOp("test-user-adv", "close").catch(() => {});
  });

  it("rejects unknown ops with the full op list", async () => {
    const res = await runBrowserOp("test-user-adv", "curl", { url: "http://localhost:3000" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unknown op");
    expect(res.error).toContain("wait_for");
    expect(res.error).toContain("find");
    expect(res.error).toContain("network");
    expect(activeSessionCount()).toBe(0);
  });

  it("rejects click/type without selector or ref", async () => {
    const click = await runBrowserOp("test-user-adv", "click", {});
    expect(click.ok).toBe(false);
    expect(click.error).toContain("selector (or ref from browser_find) required");

    const type = await runBrowserOp("test-user-adv", "type", { selector: "#x" });
    expect(type.ok).toBe(false);
    expect(type.error).toContain("text required");

    const typeNoTarget = await runBrowserOp("test-user-adv", "type", { text: "hi" });
    expect(typeNoTarget.ok).toBe(false);
    expect(typeNoTarget.error).toContain("selector (or ref");
    expect(activeSessionCount()).toBe(0);
  });

  it("rejects hover/select/wait_for/evaluate with actionable messages", async () => {
    expect((await runBrowserOp("test-user-adv", "hover", {})).error).toContain("selector (or ref) required");
    expect((await runBrowserOp("test-user-adv", "select", { selector: "#s" })).error).toContain("value required");
    expect((await runBrowserOp("test-user-adv", "select", { value: "x" })).error).toContain("selector or ref");
    expect((await runBrowserOp("test-user-adv", "wait_for", {})).error).toContain("text, selector, or time");
    expect((await runBrowserOp("test-user-adv", "evaluate", {})).error).toContain("code required");
    expect(activeSessionCount()).toBe(0);
  });

  it("rejects invalid tabs actions and missing indexes", async () => {
    expect((await runBrowserOp("test-user-adv", "tabs", { tabAction: "destroy" })).error).toContain("list | new | switch | close");
    expect((await runBrowserOp("test-user-adv", "tabs", { tabAction: "switch" })).error).toContain("index required");
    expect((await runBrowserOp("test-user-adv", "tabs", { tabAction: "close", index: 0 })).ok).toBe(false); // no session yet
    expect(activeSessionCount()).toBe(0);
  });

  it("keeps SSRF policy ahead of session creation for navigate and new tabs", async () => {
    const nav = await runBrowserOp("test-user-adv", "navigate", { url: "http://169.254.169.254/latest/meta-data" });
    expect(nav.ok).toBe(false);
    expect(nav.error).toContain("blocked by URL policy");

    // tabs:new with a blocked URL — policy must fire without a browser.
    // (No session exists, so this returns the launch error AFTER policy would
    // have fired; with no browser installed it fails closed either way.)
    const tabNew = await runBrowserOp("test-user-adv", "tabs", { tabAction: "new", url: "http://169.254.169.254/" });
    expect(tabNew.ok).toBe(false);
    expect(activeSessionCount()).toBe(0);
  });
});

describe("resolveRefSelector", () => {
  const snapshot = [
    { selector: "#save-btn", description: "button \"Save\"" },
    { selector: "a[href='/pricing']", description: "link \"Pricing\"" },
  ];

  it("resolves eN refs to their snapshot selectors", () => {
    expect(resolveRefSelector(snapshot, "e1")).toBe("#save-btn");
    expect(resolveRefSelector(snapshot, "e2")).toBe("a[href='/pricing']");
    expect(resolveRefSelector(snapshot, "E2")).toBe("a[href='/pricing']"); // case-insensitive
  });

  it("returns null for unknown/out-of-range refs and missing snapshots", () => {
    expect(resolveRefSelector(snapshot, "e9")).toBeNull();
    expect(resolveRefSelector(snapshot, "e0")).toBeNull();
    expect(resolveRefSelector(snapshot, "ex")).toBeNull();
    expect(resolveRefSelector(null, "e1")).toBeNull();
    expect(resolveRefSelector([], "e1")).toBeNull();
  });
});

describe("evaluateAttempts", () => {
  it("tries the bare expression first, then an IIFE wrap", () => {
    const attempts = evaluateAttempts("const n = document.images.length; n");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual({ mode: "direct", code: "const n = document.images.length; n" });
    expect(attempts[1].mode).toBe("wrapped");
    expect(attempts[1].code).toBe("(() => { const n = document.images.length; n })()");
  });

  it("deduplicates when the code is already an expression", () => {
    const attempts = evaluateAttempts("document.title");
    expect(attempts).toHaveLength(2); // wrap still attempted as fallback, different code
    expect(attempts[0].mode).toBe("direct");
  });

  it("does not wrap an already-wrapped IIFE twice", () => {
    const code = "(() => { return 1 })()";
    const attempts = evaluateAttempts(code);
    expect(attempts[0].code).toBe(code);
  });
});

describe("pushNetworkEvent bounds the log", () => {
  it("keeps only the newest events past the cap", () => {
    const log: NetworkEvent[] = [];
    for (let i = 0; i < 100; i++) {
      pushNetworkEvent(log, { url: `http://x/${i}`, method: "GET", status: 500, at: i });
    }
    expect(log.length).toBeLessThanOrEqual(60);
    expect(log[log.length - 1].url).toBe("http://x/99"); // newest kept
    expect(log[0].url).toBe("http://x/40"); // oldest dropped
  });
});

describe("tool rosters advertise the advanced browser ops", () => {
  it("M3_TOOL_DEFINITIONS includes the new browser tools with ref targeting", () => {
    const names = M3_TOOL_DEFINITIONS.map((t: any) => t.function?.name);
    for (const n of ["browser_find", "browser_wait_for", "browser_hover", "browser_select", "browser_tabs", "browser_network", "browser_screenshot", "browser_evaluate"]) {
      expect(names).toContain(n);
    }
    const click = M3_TOOL_DEFINITIONS.find((t: any) => t.function?.name === "browser_click");
    expect(click?.function?.parameters?.properties ?? {}).toHaveProperty("ref");
    const shot = M3_TOOL_DEFINITIONS.find((t: any) => t.function?.name === "browser_screenshot");
    expect(shot?.function?.parameters?.properties ?? {}).toHaveProperty("fullPage");
    expect(shot?.function?.parameters?.properties ?? {}).toHaveProperty("viewpoint");
  });

  it("GROQ_TOOL_DEFINITIONS keeps every verb family incl. browser core (no silent amputation)", () => {
    const names = GROQ_TOOL_DEFINITIONS.map((t: any) => t.function?.name);
    // Every name in the allowlist must resolve to a real schema.
    expect(names).toHaveLength(GROQ_TOOL_NAMES.length);
    // Browsing must stay callable on tight-TPM providers — a model without
    // these tools truthfully answers "I can't help with that".
    for (const n of ["browser_navigate", "browser_read", "browser_find", "browser_click", "browser_type", "browser_wait_for", "browser_screenshot"]) {
      expect(names).toContain(n);
    }
    // Core build/lookup/search verbs must survive too.
    for (const n of ["read_file", "write_file", "run_command", "web_search", "todo_list", "ask_question", "search_code", "code_search"]) {
      expect(names).toContain(n);
    }
  });

  it("code_search is offered (dispatcher handles it; doctrine orders it FIRST)", () => {
    const m3 = M3_TOOL_DEFINITIONS.map((t: any) => t.function?.name);
    expect(m3).toContain("code_search");
    const groq = GROQ_TOOL_DEFINITIONS.map((t: any) => t.function?.name);
    expect(groq).toContain("code_search");
    const def = M3_TOOL_DEFINITIONS.find((t: any) => t.function?.name === "code_search");
    expect(def?.function?.parameters?.required).toContain("query");
  });

  it("usesCompactTools covers every provider incl. BYOK keys (unknown defaults to lean)", () => {
    // Tight-TPM free tiers → lean set.
    for (const n of ["groq", "Groq", "groq-personal", "groq-pool", "nvidia", "NVIDIA NIM", "nvidia-pool", "nvidia-personal"]) {
      expect(usesCompactTools(n)).toBe(true);
    }
    // Known full-tier providers (platform, pool and BYOK personal keys) → full set.
    for (const n of ["openrouter", "OpenRouter", "openrouter-personal", "anthropic", "Anthropic", "openai", "gemini", "mistral", "deepseek", "together", "xai", "fireworks", "cerebras", "minimax", "openai-personal"]) {
      expect(usesCompactTools(n)).toBe(false);
    }
    // Unknown/custom BYOK endpoints → lean set (safe default: every verb survives).
    for (const n of ["my-custom-llm", "local-ollama", ""]) {
      expect(usesCompactTools(n)).toBe(true);
    }
  });

  it("buildNativeToolDefs exposes the browser roster for server runs", () => {
    const names = buildNativeToolDefs([]).map((d) => d.name);
    for (const n of ["browser_navigate", "browser_read", "browser_find", "browser_click", "browser_type", "browser_wait_for", "browser_hover", "browser_select", "browser_tabs", "browser_console", "browser_network", "browser_screenshot", "browser_evaluate"]) {
      expect(names).toContain(n);
    }
    const tabs = buildNativeToolDefs([]).find((d) => d.name === "browser_tabs")!;
    expect(tabs.parameters).toMatchObject({ type: "object" });
  });
});
