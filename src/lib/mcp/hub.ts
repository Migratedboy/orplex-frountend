// hub.ts — connection manager for REMOTE MCP servers over the official SDK
// (spec Phase 4). One live `Client` session per (user, server), with the
// wrapping rules every caller would otherwise reimplement:
//
//   status machine   disconnected → connecting → connected
//                    error (backoff gate) · needs_reauth (user action)
//   single flight    concurrent callers share one connect attempt
//   timeouts         connect / list / call each bounded (see HUB_*_MS)
//   caps             ≤ HUB_MAX_INFLIGHT calls per server, ≤ HUB_MAX_TOOLS
//                    per tools/list, FIFO waiters on the concurrency slot
//   backoff          consecutive failures → exponential cool-down gate
//   idle close       sessions close themselves after HUB_IDLE_TTL_MS
//
// Auth: tokens are server-side only (Prisma, AES-256-GCM — see oauth/store).
// The runtime provider attaches stored tokens and supports silent refresh;
// anything that would need a BROWSER redirect throws, which the hub turns
// into status `needs_reauth` + a `markNeedsReauth` flag for the Connectors
// UI. Users never get a URL from here — reconnecting goes through
// POST /api/mcp/connections/:id/connect (flow.ts), which owns the pending
// state rows.
//
// Every network request goes out through ssrfFetch (C7): transport POSTs,
// SSE, and the OAuth discovery/exchange calls the transport drives itself.
//
// This module is SERVER-SIDE ONLY (imports Prisma-backed oauth/store).
// Renderer lanes must use risk-hint.ts / dispatch.ts instead.

import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { getMcpCatalogEntry, type McpCatalogEntry } from "@/lib/mcp-catalog";
import {
  loadConnectionCredentials,
  loadConnectionTokens,
  markNeedsReauth,
  saveConnectionTokens,
} from "./oauth/store";
import { ssrfFetch } from "./ssrf-fetch";

const CLIENT_INFO = { name: "Orplex", version: "1.0.0" } as const;

// ── wrapping rules (exported so tests and docs read the same numbers) ───────

export const HUB_CONNECT_TIMEOUT_MS = 15_000;
export const HUB_LIST_TIMEOUT_MS = 15_000;
export const HUB_CALL_TIMEOUT_MS = 30_000;
export const HUB_MAX_INFLIGHT = 4;
export const HUB_MAX_TOOLS = 200;
export const HUB_TOOL_CACHE_MS = 60_000;
export const HUB_IDLE_TTL_MS = 5 * 60_000;
export const HUB_BACKOFF_BASE_MS = 1_000;
export const HUB_BACKOFF_MAX_MS = 60_000;

/** 1s, 2s, 4s … capped at HUB_BACKOFF_MAX_MS. */
export function hubBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  const exp = Math.min(failures - 1, 20); // 2^20 · base already ≫ cap
  return Math.min(HUB_BACKOFF_BASE_MS * 2 ** exp, HUB_BACKOFF_MAX_MS);
}

// ── public types ────────────────────────────────────────────────────────────

export type HubStatus = "disconnected" | "connecting" | "connected" | "needs_reauth" | "error";

export type McpHubErrorCode =
  | "no_remote"
  | "unsupported_auth"
  | "needs_reauth"
  | "cooldown"
  | "connect_failed"
  | "call_failed"
  | "call_timeout";

export class McpHubError extends Error {
  readonly code: McpHubErrorCode;
  /** For cooldown: when a retry is allowed again. */
  readonly retryAt?: number;
  constructor(code: McpHubErrorCode, message: string, retryAt?: number) {
    super(message);
    this.name = "McpHubError";
    this.code = code;
    this.retryAt = retryAt;
  }
}

export interface HubTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface HubStatusView {
  serverId: string;
  status: HubStatus;
  lastError?: string;
  lastConnectedAt?: number;
  failures: number;
  retryAt?: number;
}

