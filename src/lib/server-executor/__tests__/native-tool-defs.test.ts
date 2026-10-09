// native-tool-defs.test.ts — buildNativeToolDefs: the built-in roster, MCP
// tool mapping (mcp__<server>__<tool>), and schema passthrough.
import { buildNativeToolDefs } from "../executor";

describe("buildNativeToolDefs", () => {
  it("exposes the built-in worktree tools with required args", () => {
    const defs = buildNativeToolDefs([]);
    const names = defs.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["write_file", "edit_file", "read_file", "list_files", "search_code", "run_command"]));
    const write = defs.find((d) => d.name === "write_file")!;
    expect(write.parameters).toMatchObject({ type: "object", required: ["path", "content"] });
    const edit = defs.find((d) => d.name === "edit_file")!;
    expect(edit.parameters).toMatchObject({ required: ["path", "old_text", "new_text"] });
  });

  it("exposes scratchpad_update with section enum (server parity)", () => {
    const defs = buildNativeToolDefs([]);
    const names = defs.map((d) => d.name);
    expect(names).toContain("scratchpad_update");
    const sp = defs.find((d) => d.name === "scratchpad_update")!;
    expect(sp.parameters).toMatchObject({ required: ["section", "content"] });
  });

  it("exposes the playbook tools with required args", () => {
    const defs = buildNativeToolDefs([]);
    const names = defs.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining(["playbook_search", "skill_create", "session_search"])
    );
    expect(defs.find((d) => d.name === "playbook_search")!.parameters).toMatchObject({
      required: ["query"],
    });
    expect(defs.find((d) => d.name === "skill_create")!.parameters).toMatchObject({
      required: ["title", "text"],
    });
    expect(defs.find((d) => d.name === "session_search")!.parameters).toMatchObject({
      required: ["query"],
    });
  });

  it("maps MCP tools to the mcp__server__tool convention with their schema", () => {
    const defs = buildNativeToolDefs([
      { server: "fs", name: "search", description: "Search files", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    ]);
    const mcp = defs.find((d) => d.name === "mcp__fs__search");
    expect(mcp).toBeDefined();
    expect(mcp!.description).toBe("Search files");
    expect(mcp!.parameters).toMatchObject({ type: "object", required: ["q"] });
  });

  it("degrades a non-object MCP inputSchema to a safe empty schema", () => {
    const defs = buildNativeToolDefs([{ server: "x", name: "t", description: "d", inputSchema: "garbage" }]);
    // The last def is now mcp_describe_tool (always-on meta tool). The MCP
    // tool's own schema is the second-to-last def; it degrades to the empty
    // object schema.
    const mcpDef = defs.find((d) => d.name === "mcp__x__t")!;
    expect(mcpDef.parameters).toEqual({ type: "object", properties: {} });
    // Always-on meta tools are present.
    expect(defs.some((d) => d.name === "mcp_search_tools")).toBe(true);
    expect(defs.some((d) => d.name === "mcp_describe_tool")).toBe(true);
  });

  it("merges SDK-lane snapshot tools (remoteTools) with stdio defs", () => {
    const defs = buildNativeToolDefs(
      [{ server: "fs", name: "search", description: "Search files", inputSchema: { type: "object" } }],
      [{ server: "github", name: "list_prs", description: "List PRs", inputSchema: { type: "object", properties: {} } }]
    );
    const names = defs.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["mcp__fs__search", "mcp__github__list_prs"]));
    expect(defs.find((d) => d.name === "mcp__github__list_prs")!.description).toBe("List PRs");
  });

  it("keeps every name (names-only) and adds meta tools when remoteTools pushes past the cap", () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      server: "big",
      name: `tool_${i}`,
      description: `Tool ${i}`,
      inputSchema: { type: "object" as const, properties: { q: { type: "string" } } },
    }));
    const defs = buildNativeToolDefs([], many);
    const names = defs.map((d) => d.name);
    const mcpNames = defs.filter((d) => d.name.startsWith("mcp__")).map((d) => d.name);
    expect(mcpNames).toContain("mcp__big__tool_44");
    expect(names).toEqual(expect.arrayContaining(["mcp_search_tools", "mcp_describe_tool"]));
    const stripped = defs.find((d) => d.name === "mcp__big__tool_44")!;
    expect(stripped.parameters).toMatchObject({ type: "object", properties: {} });
  });
});
