// dispatch.ts — executes mcp__<serverId>__<tool> calls from the agent loop.
//
// The model discovers these tools through the system prompt's MCP CONNECTOR
// TOOLS section (built from each remote server's cached tools/list) and calls
// them exactly like built-ins; this dispatcher resolves the server, refreshes
// OAuth tokens when needed, invokes tools/call over the Streamable HTTP
// transport, and formats the result as a standard tool_result.

import { findRemote, parseMcpToolName } from "./registry";
import { withConnection } from "./client";

const MAX_RESULT_CHARS = 30_000;

/** The slice of ToolContext the MCP path needs (keeps native-tools ↔ mcp acyclic). */
interface McpToolCtx {
  setStatus(status: string, detail: string): void;
  appendDisplay(text: string): void;
  syncDisplay(): void;
}

export async function dispatchMcpToolCall(
  call: { name: string } & Record<string, unknown>,
  ctx: McpToolCtx
): Promise<{ resultXml: string; blocked: boolean }> {
  const parsed = parseMcpToolName(call.name);
  if (!parsed) {
    return {
      resultXml: `<tool_result name="${call.name}">\nInvalid MCP tool name "${call.name}" (expected mcp__<server>__<tool>).\n</tool_result>\n`,
      blocked: false,
    };
  }
  const server = findRemote(parsed.serverId);
  if (!server) {
    return {
      resultXml: `<tool_result name="${call.name}">\n[MCP ERROR] Server "${parsed.serverId}" is not connected. Ask the user to reconnect it in MCP connectors (prompt bar → MCP).\n</tool_result>\n`,
      blocked: false,
    };
  }

  // Everything except the tool name is the argument bag. The parser spreads
  // the model's JSON onto the call object, so this is exactly the args the
  // model intended (flat scalars per the tool-call contract).
  const { name: _name, ...args } = call;

  ctx.setStatus("tool_executing", `MCP ${server.label}: ${parsed.toolName}…`);
  ctx.appendDisplay(`mcp [${server.label}] ${parsed.toolName}\n`);
  ctx.syncDisplay();

  try {
    const { text, isError } = await withConnection(server, (conn) => conn.callTool(parsed.toolName, args));
    const clipped = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]` : text;
    // Close the display line opened above so the row settles instead of
    // spinning until the chain is dropped.
    ctx.appendDisplay(
      `${isError ? "[FAIL]" : "[OK]"} MCP ${server.label}: ${parsed.toolName}${isError ? ` — ${clipped.slice(0, 160)}` : ""}\n`
    );
    ctx.syncDisplay();
    return {
      resultXml: `<tool_result name="${call.name}">${isError ? "\n[TOOL ERROR]\n" : ""}\n${clipped}\n</tool_result>\n`,
      blocked: false,
    };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    ctx.appendDisplay(`[FAIL] MCP ${server.label}: ${parsed.toolName} — ${msg}\n`);
    ctx.syncDisplay();
    return {
      resultXml: `<tool_result name="${call.name}">\n[MCP ERROR] ${msg}${/401|403/.test(msg) ? " — the OAuth session expired; ask the user to reconnect this server in MCP connectors." : ""}\n</tool_result>\n`,
      blocked: false,
    };
  }
}