interface HubSession {
  key: string;
  userId: string;
  serverId: string;
  status: HubStatus;
  client: Client | null;
  connecting: Promise<void> | null;
  lastError?: string;
  lastConnectedAt?: number;
  lastUsedAt?: number;
  failures: number;
  nextRetryAt: number;
  inflight: number;
  waiters: Array<() => void>;
  tools?: HubTool[];
  toolsAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, HubSession>();

function sessionKey(userId: string, serverId: string): string {
  return `${userId}::${serverId}`;
}

function sessionFor(userId: string, serverId: string): HubSession {
  const key = sessionKey(userId, serverId);
  let s = sessions.get(key);
  if (!s) {
    s = {
      key,
      userId,
      serverId,
      status: "disconnected",
      client: null,
      connecting: null,
      failures: 0,
      nextRetryAt: 0,
      inflight: 0,
      waiters: [],
      toolsAt: 0,
      idleTimer: null,
    };
    sessions.set(key, s);
  }
  return s;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── runtime OAuth provider (stored tokens only — no browser legs) ───────────

/**
 * Thrown by any provider method that would need an interactive redirect or
 * a pending-state row the runtime never has. The hub maps it to needs_reauth:
 * the fix is the connect route, not a retry.
 */
export class McpInteractiveAuthRequiredError extends Error {
  readonly code = "mcp_interactive_auth_required";
  constructor(message: string) {
    super(message);
    this.name = "McpInteractiveAuthRequiredError";
  }
}

export interface RuntimeProviderOptions {
  userId: string;
  serverId: string;
  endpointUrl: string;
  transport: "streamable-http" | "sse";
  clientName?: string;
  scopes?: string[];
  staticClientId?: string;
}

/**
 * Read-mostly OAuthClientProvider for RUNTIME connects:
 *   tokens / client info  → Prisma-backed oauth/store (issuer-checked)
 *   saveTokens            → store (silent refresh keeps sessions alive)
 *   discovery state       → in-memory (one connect attempt, one instance)
 *   redirect legs         → throw McpInteractiveAuthRequiredError
 *
 * Deliberately never DCRs at runtime: a client registered from here would
 * carry a placeholder redirect_uri and poison the real connect flow.
 */
export class RuntimeMcpOAuthProvider implements OAuthClientProvider {
  private discovery: OAuthDiscoveryState | undefined;
  // Placeholder — the interactive legs below throw before this is ever used.
  private readonly placeholderRedirect = "http://127.0.0.1:0/callback";

  constructor(private readonly opts: RuntimeProviderOptions) {}

  get redirectUrl(): string {
    return this.placeholderRedirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    const md: OAuthClientMetadata = {
      client_name: this.opts.clientName ? `Orplex · ${this.opts.clientName}` : "Orplex",
      redirect_uris: [this.placeholderRedirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    if (this.opts.scopes?.length) md.scope = this.opts.scopes.join(" ");
    return md;
  }

  state(): string {
    // Never surfaces in a real flow: redirectToAuthorization throws first
    // in every path that would consume it, but keep this defensive.
    throw new McpInteractiveAuthRequiredError(
      `"${this.opts.serverId}" requires interactive sign-in — connect it through POST /api/mcp/connections/${this.opts.serverId}/connect`
    );
  }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const stored = await loadConnectionCredentials(this.opts.userId, this.opts.serverId, ctx?.issuer);
    if (stored) return stored;
    if (this.opts.staticClientId) {
      const info: StoredOAuthClientInformation = { client_id: this.opts.staticClientId };
      if (ctx?.issuer) info.issuer = ctx.issuer;
      return info;
    }
    throw new McpInteractiveAuthRequiredError(
      `no stored OAuth client for "${this.opts.serverId}" — connect it first (runtime never registers dynamically)`
    );
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return loadConnectionTokens(this.opts.userId, this.opts.serverId);
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    await saveConnectionTokens({
      userId: this.opts.userId,
      serverId: this.opts.serverId,
      url: this.opts.endpointUrl,
      transport: this.opts.transport,
      issuer: ctx?.issuer ?? tokens.issuer,
      tokens,
    });
  }

  async redirectToAuthorization(): Promise<void> {
    throw new McpInteractiveAuthRequiredError(
      `"${this.opts.serverId}" session expired and must be re-authorized in the Connectors panel`
    );
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    // In-memory only — a runtime connect has no pending row to write to, and
    // the flow cannot outlive this instance anyway (redirect throws below).
    this.codeVerifierValue = codeVerifier;
  }

  async codeVerifier(): Promise<string> {
    if (!this.codeVerifierValue) {
      throw new McpInteractiveAuthRequiredError(`no PKCE verifier in memory for "${this.opts.serverId}"`);
    }
    return this.codeVerifierValue;
  }
  private codeVerifierValue: string | undefined;

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.discovery = state;
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.discovery;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "tokens" || scope === "all") {
      await markNeedsReauth(this.opts.userId, this.opts.serverId, "credentials invalidated by server");
    }
  }
}

// ── transport / connect ─────────────────────────────────────────────────────

function buildTransport(entry: McpCatalogEntry, s: HubSession) {
  const remote = entry.remote!;
  const url = new URL(remote.url);
  const provider =
    entry.auth === "oauth"
      ? new RuntimeMcpOAuthProvider({
          userId: s.userId,
          serverId: s.serverId,
          endpointUrl: remote.url,
          transport: remote.transport,
          clientName: entry.name,
          scopes: entry.oauth?.scopes,
          staticClientId: entry.oauth?.clientId,
        })
      : undefined;
  if (remote.transport === "sse") {
    return new SSEClientTransport(url, { fetch: ssrfFetch, ...(provider ? { authProvider: provider } : {}) });
  }
  return new StreamableHTTPClientTransport(url, { fetch: ssrfFetch, ...(provider ? { authProvider: provider } : {}) });
}

class McpHubTimeoutError extends Error {
  constructor(
    readonly what: string,
    readonly ms: number
  ) {
    super(`MCP ${what} timed out after ${ms}ms`);
    this.name = "McpHubTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpHubTimeoutError(what, ms)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeSession(s: HubSession): Promise<void> {
  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
  const client = s.client;
  s.client = null;
  s.tools = undefined;
  s.toolsAt = 0;
  if (client) await client.close().catch(() => {});
}

function armIdle(s: HubSession): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = null;
  if (s.status !== "connected" || s.inflight > 0) return;
  s.idleTimer = setTimeout(() => {
    s.idleTimer = null;
    if (s.status === "connected" && s.inflight === 0) {
      s.status = "disconnected";
      void closeSession(s);
    }
  }, HUB_IDLE_TTL_MS);
  s.idleTimer.unref?.();
}

/** Terminal mapping for connect failures: sets status and throws typed. */
async function failConnect(s: HubSession, e: unknown): Promise<never> {
  const msg = errorMessage(e);
  if (e instanceof McpInteractiveAuthRequiredError || UnauthorizedError.isInstance(e)) {
    s.status = "needs_reauth";
    s.lastError = msg;
    await markNeedsReauth(s.userId, s.serverId, msg).catch(() => {});
    throw new McpHubError("needs_reauth", msg);
  }
  if (e instanceof McpHubError && (e.code === "no_remote" || e.code === "unsupported_auth")) {
    s.status = "disconnected";
    s.lastError = msg;
    throw e;
  }
  s.failures += 1;
  s.status = "error";
  s.lastError = msg;
  s.nextRetryAt = Date.now() + hubBackoffMs(s.failures);
  throw new McpHubError("connect_failed", `connection failed: ${msg}`, s.nextRetryAt);
}

function precheck(entry: McpCatalogEntry | null, serverId: string): asserts entry is McpCatalogEntry & { remote: NonNullable<McpCatalogEntry["remote"]> } {
  if (!entry || !entry.remote) {
    throw new McpHubError("no_remote", `"${serverId}" has no remote endpoint`);
  }
  if (entry.auth === "token" && !entry.oauth) {
    throw new McpHubError(
      "unsupported_auth",
      `"${entry.name}" remote token auth is not stored yet — connect it over its stdio/token path`
    );
  }
}

async function ensureConnected(s: HubSession, entry: McpCatalogEntry): Promise<void> {
  if (s.status === "connected" && s.client) {
    s.lastUsedAt = Date.now();
    return;
  }
  if (s.status === "needs_reauth") {
    throw new McpHubError("needs_reauth", s.lastError ?? `"${s.serverId}" needs reconnecting in MCP connectors`);
  }
  if (s.status === "error" && s.nextRetryAt > Date.now()) {
    const waitMs = s.nextRetryAt - Date.now();
    throw new McpHubError("cooldown", `"${s.serverId}" is in backoff — retry in ${Math.ceil(waitMs / 1000)}s`, s.nextRetryAt);
  }
  if (s.connecting) return s.connecting;

  s.connecting = (async () => {
    s.status = "connecting";
    const client = new Client(CLIENT_INFO);
    try {
      await withTimeout(client.connect(buildTransport(entry, s)), HUB_CONNECT_TIMEOUT_MS, "connect");
      s.client = client;
      s.status = "connected";
      s.failures = 0;
      s.nextRetryAt = 0;
      s.lastError = undefined;
      s.lastConnectedAt = Date.now();
      s.lastUsedAt = Date.now();
      armIdle(s);
    } catch (e) {
      await client.close().catch(() => {});
      await failConnect(s, e);
    } finally {
      s.connecting = null;
    }
  })();
  return s.connecting;
}

// ── concurrency slot (FIFO, bounded wait) ───────────────────────────────────

async function acquire(s: HubSession, timeoutMs: number): Promise<void> {
  if (s.inflight < HUB_MAX_INFLIGHT) {
    s.inflight += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter = () => {
      if (timer) clearTimeout(timer);
      s.inflight += 1;
      resolve();
    };
    const timeout = () => {
      const i = s.waiters.indexOf(waiter);
      if (i >= 0) s.waiters.splice(i, 1);
      reject(new McpHubError("call_timeout", `"${s.serverId}" busy — timed out waiting for a free slot`));
    };
    timer = setTimeout(timeout, timeoutMs);
    timer.unref?.();
    s.waiters.push(waiter);
  });
}

