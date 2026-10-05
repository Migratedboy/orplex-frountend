// dispatch.ts — executes mcp__<serverId>__<tool> calls from the agent loop.
//
// Two lanes behind the Phase 8 gate (ORPLEX_MCP, default "sdk"):
//   • legacy — the pre-Phase-8 renderer path: resolve the server in the
//     localStorage registry and call it in-process (findRemote/withConnection).
//   • sdk    — POST /api/agent/mcp/call → the Phase 4 hub, where the OAuth
//     tokens live (McpConnection, encrypted). Same tool_result contract.
// The model discovers these tools through the system prompt's MCP CONNECTOR
// TOOLS section in either case.

import { findRemote, parseMcpToolName } from "./registry";
import { withConnection } from "./client";
import { apiFetch } from "@/lib/api-base";
import { getMcpCatalogEntry } from "@/lib/mcp-catalog";

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

/**
 * SDK-lane dispatcher (Phase 8, default): same tool_result contract as the
 * legacy lane, but the call goes through POST /api/agent/mcp/call → hub,
 * where OAuth tokens + the encrypted connection live. Approval (C6) has
 * already run in the caller.
 */
export async function dispatchMcpToolCallSdk(
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
  const label = getMcpCatalogEntry(parsed.serverId)?.name ?? parsed.serverId;
  const { name: _name, ...args } = call;

  ctx.setStatus("tool_executing", `MCP ${label}: ${parsed.toolName}…`);
  ctx.appendDisplay(`mcp [${label}] ${parsed.toolName}\n`);
  ctx.syncDisplay();

  try {
    const r = await apiFetch("/api/agent/mcp/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: parsed.serverId, tool: parsed.toolName, args }),
    });
    const j = (await r.json().catch(() => ({}))) as {
      success?: boolean;
      text?: string;
      isError?: boolean;
      code?: string;
      error?: string;
    };
    if (!j.success) {
      const msg = j.error ?? `HTTP ${r.status}`;
      const retryAt = (j as { retryAt?: number }).retryAt;
      const retryIn = typeof retryAt === "number" ? (retryAt - Date.now()) / 1000 : 0;
      const hint =
        j.code === "needs_reauth" || /401|403/.test(msg)
          ? " — the OAuth session expired; ask the user to reconnect this server in MCP connectors."
          : j.code === "cooldown"
            ? ` — server is backing off; retry in ${Math.max(1, Math.ceil(retryIn))}s.`
            : "";
      ctx.appendDisplay(`[FAIL] MCP ${label}: ${parsed.toolName} — ${msg}\n`);
      ctx.syncDisplay();
      return {
        resultXml: `<tool_result name="${call.name}">\n[MCP ERROR] ${msg}${hint}\n</tool_result>\n`,
        blocked: false,
      };
    }
    const raw = j.text ?? "";
    const clipped = raw.length > MAX_RESULT_CHARS ? `${raw.slice(0, MAX_RESULT_CHARS)}\n…[truncated]` : raw;
    const isError = !!j.isError;
    ctx.appendDisplay(
      `${isError ? "[FAIL]" : "[OK]"} MCP ${label}: ${parsed.toolName}${isError ? ` — ${clipped.slice(0, 160)}` : ""}\n`
    );
    ctx.syncDisplay();
    return {
      resultXml: `<tool_result name="${call.name}">${isError ? "\n[TOOL ERROR]\n" : ""}\n${clipped}\n</tool_result>\n`,
      blocked: false,
    };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    ctx.appendDisplay(`[FAIL] MCP ${label}: ${parsed.toolName} — ${msg}\n`);
    ctx.syncDisplay();
    return {
      resultXml: `<tool_result name="${call.name}">\n[MCP ERROR] ${msg}\n</tool_result>\n`,
      blocked: false,
    };
  }
}
