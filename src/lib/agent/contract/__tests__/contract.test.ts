// contract.test.ts — The shared tool-loop contract both execution modes use.
import {
  browserOpOf,
  validateBrowserArgs,
  formatBrowserResult,
  runBrowserTool,
  formatToolResult,
  formatToolError,
  validateToolArgs,
  READ_ONLY_TOOLS,
  createLoopStreaks,
  trackToolTurn,
  classifyRisk,
  createScratchpad,
  updateScratchpadSection,
  renderScratchpadBlock,
  type BrowserBackend,
} from "..";

describe("contract/results", () => {
  it("wraps name+attrs+body in one dialect", () => {
    expect(formatToolResult("read_file", { path: "a.ts" }, "hi")).toBe(
      `<tool_result name="read_file" path="a.ts">hi</tool_result>\n`
    );
  });
  it("escapes attr quotes", () => {
    expect(formatToolResult("x", { u: 'a"b' }, "")).toContain('u="a&quot;b"');
  });
  it("error shorthand prefixes error -", () => {
    expect(formatToolError("browser_read", {}, "nope")).toContain("error - nope");
  });
});

describe("contract/browser", () => {
  it("maps browser_click to click, rejects non-browser tools", () => {
    expect(browserOpOf("browser_click")).toBe("click");
    expect(browserOpOf("read_file")).toBeNull();
    expect(browserOpOf("browser_fly")).toBeNull();
  });
  it("validates required args before any launch", () => {
    expect(validateBrowserArgs("navigate", {})).toMatch(/url/);
    expect(validateBrowserArgs("navigate", { url: "https://x" })).toBeNull();
    expect(validateBrowserArgs("click", {})).toMatch(/selector/);
    expect(validateBrowserArgs("evaluate", {})).toMatch(/code/);
  });
  it("formats navigate/read through one formatter", () => {
    const nav = formatBrowserResult("browser_navigate", "navigate", {
      ok: true,
      data: { url: "https://x", title: "X" },
    });
    expect(nav).toContain('url="https://x"');
    expect(nav).toContain("Use browser_read");
    const err = formatBrowserResult("browser_read", "read", { ok: false, error: "boom" });
    expect(err).toContain("error - boom");
  });
  it("keeps find matches, console lines, network events, tabs (no silent ok)", () => {
    const find = formatBrowserResult("browser_find", "find", {
      ok: true,
      data: { matches: [{ ref: "e1", role: "button", name: "Go", selector: "#go", enabled: true }], total: 1, hint: "use refs" },
    });
    expect(find).toContain('e1: button "Go"');
    const con = formatBrowserResult("browser_console", "console", {
      ok: true,
      data: { messages: [{ type: "error", text: "x is not defined" }] },
    });
    expect(con).toContain("x is not defined");
    const net = formatBrowserResult("browser_network", "network", {
      ok: true,
      data: { events: [{ status: 500, method: "GET", url: "https://x/api" }] },
    });
    expect(net).toContain("HTTP 500");
    const tabs = formatBrowserResult("browser_tabs", "tabs", {
      ok: true,
      data: { tabs: [{ active: true, index: 0, title: "T", url: "https://x" }] },
    });
    expect(tabs).toContain("https://x");
    const wait = formatBrowserResult("browser_wait_for", "wait_for", { ok: true, data: { waitedMs: 120 } });
    expect(wait).toContain("120ms");
  });
  it("does not double-encode evaluate results", () => {
    const out = formatBrowserResult("browser_evaluate", "evaluate", { ok: true, data: { result: "42" } });
    expect(out).toContain("result: 42");
    expect(out).not.toContain('"42"');
  });
  it("runBrowserTool validates before touching the backend", async () => {
    const calls: string[] = [];
    const backend: BrowserBackend = {
      kind: "playwright",
      async run(op, _args) {
        calls.push(op);
        return { ok: true, data: { url: "https://x" } };
      },
    };
    const bad = await runBrowserTool(backend, "browser_navigate", {});
    expect(bad).toMatch(/url required/);
    expect(calls).toEqual([]);
    const good = await runBrowserTool(backend, "browser_navigate", { url: "https://x" });
    expect(calls).toEqual(["navigate"]);
    expect(good).toContain("https://x");
  });
});

describe("contract/tools", () => {
  it("requires path/content for file writes", () => {
    expect(validateToolArgs("write_file", {})).toMatch(/path/);
    expect(validateToolArgs("write_file", { path: "a" })).toMatch(/content/);
    expect(validateToolArgs("write_file", { path: "a", content: "b" })).toBeNull();
    expect(validateToolArgs("scratchpad_update", { section: "bogus", content: "x" })).toMatch(/section/);
  });
  it("read-only set exempts sensors", () => {
    expect(READ_ONLY_TOOLS.has("browser_read")).toBe(true);
  });
});

describe("contract/loop+risk+scratchpad (shared instances)", () => {
  it("loop streaks trip on identical repeats", () => {
    const s = createLoopStreaks();
    const call = { name: "read_file", path: "a" };
    let v = trackToolTurn(s, [call]);
    v = trackToolTurn(s, [call]);
    v = trackToolTurn(s, [call]);
    expect(v.loop).toBe(true);
  });
  it("risk classifies reads low", () => {
    expect(classifyRisk("read_file", {}).level).toBe("low");
  });
  it("scratchpad renders sections", () => {
    const s = updateScratchpadSection(createScratchpad(), "plan", "do things", 1);
    expect(renderScratchpadBlock(s)).toContain("plan: do things");
  });
});