function release(s: HubSession): void {
  s.inflight = Math.max(0, s.inflight - 1);
  const next = s.waiters.shift();
  if (next) next();
  armIdle(s);
}

// ── failure mapping for calls on a live session ─────────────────────────────

const TRANSPORTISH = /fetch failed|ECONN|socket|network|terminated|stream closed|aborted|timed? ?out|HTTP [45]\d\d/i;

async function mapCallFailure(s: HubSession, e: unknown): Promise<never> {
  const msg = errorMessage(e);
  if (e instanceof McpInteractiveAuthRequiredError || UnauthorizedError.isInstance(e)) {
    await closeSession(s);
    s.status = "needs_reauth";
    s.lastError = msg;
    await markNeedsReauth(s.userId, s.serverId, msg).catch(() => {});
    throw new McpHubError("needs_reauth", msg);
  }
  if (e instanceof McpHubTimeoutError) {
    await closeSession(s);
    s.failures += 1;
    s.status = "error";
    s.lastError = msg;
    s.nextRetryAt = Date.now() + hubBackoffMs(s.failures);
    throw new McpHubError("call_timeout", msg, s.nextRetryAt);
  }
  if (e instanceof TypeError || TRANSPORTISH.test(msg)) {
    // The pipe broke — drop the session so the next attempt reconnects.
    await closeSession(s);
    s.failures += 1;
    s.status = "error";
    s.lastError = msg;
    s.nextRetryAt = Date.now() + hubBackoffMs(s.failures);
    throw new McpHubError("call_failed", msg, s.nextRetryAt);
  }
  // Protocol/validation error (bad params, unknown tool, …): the session is
  // healthy — rethrow untouched, no failure counted.
  throw e;
}

