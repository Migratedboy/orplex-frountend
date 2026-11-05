// flow.ts — SDK-driven OAuth connect/complete for REMOTE MCP connectors
// (spec Phase 3). Thin orchestration over the official client:
//
//   startAuthorization   POST /api/mcp/connections/:id/connect
//     create pending (one-time state) → Client + transport(authProvider) →
//     connect() → on 401 the transport runs auth() internally (discovery,
//     DCR, PKCE) and fires provider.redirectToAuthorization → UnauthorizedError
//     bubbles to us with the auth URL captured → {status:"awaiting_browser"}.
//     If stored tokens already work, connect() resolves → {status:"connected"}.
//
//   completeAuthorization  POST /api/mcp/oauth/complete (desktop, renderer-held
//     session) or GET /api/mcp/oauth/callback (hosted, browser cookies)
//     claim the pending state (single-use + TTL + session binding) →
//     transport.finishAuth(whole query) → SDK exchanges the code + saveTokens
//     (AES-256-GCM, mutex + version) → verify with a fresh connect → connected.
//
// Redirect targets are NOT free-form: only our hosted callback or an RFC 8252
// 127.0.0.1 /localhost loopback on /callback are accepted (prevents a stolen
// session from pointing the AS at an attacker URL).

import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { getMcpCatalogEntry, type McpCatalogEntry } from "@/lib/mcp-catalog";
import { loadCustomRemote } from "../custom-remote";
import { PENDING_TTL_MS, claimPending, createPending, failPending } from "./pending";
import { DbMcpOAuthProvider, McpStaticClientRequiredError } from "./provider";
import { ssrfFetch } from "../ssrf-fetch";

const CLIENT_INFO = { name: "Orplex", version: "1.0.0" } as const;

export type StartResult =
  | { status: "connected" }
  | { status: "awaiting_browser"; authUrl: string; state: string; expiresAt: number }
  | { status: "error"; code: string; error: string };

export type CompleteErrorCode =
  | "no_remote"
  | "state_unknown"
  | "state_expired"
  | "state_used"
  | "state_failed"
  | "wrong_owner"
  | "denied"
  | "issuer_mismatch"
  | "exchange_failed"
  | "verify_failed";

/** Phase 9: `connected` carries the serverId so callers can kick off hub
 * discovery (hubListTools -> syncToolSnapshot) right after sign-in — without
 * it the Phase 5 roster stays empty and tools never reach any prompt. */
export type CompleteResult = { status: "connected"; serverId: string } | { status: "error"; code: CompleteErrorCode; error: string };

// ── redirect_uri policy ─────────────────────────────────────────────────────

export function hostedCallbackUrl(requestOrigin: string): string {
  return `${requestOrigin.replace(/\/+$/, "")}/api/mcp/oauth/callback`;
}

