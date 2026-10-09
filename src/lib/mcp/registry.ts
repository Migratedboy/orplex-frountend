// registry.ts — local store for REMOTE MCP servers the user connected
// themselves (the backend catalog only knows stdio/PAT servers).
//
// Remote MCP servers authenticate with OAuth 2.1 (interactive browser flow)
// or a plain bearer token — never a catalog PAT field, which is why the old
// setup was broken for them. Tokens live in localStorage (desktop app) and
// are refreshed through the Electron bridge when they expire; the connecting
// flow lives in ConnectorsPanel.

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
  /** Server-declared ToolAnnotations from tools/list (risk hints — C6). */
  annotations?: McpToolAnnotations;
}

export interface McpTokens {
  accessToken: string;
  refreshToken?: string;
  /** Absolute ms timestamp when accessToken expires (if the server said). */
  expiresAt?: number;
  tokenType: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  obtainedAt: number;
}

export interface McpRemoteServer {
  id: string;
  label: string;
  /** MCP endpoint (streamable HTTP), e.g. https://mcp.linear.app/mcp */
  url: string;
  auth: "oauth" | "bearer" | "none";
  bearerToken?: string;
  tokens?: McpTokens;
  /** Cached tools/list result — refreshed on connect + before each run.
   *  In the legacy lane this is the authoritative tools list (localStorage).
   *  In the SDK lane the Prisma snapshot is authoritative; this field is
   *  a best-effort mirror kept in sync so both lanes render the same roster. */
  tools?: McpToolInfo[];
  lastConnectedAt?: number;
  lastError?: string;
}

const KEY = "orplex.mcp.remotes.v1";

export function loadRemotes(): McpRemoteServer[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as McpRemoteServer[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveRemotes(list: McpRemoteServer[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
}

export function findRemote(id: string): McpRemoteServer | null {
  return loadRemotes().find((r) => r.id === id) ?? null;
}

export function upsertRemote(server: McpRemoteServer): void {
  const list = loadRemotes();
  const i = list.findIndex((r) => r.id === server.id);
  if (i >= 0) list[i] = server;
  else list.push(server);
  saveRemotes(list);
}

export function removeRemote(id: string): void {
  saveRemotes(loadRemotes().filter((r) => r.id !== id));
}

export function updateTokens(id: string, tokens: McpTokens): McpRemoteServer | null {
  const list = loadRemotes();
  const srv = list.find((r) => r.id === id);
  if (!srv) return null;
  srv.tokens = tokens;
  saveRemotes(list);
  return srv;
}

/** Mark a server as having NO tools in localStorage (clears a stale cache).
 *  Used by the unified discovery path when a server is connected but its
 *  tools/list returned empty or failed — so the prompt section doesn't show
 *  phantom tools from a prior successful probe. */
export function markRemoteToolsEmpty(id: string): void {
  const list = loadRemotes();
  const srv = list.find((r) => r.id === id);
  if (srv) {
    srv.tools = [];
    saveRemotes(list);
  }
}

/** Stable short id from the endpoint URL, e.g. "mcp-linear-app". */
export function remoteIdFor(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "").replace(/[^a-z0-9.-]/gi, "-").toLowerCase();
    // Strip path separators/punctuation entirely (no "_" — the id must stay
    // parseable inside mcp__<id>__<tool> names).
    const path = u.pathname.replace(/[^a-z0-9]/gi, "");
    return path ? `${host}${path}`.slice(0, 48) : host;
  } catch {
    return `remote-${Date.now().toString(36)}`;
  }
}

/** Local tool name convention: mcp__<serverId>__<toolName>. */
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

/** Inverse of mcpToolName — null when the name is not an MCP tool.
 * serverIds produced by remoteIdFor never contain "_", so the first
 * non-`__`-prefixed segment is always the whole server id. */
export function parseMcpToolName(name: string): { serverId: string; toolName: string } | null {
  const m = /^mcp__([^_]+)__([\s\S]+)$/.exec(name);
  if (!m) return null;
  return { serverId: m[1], toolName: m[2] };
}

export function isTokenUsable(server: McpRemoteServer): boolean {
  if (server.auth === "none") return true;
  if (server.auth === "bearer") return !!server.bearerToken;
  const t = server.tokens;
  if (!t?.accessToken) return false;
  if (typeof t.expiresAt !== "number") return true; // no expiry given — try it
  return Date.now() < t.expiresAt - 30_000; // 30s clock-skew margin
}

export async function ensureFreshTokens(server: McpRemoteServer): Promise<McpRemoteServer> {
  if (isTokenUsable(server)) return server;
  const bridge = (typeof window !== "undefined" ? window.orplexDesktop?.mcp : null);
  if (!bridge || server.auth !== "oauth" || !server.tokens?.refreshToken) return server;
  const res = await bridge.oauthRefresh({
    serverUrl: server.url,
    refreshToken: server.tokens.refreshToken,
    clientId: server.tokens.clientId,
    clientSecret: server.tokens.clientSecret,
    tokenEndpoint: server.tokens.tokenEndpoint,
  });
  if (res.ok && res.accessToken) {
    const tokens: McpTokens = {
      ...server.tokens,
      accessToken: res.accessToken,
      refreshToken: res.refreshToken ?? server.tokens.refreshToken,
      obtainedAt: Date.now(),
      expiresAt: res.expiresIn ? Date.now() + res.expiresIn * 1000 : undefined,
    };
    return updateTokens(server.id, tokens) ?? { ...server, tokens };
  }
  throw new Error(res.error ?? "Token refresh failed — reconnect the server in MCP connectors.");
}