// ── public API ──────────────────────────────────────────────────────────────

export function hubStatus(userId: string, serverId: string): HubStatusView {
  const s = sessions.get(sessionKey(userId, serverId));
  if (!s) return { serverId, status: "disconnected", failures: 0 };
  return {
    serverId,
    status: s.status,
    lastError: s.lastError,
    lastConnectedAt: s.lastConnectedAt,
    failures: s.failures,
    ...(s.status === "error" && s.nextRetryAt > Date.now() ? { retryAt: s.nextRetryAt } : {}),
  };
}

export function hubStatusAll(userId: string): HubStatusView[] {
  const out: HubStatusView[] = [];
  for (const s of sessions.values()) {
    if (s.userId === userId) out.push(hubStatus(s.userId, s.serverId));
  }
  return out.sort((a, b) => a.serverId.localeCompare(b.serverId));
}

export async function hubListTools(
  userId: string,
  serverId: string,
  opts?: { refresh?: boolean; timeoutMs?: number }
): Promise<HubTool[]> {
  const entry = getMcpCatalogEntry(serverId);
  precheck(entry, serverId);
  const s = sessionFor(userId, serverId);
  await ensureConnected(s, entry);

  if (!opts?.refresh && s.tools && Date.now() - s.toolsAt < HUB_TOOL_CACHE_MS) return s.tools;

  await acquire(s, opts?.timeoutMs ?? HUB_LIST_TIMEOUT_MS);
  try {
    const client = s.client!;
    let raw: unknown;
    try {
      raw = await withTimeout(client.listTools({}), opts?.timeoutMs ?? HUB_LIST_TIMEOUT_MS, "tools/list");
    } catch (e) {
      await mapCallFailure(s, e);
    }
    const tools = ((raw as { tools?: unknown[] })?.tools ?? []) as Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: HubTool["annotations"];
    }>;
    s.tools = tools.slice(0, HUB_MAX_TOOLS).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
    s.toolsAt = Date.now();
    s.lastUsedAt = Date.now();
    return s.tools;
  } finally {
    release(s);
  }
}

