/**
 * mcp-remote.test.ts — pure helpers of the local remote-MCP stack:
 * tool-name mapping (mcp__<server>__<tool>), URL slugging, token expiry, the
 * JSON/SSE JSON-RPC payload splitter, and the system-prompt MCP section
 * (localStorage stubbed — the jest suite runs in a node environment).
 */
import {
  mcpToolName,
  parseMcpToolName,
  remoteIdFor,
  isTokenUsable,
  type McpRemoteServer,
} from "../mcp/registry";
import { parseRpcPayload } from "../mcp/client";
import { buildMcpToolsSection } from "../master-prompt";

describe("mcp tool-name mapping", () => {
  it("roundtrips mcpToolName ↔ parseMcpToolName", () => {
    const name = mcpToolName("mcp-linear-app", "create_issue");
    expect(name).toBe("mcp__mcp-linear-app__create_issue");
    expect(parseMcpToolName(name)).toEqual({ serverId: "mcp-linear-app", toolName: "create_issue" });
  });

  it("parses tool names containing underscores", () => {
    expect(parseMcpToolName("mcp__srv__search__deep")).toEqual({ serverId: "srv", toolName: "search__deep" });
  });

  it("rejects non-MCP names", () => {
    expect(parseMcpToolName("read_file")).toBeNull();
    expect(parseMcpToolName("mcp__")).toBeNull();
    expect(parseMcpToolName("mcp__onlyserver")).toBeNull();
  });
});

describe("remoteIdFor", () => {
  it("slugs host + path", () => {
    expect(remoteIdFor("https://mcp.linear.app/mcp")).toBe("mcp.linear.appmcp");
    expect(remoteIdFor("https://server.example.com/api/mcp/")).toBe("server.example.comapimcp");
  });

  it("falls back to a generated id on malformed URLs", () => {
    expect(remoteIdFor("not a url")).toMatch(/^remote-/);
  });
});

describe("isTokenUsable", () => {
  const base: McpRemoteServer = { id: "x", label: "X", url: "https://x/mcp", auth: "oauth" };

  it("none-auth servers are always usable", () => {
    expect(isTokenUsable({ ...base, auth: "none" })).toBe(true);
  });

  it("bearer requires a token", () => {
    expect(isTokenUsable({ ...base, auth: "bearer" })).toBe(false);
    expect(isTokenUsable({ ...base, auth: "bearer", bearerToken: "t" })).toBe(true);
  });

  it("oauth requires an access token", () => {
    expect(isTokenUsable(base)).toBe(false);
  });

  it("unexpired tokens are usable", () => {
    expect(isTokenUsable({ ...base, tokens: { accessToken: "a", tokenType: "Bearer", clientId: "c", obtainedAt: 0, expiresAt: Date.now() + 60_000 } })).toBe(true);
  });

  it("expired tokens are not usable (30s skew margin)", () => {
    expect(isTokenUsable({ ...base, tokens: { accessToken: "a", tokenType: "Bearer", clientId: "c", obtainedAt: 0, expiresAt: Date.now() + 10_000 } })).toBe(false);
  });

  it("tokens without expiry are usable (server did not say)", () => {
    expect(isTokenUsable({ ...base, tokens: { accessToken: "a", tokenType: "Bearer", clientId: "c", obtainedAt: 0 } })).toBe(true);
  });
});

describe("parseRpcPayload", () => {
  it("reads plain-JSON responses and matches the id", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
    expect(parseRpcPayload(body, "application/json", 7)).toMatchObject({ id: 7 });
    expect(parseRpcPayload(body, "application/json", 8)).toBeNull();
  });

  it("reads the matching event from an SSE body", () => {
    const sse = [
      ": ping",
      `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"id":7}}`,
      "",
      `data: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"hi"}]}}`,
      "",
    ].join("\n");
    const payload = parseRpcPayload(sse, "text/event-stream", 7);
    expect(payload).toMatchObject({ id: 7 });
    expect(parseRpcPayload(sse, "text/event-stream", 9)).toBeNull();
  });

  // Real servers (e.g. DeepWiki) emit CRLF SSE — regression-locked.
  it("reads SSE bodies with CRLF line endings and event lines", () => {
    const sse = [
      "event: message",
      `data: {"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"ask_wiki_question"}]}}`,
      "",
    ].join("\r\n");
    expect(parseRpcPayload(sse, "text/event-stream", 3)).toMatchObject({ id: 3 });
  });
});

describe("buildMcpToolsSection", () => {
  const STORE_KEY = "orplex.mcp.remotes.v1";
  const remote: McpRemoteServer = {
    id: "mcp-linear-app",
    label: "Linear",
    url: "https://mcp.linear.app/mcp",
    auth: "oauth",
    tools: [
      { name: "create_issue", description: "Create a Linear issue", inputSchema: { type: "object", properties: { title: { type: "string" }, team: { type: "string" } }, required: ["title"] } },
      { name: "list_issues", description: "List issues", inputSchema: { type: "object", properties: {} } },
    ],
  };

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("returns empty string when nothing is connected", () => {
    expect(buildMcpToolsSection()).toBe("");
  });

  it("renders connected tools with mcp__ names and params", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (k === STORE_KEY ? JSON.stringify([remote]) : null),
    };
    const section = buildMcpToolsSection();
    expect(section).toContain("MCP CONNECTOR TOOLS — 2");
    expect(section).toContain("mcp__mcp-linear-app__create_issue");
    expect(section).toContain("(title, team)");
    expect(section).toContain("Create a Linear issue");
    expect(section).toContain('### Server "Linear"');
  });
});
