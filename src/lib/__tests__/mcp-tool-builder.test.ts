// mcp-tool-builder.test.ts — Phase 5 shared builder (C5): cap policy (C10),
// prompt section format, meta tools, metering char count.

import {
  buildMcpRoster,
  executeMcpMetaTool,
  mcpPromptSection,
  toOpenAiFunctions,
  MCP_TOOL_CAP,
  MCP_SEARCH_TOOL,
  MCP_DESCRIBE_TOOL,
  type BuilderTool,
} from "@/lib/mcp/tool-builder";

function tool(i: number, overrides: Partial<BuilderTool> = {}): BuilderTool {
  return {
    server: "github",
    name: `tool_${i}`,
    description: `Tool number ${i}`,
    inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] },
    ...overrides,
  };
}

describe("buildMcpRoster", () => {
  it("passes full schemas under the cap with the mcp__ naming convention", () => {
    const roster = buildMcpRoster([tool(1), tool(2)]);
    expect(roster.toolCount).toBe(2);
    expect(roster.overCap).toBe(false);
    expect(roster.defs).toHaveLength(2);
    expect(roster.defs[0].name).toBe("mcp__github__tool_1");
    expect(roster.defs[0].parameters).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
    // Meta-discovery tools (mcp_search_tools, mcp_describe_tool) are now
    // always present so the model can find tools not shown in the roster
    // (small servers, servers added after the prompt was built). Under the
    // cap they sit alongside full-schema defs; over the cap they're the only
    // schema path plus names-only for every real tool.
    expect(roster.metaDefs).toHaveLength(2);
    expect(roster.metaDefs.map((d) => d.name)).toEqual([MCP_SEARCH_TOOL, MCP_DESCRIBE_TOOL]);
    expect(roster.schemaChars).toBeGreaterThan(0);
  });

  it("trims long descriptions to the def cap and defaults malformed schemas", () => {
    const roster = buildMcpRoster([
      tool(1, { description: "x".repeat(500), inputSchema: "not-a-schema" }),
    ]);
    expect(roster.defs[0].description).toHaveLength(300);
    expect(roster.defs[0].parameters).toEqual({ type: "object", properties: {} });
  });

  it("dedupes by full name (first wins)", () => {
    const roster = buildMcpRoster([
      tool(1, { description: "first" }),
      tool(1, { description: "second" }),
    ]);
    expect(roster.toolCount).toBe(1);
    expect(roster.defs[0].description).toBe("first");
  });

  it("goes names-only over the cap with meta tools and NO silent drop (C10)", () => {
    const tools = Array.from({ length: MCP_TOOL_CAP + 1 }, (_, i) => tool(i));
    const roster = buildMcpRoster(tools);
    expect(roster.overCap).toBe(true);
    expect(roster.defs).toHaveLength(MCP_TOOL_CAP + 1);
    for (const d of roster.defs) {
      expect(d.parameters).toEqual({
        type: "object",
        properties: {},
        additionalProperties: true,
      });
    }
    expect(roster.metaDefs.map((d) => d.name)).toEqual([MCP_SEARCH_TOOL, MCP_DESCRIBE_TOOL]);
    // meta defs count toward the metered schema chars
    expect(roster.schemaChars).toBeGreaterThan(100);
  });

  it("groups servers with meta-provided labels and counts", () => {
    const roster = buildMcpRoster(
      [tool(1), tool(2), { ...tool(3), server: "linear", name: "issue" }],
      { serverMeta: { github: { label: "GitHub", description: "Issues & PRs" } } }
    );
    expect(roster.servers).toHaveLength(2);
    const gh = roster.servers.find((s) => s.name === "github");
    expect(gh).toMatchObject({ label: "GitHub", description: "Issues & PRs", toolCount: 2 });
    const lin = roster.servers.find((s) => s.name === "linear");
    expect(lin).toMatchObject({ label: "linear", toolCount: 1 });
  });

  it("handles the empty roster", () => {
    const roster = buildMcpRoster([]);
    expect(roster.toolCount).toBe(0);
    expect(roster.defs).toEqual([]);
    expect(roster.overCap).toBe(false);
    expect(mcpPromptSection(roster)).toBe("");
  });
});