export async function hubCallTool(
  userId: string,
  serverId: string,
  toolName: string,
  args: Record<string, unknown> = {},
  opts?: { timeoutMs?: number }
): Promise<{ text: string; isError: boolean }> {
  const entry = getMcpCatalogEntry(serverId);
  precheck(entry, serverId);
  const s = sessionFor(userId, serverId);
  await ensureConnected(s, entry);

  const timeoutMs = opts?.timeoutMs ?? HUB_CALL_TIMEOUT_MS;
  await acquire(s, timeoutMs);
  try {
    const client = s.client!;
    let result: unknown;
    try {
      result = await withTimeout(client.callTool({ name: toolName, arguments: args }), timeoutMs, "tools/call");
    } catch (e) {
      await mapCallFailure(s, e);
    }
    const r = (result ?? {}) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const content = r.content ?? [];
    const text = content
      .map((c) => (c.type === "text" ? (c.text ?? "") : c.type === "resource" ? "[resource content omitted]" : `[${c.type}]`))
      .join("\n")
      .trim();
    s.lastUsedAt = Date.now();
    return { text: text || "(empty result)", isError: Boolean(r.isError) };
  } finally {
    release(s);
  }
}

/** Close one session (user hit Disconnect, or a route is tearing it down). */
export async function hubCloseServer(userId: string, serverId: string): Promise<void> {
  const s = sessions.get(sessionKey(userId, serverId));
  if (!s) return;
  s.status = "disconnected";
  s.failures = 0;
  s.nextRetryAt = 0;
  s.lastError = undefined;
  s.waiters = [];
  await closeSession(s);
}

/** Close everything (instrumentation teardown + test cleanup). */
export async function hubShutdown(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  for (const s of all) {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    if (s.client) await s.client.close().catch(() => {});
  }
}
