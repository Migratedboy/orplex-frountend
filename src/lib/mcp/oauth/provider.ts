// provider.ts — the DB-backed OAuthClientProvider for remote MCP servers
// (spec Phase 2), bridging @modelcontextprotocol/client's stateful OAuth
// interface to the Prisma tables:
//
//   clientMetadata/state      → static per-connect config (DCR registration)
//   clientInformation         → McpConnection.clientId (issuer-checked), the
//                               catalog's static id, or undefined → SDK DCR
//   saveTokens/tokens         → store.ts (ciphertext + mutex + version)
//   saveCodeVerifier/…        → mcp_oauth_pendings (one-time state row)
//   redirectToAuthorization   → captured, never auto-opened: the route hands
//                               the URL to the renderer, which calls
//                               electron shell.openExternal (spec: browser,
//                               never an in-app webview)
//
// A typed error (McpStaticClientRequiredError) covers providers that cannot
// dynamically register and have no configured client id — surfaced to the
// UI as "this provider needs a client ID", not a stack trace.

import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { markNeedsReauth, loadConnectionCredentials, loadConnectionTokens, saveConnectionCredentials, saveConnectionTokens } from "./store";
import {
  getPendingByState,
  setPendingAuthorization,
  setPendingCodeVerifier,
  setPendingDiscovery,
} from "./pending";

/** Thrown when DCR is disabled for a provider and no client id is known. */
export class McpStaticClientRequiredError extends Error {
  readonly code = "mcp_static_client_required";
  constructor(
    readonly serverId: string,
    readonly docsUrl?: string
  ) {
    super(
      `"${serverId}" cannot register an OAuth client dynamically and has no configured client id — add oauth.clientId for it in the catalog`
    );
    this.name = "McpStaticClientRequiredError";
  }
}

export interface DbMcpOAuthProviderOptions {
  userId: string;
  serverId: string;
  /** State from createPending() — one flow, one row. */
  pendingState: string;
  /** MCP endpoint (McpConnection.url). */
  endpointUrl: string;
  transport: "streamable-http" | "sse";
  /** Exact redirect_uri: loopback (desktop) or /api/mcp/oauth/callback (hosted). */
  redirectUrl: string;
  /** Catalog display name — becomes client_name in DCR metadata. */
  clientName?: string;
  /** Catalog oauth.scopes → requested scope string. */
  scopes?: string[];
  /** Catalog oauth.clientId for providers without DCR. */
  staticClientId?: string;
  /** false → known no-DCR provider: throw typed error instead of attempting DCR. */
  allowDynamicRegistration?: boolean;
}

export class DbMcpOAuthProvider implements OAuthClientProvider {
  private lastAuthUrl: string | null = null;

  constructor(private readonly opts: DbMcpOAuthProviderOptions) {}

  /** URL the flow was redirected to — read by the route after auth() → REDIRECT. */
  get authorizationUrl(): string | null {
    return this.lastAuthUrl;
  }

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const md: OAuthClientMetadata = {
      client_name: this.opts.clientName ? `Orplex · ${this.opts.clientName}` : "Orplex",
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    if (this.opts.scopes?.length) md.scope = this.opts.scopes.join(" ");
    return md;
  }

  state(): string {
    return this.opts.pendingState;
  }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const stored = await loadConnectionCredentials(this.opts.userId, this.opts.serverId, ctx?.issuer);
    if (stored) return stored;
    if (this.opts.staticClientId) {
      const info: StoredOAuthClientInformation = { client_id: this.opts.staticClientId };
      if (ctx?.issuer) info.issuer = ctx.issuer;
      return info;
    }
    if (this.opts.allowDynamicRegistration === false) {
      throw new McpStaticClientRequiredError(this.opts.serverId);
    }
    return undefined; // → SDK performs RFC 7591 dynamic registration
  }

  async saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    if (!info.client_id) return;
    await saveConnectionCredentials({
      userId: this.opts.userId,
      serverId: this.opts.serverId,
      url: this.opts.endpointUrl,
      transport: this.opts.transport,
      issuer: ctx?.issuer ?? info.issuer,
      clientId: info.client_id,
      clientSecret: info.client_secret,
    });
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

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.lastAuthUrl = authorizationUrl.toString();
    await setPendingAuthorization(this.opts.pendingState, { authorizationUrl: this.lastAuthUrl });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await setPendingCodeVerifier(this.opts.pendingState, codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const row = await getPendingByState(this.opts.pendingState);
    if (!row?.codeVerifier) {
      const err = new Error(`MCP OAuth: no pending PKCE verifier for state (serverId=${this.opts.serverId})`);
      err.name = "McpPendingVerifierMissing";
      throw err;
    }
    return row.codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const issuer = (state as { issuer?: string }).issuer;
    await setPendingDiscovery(this.opts.pendingState, state, issuer);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const row = await getPendingByState(this.opts.pendingState);
    return (row?.discoveryState as OAuthDiscoveryState | null | undefined) ?? undefined;
  }

  /**
   * Server said these credentials are dead (or transport got a hard 401).
   * Wipe tokens + flag needs_reauth so the Connectors UI shows "reconnect".
   */
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "tokens" || scope === "all") {
      await markNeedsReauth(this.opts.userId, this.opts.serverId, "credentials invalidated by server");
    }
  }
}