/** RFC 8252 loopback: http only, 127.0.0.1/localhost only, exact /callback path. */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return (
      u.protocol === "http:" &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
      u.pathname === "/callback" &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

/** null → reject the request before any pending row or network call exists. */
export function resolveRedirectUri(requested: string | undefined, requestOrigin: string): string | null {
  const hosted = hostedCallbackUrl(requestOrigin);
  if (requested === undefined || requested === null || requested === "") return hosted;
  if (requested === hosted) return hosted;
  if (isLoopbackRedirect(requested)) return requested;
  return null;
}

// ── construction helpers ────────────────────────────────────────────────────

function remoteOf(entry: McpCatalogEntry): { url: string; transport: "streamable-http" | "sse" } | null {
  return entry.remote ?? null;
}

/**
 * Entry resolution for BOTH catalog connectors and user-added remote
 * servers (custom-remote.ts): catalog entries answer synchronously, remote
 * ids resolve from the stored McpConnection row. A custom URL can therefore
 * run the exact same connect/complete/hub machinery as a shipped connector.
 */
async function resolveEntry(userId: string, serverId: string): Promise<McpCatalogEntry | null> {
  const catalog = getMcpCatalogEntry(serverId);
  if (catalog) return catalog.remote ? catalog : null;
  return loadCustomRemote(userId, serverId);
}

function makeProvider(
  entry: McpCatalogEntry,
  pendingState: string,
  redirectUri: string,
  userId: string
): DbMcpOAuthProvider {
  // Client-ID Metadata Document URL (CIMD) — only when the catalog opts in
  // AND the redirect target is https (CIMD requires an https metadata doc).
  let clientMetadataUrl: string | undefined;
  if (entry.oauth?.cimd) {
    try {
      const origin = new URL(redirectUri).origin;
      if (origin.startsWith("https://")) {
        clientMetadataUrl = `${origin}/api/mcp/oauth/client-metadata`;
      }
    } catch {
      // ignore — fall back to DCR
    }
  }
  return new DbMcpOAuthProvider({
    userId,
    serverId: entry.id,
    pendingState,
    endpointUrl: entry.remote!.url,
    transport: entry.remote!.transport,
    redirectUrl: redirectUri,
    clientName: entry.name,
    scopes: entry.oauth?.scopes,
    staticClientId: entry.oauth?.clientId,
    staticClientSecret: entry.oauth?.clientSecret,
    authority: entry.oauth?.authority,
    clientMetadataUrl,
  });
}

function makeTransport(entry: McpCatalogEntry, provider: DbMcpOAuthProvider) {
  const url = new URL(remoteOf(entry)!.url);
  // `fetch` covers the transport POSTs AND the OAuth discovery/exchange
  // requests the SDK drives itself (C7 — ssrf-fetch.ts).
  //
  // skipIssuerMetadataValidation ONLY when the catalog pins a trusted AS:
  // some pinned servers (Entra) publish the `{tenantid}` placeholder issuer,
  // which cannot be validated against the fetch URL. The pin itself comes
  // from the audited catalog, not user input.
  const opts = {
    authProvider: provider,
    fetch: ssrfFetch,
    ...(entry.oauth?.authority ? { skipIssuerMetadataValidation: true } : {}),
  } as const;
  return entry.remote!.transport === "sse" ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function mapStartFailure(e: unknown, entry: McpCatalogEntry): StartResult {
  if (e instanceof McpStaticClientRequiredError) {
    return { status: "error", code: e.code, error: e.message };
  }
  if (e instanceof Error && e.name === "RegistrationRejectedError") {
    const typed = new McpStaticClientRequiredError(entry.id, entry.docsUrl);
    return { status: "error", code: typed.code, error: `${typed.message} (registration rejected by the authorization server)` };
  }
  // The SDK throws a plain Error("Incompatible auth server: does not support
  // dynamic client registration") for servers without open DCR — the same
  // "this provider needs a client id" condition as a typed rejection. Map
  // it to the typed form the Connectors panel turns into a client-id form so
  // the user gets a guided "paste your client id" flow instead of a raw
  // oauth_failed string.
  if (e instanceof Error && /does not support dynamic client registration/i.test(e.message)) {
    const typed = new McpStaticClientRequiredError(entry.id, entry.docsUrl);
    return { status: "error", code: typed.code, error: typed.message };
  }
  if (e instanceof Error && (e.name === "TypeError" || e.name === "AbortError" || /fetch failed|ENOTFOUND|ECONNREFUSED|timed? ?out/i.test(e.message))) {
    return { status: "error", code: "network", error: `Could not reach ${entry.name}: ${e.message}` };
  }
  return { status: "error", code: "oauth_failed", error: errorMessage(e) };
}

// ── start ───────────────────────────────────────────────────────────────────

export interface StartInput {
  userId: string;
  serverId: string;
  /** Exact redirect target: hosted callback (default) or 127.0.0.1 loopback. */
  redirectUri: string;
}

export async function startAuthorization(input: StartInput): Promise<StartResult> {
  const entry = await resolveEntry(input.userId, input.serverId);
  if (!entry || !remoteOf(entry)) {
    return { status: "error", code: "no_remote", error: `"${input.serverId}" has no remote (OAuth) endpoint — connect it over its token/stdio path instead` };
  }

  const { state } = await createPending({
    userId: input.userId,
    serverId: input.serverId,
    redirectUrl: input.redirectUri,
  });
  const provider = makeProvider(entry, state, input.redirectUri, input.userId);
  const awaiting = (): StartResult => {
    const authUrl = provider.authorizationUrl;
    return authUrl
      ? { status: "awaiting_browser", authUrl, state, expiresAt: Date.now() + PENDING_TTL_MS }
      : { status: "error", code: "oauth_failed", error: "authorization server required sign-in but no redirect URL was produced" };
  };

  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(makeTransport(entry, provider));
    // Stored tokens (or a no-auth initialize) passing the transport setup is
    // NOT enough: some servers only gate the real endpoint (tools/list)
    // after initialize, so bare connect() succeeded while every actual call
    // would fail 401 later — the connector showed "connected" but could
    // never work, and the browser leg never opened. Verify with a real
    // tools/list before promising the user it works.
    try {
      await client.listTools({});
      return { status: "connected" };
    } catch (e) {
      if (!UnauthorizedError.isInstance(e)) return mapStartFailure(e, entry);
      // tools/list is auth-gated even though initialize passed: the browser
      // leg MUST open (fall through to the block below).
      return awaiting();
    }
  } catch (e) {
    if (UnauthorizedError.isInstance(e)) return awaiting();
    return mapStartFailure(e, entry);
  } finally {
    await client.close().catch(() => {});
  }
}

// ── complete ────────────────────────────────────────────────────────────────

export interface CompleteInput {
  /** Session user — the pending row must belong to them (state alone is not enough). */
  userId: string;
  /** OAuth state from the callback (query or POST body). */
  state: string;
  /** The AS callback as name/value pairs (code, iss, error, error_description, …). */
  params: URLSearchParams;
}

export async function completeAuthorization(input: CompleteInput): Promise<CompleteResult> {
  const claim = await claimPending(input.state);
  if (!claim.ok) {
    const code: CompleteErrorCode =
      claim.reason === "unknown" ? "state_unknown" : claim.reason === "expired" ? "state_expired" : claim.reason === "used" ? "state_used" : "state_failed";
    const detail =
      claim.reason === "used"
        ? "This sign-in link was already used — start the connection again."
        : claim.reason === "expired"
          ? "The sign-in session expired — start the connection again."
          : claim.reason === "unknown"
            ? "Unknown or malformed sign-in state."
            : "A previous attempt for this state failed.";
    return { status: "error", code, error: detail };
  }
  const pending = claim.pending;
  if (pending.userId !== input.userId) {
    await failPending(pending.id, pending.version, "state presented by a different session");
    return { status: "error", code: "wrong_owner", error: "This sign-in belongs to another session." };
  }

  const entry = await resolveEntry(pending.userId, pending.serverId);
  if (!entry || !remoteOf(entry)) {
    await failPending(pending.id, pending.version, "server lost its remote endpoint");
    return { status: "error", code: "no_remote", error: `"${pending.serverId}" no longer exposes a remote endpoint` };
  }

  const asError = input.params.get("error");
  if (asError) {
    const desc = input.params.get("error_description") ?? asError;
    await failPending(pending.id, pending.version, `authorization denied: ${desc}`);
    return { status: "error", code: "denied", error: desc };
  }

  const provider = makeProvider(entry, input.state, pending.redirectUrl, pending.userId);

  try {
    const transport = makeTransport(entry, provider);
    await transport.finishAuth(input.params);
  } catch (e) {
    const msg = errorMessage(e);
    await failPending(pending.id, pending.version, msg);
    const issuerMismatch = e instanceof Error && e.name === "IssuerMismatchError";
    return {
      status: "error",
      code: issuerMismatch ? "issuer_mismatch" : "exchange_failed",
      error: issuerMismatch ? `Issuer mismatch (RFC 9207): ${msg}` : `Token exchange failed: ${msg}`,
    };
  }

  // Tokens are stored — prove they actually authorize this MCP endpoint
  // before telling the user "connected". Some servers 200 the initialize
  // without any grant at all, so verify with a REAL tools call (not just
  // transport setup): a grant that only passes initialize is dead on
  // arrival and must be wiped below, not celebrated.
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(makeTransport(entry, provider));
    await client.listTools({});
    return { status: "connected", serverId: pending.serverId };
  } catch (e) {
    // The grant is dead on arrival: wipe it and flag re-auth instead of
    // leaving bad tokens stored (the next attempt would otherwise reuse
    // them and loop on the same failure).
    const { markNeedsReauth } = await import("./store");
    await markNeedsReauth(
      pending.userId,
      pending.serverId,
      `stored session rejected: ${errorMessage(e).slice(0, 200)}`
    ).catch(() => {});
    const issuerMismatch = e instanceof Error && e.name === "IssuerMismatchError";
    return {
      status: "error",
      code: issuerMismatch ? "issuer_mismatch" : "verify_failed",
      error: issuerMismatch
        ? `Issuer mismatch (RFC 9207): ${errorMessage(e)}`
        : `Signed in, but the MCP server rejected the session: ${errorMessage(e)}`,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
