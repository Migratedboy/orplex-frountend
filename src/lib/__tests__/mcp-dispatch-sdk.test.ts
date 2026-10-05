// mcp-dispatch-sdk.test.ts — the SDK-lane dispatcher: one POST through
// /api/agent/mcp/call, the shared tool_result contract, and honest error
// mapping (reconnect hint, cooldown, truncation).
jest.mock("@/lib/api-base", () => ({ apiFetch: jest.fn() }));

import { apiFetch } from "@/lib/api-base";
import { dispatchMcpToolCallSdk } from "../mcp/dispatch";

const apiFetchMock = apiFetch as jest.Mock;

const ctx = () => ({
  setStatus: jest.fn(),
  appendDisplay: jest.fn(),
  syncDisplay: jest.fn(),
});

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

describe("dispatchMcpToolCallSdk", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rejects non-MCP names without calling the API", async () => {
    const c = ctx();
    const r = await dispatchMcpToolCallSdk({ name: "read_file", path: "a" }, c);
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(r.resultXml).toContain("Invalid MCP tool name");
    expect(r.blocked).toBe(false);
  });

  it("POSTs server/tool/args and wraps the text in tool_result", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ success: true, text: "42 rows", isError: false })
    );
    const c = ctx();
    const r = await dispatchMcpToolCallSdk({ name: "mcp__db__query", sql: "SELECT 1" }, c);
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/agent/mcp/call",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(apiFetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ serverId: "db", tool: "query", args: { sql: "SELECT 1" } });
    expect(r.resultXml).toContain("<tool_result name=\"mcp__db__query\">");
    expect(r.resultXml).toContain("42 rows");
    expect(r.resultXml).not.toContain("[TOOL ERROR]");
    expect(r.blocked).toBe(false);
  });

  it("marks tool errors in the result without failing the call", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ success: true, text: "not found", isError: true })
    );
    const r = await dispatchMcpToolCallSdk({ name: "mcp__db__query" }, ctx());
    expect(r.resultXml).toContain("[TOOL ERROR]");
    expect(r.resultXml).toContain("not found");
    expect(r.blocked).toBe(false);
  });

  it("maps needs_reauth to a reconnect hint", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ success: false, code: "needs_reauth", error: "token expired" }, 401)
    );
    const r = await dispatchMcpToolCallSdk({ name: "mcp__gh__list_prs" }, ctx());
    expect(r.resultXml).toContain("[MCP ERROR]");
    expect(r.resultXml).toContain("reconnect");
    expect(r.blocked).toBe(false);
  });

  it("reports cooldown with the retry window", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(
        { success: false, code: "cooldown", error: "backing off", retryAt: Date.now() + 15_000 },
        503
      )
    );
    const r = await dispatchMcpToolCallSdk({ name: "mcp__gh__list_prs" }, ctx());
    expect(r.resultXml).toContain("backing off");
    expect(r.resultXml).toMatch(/retry in \d+s/);
  });

  it("clips oversized tool output at MAX_RESULT_CHARS", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ success: true, text: "x".repeat(40_000), isError: false })
    );
    const r = await dispatchMcpToolCallSdk({ name: "mcp__db__dump" }, ctx());
    expect(r.resultXml).toContain("[truncated]");
    expect(r.resultXml.length).toBeLessThan(32_000);
  });

  it("surfaces fetch failures as an MCP ERROR result", async () => {
    apiFetchMock.mockRejectedValue(new Error("network down"));
    const r = await dispatchMcpToolCallSdk({ name: "mcp__db__query" }, ctx());
    expect(r.resultXml).toContain("[MCP ERROR]");
    expect(r.resultXml).toContain("network down");
    expect(r.blocked).toBe(false);
  });
});
