// client.ts — minimal MCP client over the Streamable HTTP transport
// (2025-03-26+ spec) for REMOTE servers, running in the renderer with HTTP
// routed through the Electron main process (no CORS issues; falls back to
// renderer fetch outside Electron).
//
// Protocol notes:
//  • Every JSON-RPC message is a POST to the endpoint. The response is either
//    a single JSON object or an SSE stream (text/event-stream) containing the
//    response as one or more `data:` events — both are handled.
//  • initialize() is required first; its Mcp-Session-Id response header must
//    be echoed on every later call. notifications/initialized follows.
//  • Auth: OAuth bearer token (auto-refreshed via the Electron bridge on 401)
//    or a plain bearer token, or none.

import {
  ensureFreshTokens,
  mcpToolName,
  updateTokens,
  type McpRemoteServer,
  type McpToolInfo,
} from "./registry";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "orplex", version: "1.0.0" };

export interface McpHttpResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

async function httpPost(url: string, headers: Record<string, string>, body: string): Promise<McpHttpResult> {
  const bridge = typeof window !== "undefined" ? window.orplexDesktop?.mcp : undefined;
  if (bridge) {
    const r = await bridge.request({ url, method: "POST", headers, body });
    if (!r.ok) throw new Error(r.error ?? "MCP request failed in main process");
    return { status: r.status ?? 0, headers: r.headers ?? {}, text: r.text ?? "" };
  }
  // Plain-browser fallback (best effort — remote servers may lack CORS).
  const res = await fetch(url, { method: "POST", headers, body });
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });
  return { status: res.status, headers: responseHeaders, text: await res.text() };
}

/** Extract the JSON-RPC payload from a JSON or SSE response body. */
export function parseRpcPayload(text: string, contentType: string, id: number): Record<string, unknown> | null {
  if (contentType.includes("text/event-stream")) {
    // Take the LAST data: event carrying a JSON-RPC message with our id
    // (notifications/interleaved events are ignored).
    let found: Record<string, unknown> | null = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try {
        const j = JSON.parse(raw) as { id?: number; method?: string };
        if (j.id === id) found = j;
      } catch {}
    }
    return found;
  }
  try {
    const j = JSON.parse(text) as { id?: number };
    return j.id === id ? j : null;
  } catch {
    return null;
  }
}

export interface McpCallOptions {
  /** AbortSignal from the agent run — honored per request. */
  signal?: AbortSignal;
}

export class McpConnection {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(private server: McpRemoteServer) {}

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (this.server.auth === "oauth" && this.server.tokens?.accessToken) {
      h.Authorization = `${this.server.tokens.tokenType || "Bearer"} ${this.server.tokens.accessToken}`;
    } else if (this.server.auth === "bearer" && this.server.bearerToken) {
      h.Authorization = `Bearer ${this.server.bearerToken}`;
    }
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  private async rpc(method: string, params?: unknown, signal?: AbortSignal): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
    const id = this.nextId++;
    const res = await httpPost(this.server.url, this.authHeaders(), JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }));
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const payload = parseRpcPayload(res.text, res.headers["content-type"] ?? "", id);
    if (!payload) {
      if (res.status >= 400) throw new Error(`MCP ${method} failed: HTTP ${res.status}`);
      throw new Error(`MCP ${method}: no response payload (HTTP ${res.status})`);
    }
    const sid = res.headers["mcp-session-id"];
    if (sid) this.sessionId = sid;
    const err = payload.error as { code: number; message: string } | undefined;
    if (err) return { error: err };
    return { result: (payload.result ?? {}) as Record<string, unknown> };
  }

  /** initialize + notifications/initialized. Returns server info when present. */
  async initialize(): Promise<{ serverInfo?: { name?: string; version?: string } }> {
    const { result } = await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    // Spec: the client MUST send initialized before other requests.
    await httpPost(this.server.url, this.authHeaders(), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })).catch(() => null);
    return { serverInfo: (result?.serverInfo ?? undefined) as { name?: string; version?: string } | undefined };
  }

  async listTools(): Promise<McpToolInfo[]> {
    const { result, error } = await this.rpc("tools/list", {});
    if (error) throw new Error(`tools/list failed: ${error.message}`);
    const tools = (result?.tools ?? []) as McpToolInfo[];
    return tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object", properties: {} } }));
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const { result, error } = await this.rpc("tools/call", { name: toolName, arguments: args });
    if (error) throw new Error(error.message);
    const content = (result?.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content
      .map((c) => (c.type === "text" ? (c.text ?? "") : c.type === "resource" ? "[resource content omitted]" : `[${c.type}]`))
      .join("\n")
      .trim();
    return { text: text || "(empty result)", isError: Boolean(result?.isError) };
  }

  async ping(): Promise<boolean> {
    try {
      const { error } = await this.rpc("ping");
      return !error;
    } catch {
      return false;
    }
  }
}

/** Connection with transparent OAuth refresh on 401. */
export async function withConnection<T>(server: McpRemoteServer, fn: (conn: McpConnection) => Promise<T>): Promise<T> {
  const fresh = await ensureFreshTokens(server);
  const conn = new McpConnection(fresh);
  try {
    await conn.initialize();
    return await fn(conn);
  } catch (err) {
    // 401/403 with a refresh token → one refresh + retry.
    const msg = (err as Error)?.message ?? "";
    if (fresh.auth === "oauth" && fresh.tokens?.refreshToken && /\b(401|403)\b/.test(msg)) {
      const refreshed = await ensureFreshTokens({ ...fresh, tokens: { ...fresh.tokens!, expiresAt: Date.now() - 1000 } });
      const conn2 = new McpConnection(refreshed);
      await conn2.initialize();
      return await fn(conn2);
    }
    throw err;
  }
}

export function toolNamesFor(server: McpRemoteServer): string[] {
  return (server.tools ?? []).map((t) => mcpToolName(server.id, t.name));
}

export { updateTokens };
