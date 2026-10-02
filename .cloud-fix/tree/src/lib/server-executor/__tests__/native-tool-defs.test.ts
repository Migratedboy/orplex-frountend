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
    expect(defs[defs.length - 1].parameters).toEqual({ type: "object", properties: {} });
  });
});
