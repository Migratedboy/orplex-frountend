// mcp-risk-hint.test.ts — approval hints for mcp__ tools in the browser lane:
// server annotations + the per-server auto-approve-read-only toggle (C6),
// with localStorage stubbed (node test environment).
import { approvalKey } from "../approval-store";
import { MCP_PREFS_KEY, assessMcpToolRisk, getMcpRiskHint, loadMcpServerPrefs, saveMcpServerPrefs } from "../mcp/risk-hint";
import type { McpRemoteServer } from "../mcp/registry";

// In-memory localStorage stub shared by risk-hint (prefs) and registry (tools).
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

function seedServer(tools: McpRemoteServer["tools"]): void {
  const server: McpRemoteServer = {
    id: "acme-cloud",
    label: "Acme",
    url: "https://mcp.acme.test/mcp",
    auth: "oauth",
    tools,
  };
  store.set("orplex.mcp.remotes.v1", JSON.stringify([server]));
}

beforeEach(() => {
  store.clear();
});

describe("getMcpRiskHint", () => {
  it("reads ToolAnnotations from the registry's cached tools", () => {
    seedServer([{ name: "list_items", description: "", inputSchema: {}, annotations: { readOnlyHint: true } }]);
    expect(getMcpRiskHint("mcp__acme-cloud__list_items")).toEqual({ readOnlyHint: true });
  });

  it("surfaces destructiveHint alongside prefs", () => {
    seedServer([{ name: "wipe", description: "", inputSchema: {}, annotations: { destructiveHint: true } }]);
    saveMcpServerPrefs("acme-cloud", { autoApproveReadOnly: true });
    expect(getMcpRiskHint("mcp__acme-cloud__wipe")).toEqual({ destructiveHint: true, serverAutoApproveReadOnly: true });
  });

  it("returns an empty hint for unknown names/servers (fail closed upstream)", () => {
    expect(getMcpRiskHint("read_file")).toEqual({});
    expect(getMcpRiskHint("mcp__ghost__tool")).toEqual({});
    expect(getMcpRiskHint("mcp__broken")).toEqual({});
  });
});

describe("per-server auto-approve-read-only pref", () => {
  it("persists per server without clobbering siblings", () => {
    saveMcpServerPrefs("acme-cloud", { autoApproveReadOnly: true });
    saveMcpServerPrefs("other", { autoApproveReadOnly: false });
    expect(loadMcpServerPrefs("acme-cloud")).toEqual({ autoApproveReadOnly: true });
    expect(loadMcpServerPrefs("other")).toEqual({ autoApproveReadOnly: false });
    expect(loadMcpServerPrefs("never-set")).toEqual({});
    // Merge-patch keeps other keys.
    saveMcpServerPrefs("acme-cloud", {});
    expect(loadMcpServerPrefs("acme-cloud").autoApproveReadOnly).toBe(true);
  });

  it("tolerates corrupted storage", () => {
    store.set(MCP_PREFS_KEY, "{not json");
    expect(loadMcpServerPrefs("acme-cloud")).toEqual({});
    saveMcpServerPrefs("acme-cloud", { autoApproveReadOnly: true });
    expect(loadMcpServerPrefs("acme-cloud").autoApproveReadOnly).toBe(true);
  });
});

describe("assessMcpToolRisk — wire-up with classifyRisk (C6)", () => {
  it("read-only tool + toggle → low / auto-approved", () => {
    seedServer([{ name: "list_items", description: "", inputSchema: {}, annotations: { readOnlyHint: true } }]);
    saveMcpServerPrefs("acme-cloud", { autoApproveReadOnly: true });
    const r = assessMcpToolRisk("mcp__acme-cloud__list_items");
    expect(r).toMatchObject({ level: "low", autoApprovable: true });
  });

  it("read-only tool WITHOUT toggle → medium / approval required", () => {
    seedServer([{ name: "list_items", description: "", inputSchema: {}, annotations: { readOnlyHint: true } }]);
    const r = assessMcpToolRisk("mcp__acme-cloud__list_items");
    expect(r).toMatchObject({ level: "medium", autoApprovable: false });
  });

  it("toggle WITHOUT an annotation stays medium (server must declare read-only)", () => {
    seedServer([{ name: "mutate", description: "", inputSchema: {} }]);
    saveMcpServerPrefs("acme-cloud", { autoApproveReadOnly: true });
    const r = assessMcpToolRisk("mcp__acme-cloud__mutate");
    expect(r).toMatchObject({ level: "medium", autoApprovable: false });
  });

  it("destructiveHint → elevated tier even with the toggle on", () => {
    seedServer([{ name: "wipe", description: "", inputSchema: {}, annotations: { destructiveHint: true } }]);
    saveMcpServerPrefs("acme-cloud", { autoApproveReadOnly: true });
    const r = assessMcpToolRisk("mcp__acme-cloud__wipe");
    expect(r).toMatchObject({ level: "high", autoApprovable: false });
  });

  it("no annotation at all → medium with the side-effects reason", () => {
    seedServer([{ name: "do_thing", description: "", inputSchema: {} }]);
    const r = assessMcpToolRisk("mcp__acme-cloud__do_thing");
    expect(r).toMatchObject({ level: "medium", autoApprovable: false });
    expect(r.reason).toMatch(/side effects/);
  });

  it("unregistered server → medium (fail closed)", () => {
    const r = assessMcpToolRisk("mcp__ghost__tool");
    expect(r).toMatchObject({ level: "medium", autoApprovable: false });
  });
});

describe("approvalKey — mcp_tool always-allow identity", () => {
  it("keys on the full qualified tool name", () => {
    expect(approvalKey("mcp_tool", { tool: "mcp__acme-cloud__list_items" })).toBe("mcp__acme-cloud__list_items");
    expect(approvalKey("mcp_tool", { tool: "MCP__Acme__X" })).toBe("mcp__acme__x");
    expect(approvalKey("mcp_tool", {})).toBe("");
  });
});