describe("mcpPromptSection", () => {
  it("renders the per-server format under the cap with always-on discovery tools", () => {
    const roster = buildMcpRoster(
      [tool(1), { ...tool(3), server: "linear", name: "issue" }],
      { serverMeta: { github: { label: "GitHub" } } }
    );
    const section = mcpPromptSection(roster);
    expect(section).toContain("## MCP CONNECTOR TOOLS — 2 external tools");
    expect(section).toContain('### Server "GitHub"');
    expect(section).toContain("`mcp__github__tool_1`(a, b) — Tool number 1");
    expect(section).toContain('### Server "linear"');
    expect(section).toContain("`mcp__linear__issue`(a, b)");
    // Discovery tools are now always present (even under the cap) so the
    // model can find tools not shown in the prompt roster.
    expect(section).toContain(MCP_SEARCH_TOOL);
    expect(section).toContain(MCP_DESCRIBE_TOOL);
  });

  it("lists every name plus meta-tool guidance over the cap", () => {
    const tools = Array.from({ length: MCP_TOOL_CAP + 3 }, (_, i) => tool(i));
    const section = mcpPromptSection(buildMcpRoster(tools));
    expect(section).toContain(`## MCP CONNECTOR TOOLS — ${MCP_TOOL_CAP + 3} external tools`);
    expect(section).toContain(MCP_SEARCH_TOOL);
    expect(section).toContain(MCP_DESCRIBE_TOOL);
    expect(section).toContain("`mcp__github__tool_0`");
    expect(section).toContain(`\`mcp__github__tool_${MCP_TOOL_CAP + 2}\``);
    // names-only: parameter lists are gone
    expect(section).not.toContain("(a, b)");
  });
});

describe("toOpenAiFunctions", () => {
  it("wraps flat defs into the chat-completions tools shape", () => {
    const roster = buildMcpRoster([tool(1)]);
    const wrapped = toOpenAiFunctions(roster.defs);
    expect(wrapped).toEqual([
      { type: "function", function: roster.defs[0] },
    ]);
  });
});

describe("executeMcpMetaTool", () => {
  const tools: BuilderTool[] = [
    tool(1, { name: "create_issue", description: "Create a GitHub issue with labels" }),
    tool(2, { name: "list_prs", description: "List pull requests" }),
    { ...tool(3), server: "linear", name: "create_issue", description: "Create a Linear issue" },
  ];

  it("search matches names, descriptions, and server ids", () => {
    const out = executeMcpMetaTool(MCP_SEARCH_TOOL, { query: "issue" }, tools);
    expect(out).toContain("2 match(es)");
    expect(out).toContain("mcp__github__create_issue");
    expect(out).toContain("mcp__linear__create_issue");
    expect(out).not.toContain("mcp__github__list_prs");
    expect(out).toContain(MCP_DESCRIBE_TOOL);
  });

  it("search with no match lists candidates and stays actionable", () => {
    const out = executeMcpMetaTool(MCP_SEARCH_TOOL, { query: "zzz" }, tools);
    expect(out).toContain('No MCP tools match "zzz"');
    expect(out).toContain("mcp__github__create_issue");
  });

  it("search rejects an empty query", () => {
    expect(executeMcpMetaTool(MCP_SEARCH_TOOL, {}, tools)).toContain("requires a non-empty");
  });

  it("describe returns the full schema JSON for a full name", () => {
    const out = executeMcpMetaTool(MCP_DESCRIBE_TOOL, { tool: "mcp__github__create_issue" }, tools);
    const parsed = JSON.parse(out);
    expect(parsed.tool).toBe("mcp__github__create_issue");
    expect(parsed.parameters.properties).toHaveProperty("a");
    expect(parsed.description).toContain("GitHub issue");
  });

  it("describe on an unknown name errors with close matches", () => {
    const out = executeMcpMetaTool(MCP_DESCRIBE_TOOL, { tool: "mcp__github__create_issu" }, tools);
    expect(out).toContain("not found");
    expect(out).toContain("mcp__github__create_issue");
  });

  it("rejects unknown meta tool names and missing tool args", () => {
    expect(executeMcpMetaTool("mcp_frobnicate", {}, tools)).toContain("unknown meta tool");
    expect(executeMcpMetaTool(MCP_DESCRIBE_TOOL, {}, tools)).toContain('requires "tool"');
  });
});

// === E2E: the exact payload the worker sends → what the model's prompt sees ===
// Regression for the two-half-wired bug: the worker built `mcpRemotes` but the
// reader sent a `mcpRoster` field the zod schema silently dropped, so legacy
// (localStorage) connectors never reached the prompt and the AI could not see
// the user's connected servers or their tools.
describe("legacy remotes reach the prompt (worker payload → chat route)", () => {
  it("a legacy remote's tools appear in the MCP prompt section", () => {
    // Shaped exactly like chat/route.ts: validators parse → BuilderTool[] → roster.
    const parsed = {
      mcpRemotes: [
        {
          id: "demo",
          label: "Demo Server",
          url: "https://example.com/mcp",
          auth: "bearer" as const,
          tools: [{ name: "demo_tool", description: "Does a demo", inputSchema: { type: "object", properties: {} } }],
        },
      ],
    };
    const legacyTools: BuilderTool[] = (parsed.mcpRemotes ?? []).flatMap((r) =>
      (r.tools ?? []).map((t) => ({
        server: r.id,
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      }))
    );
    const roster = buildMcpRoster(legacyTools, {
      serverMeta: Object.fromEntries(legacyTools.map((t) => [t.server, { label: "Demo Server" }])),
    });
    const section = mcpPromptSection(roster);

    expect(roster.toolCount).toBe(1);
    expect(roster.defs[0].name).toBe("mcp__demo__demo_tool");
    expect(section).toContain("demo_tool");
    expect(section).toContain("Demo Server");
  });
});
