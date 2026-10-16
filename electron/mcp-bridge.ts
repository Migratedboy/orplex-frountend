// electron/mcp-bridge.ts — MCP remote-server bridge for the main process.
//
// Remote MCP servers authenticate with OAuth 2.1 (interactive browser flow,
// dynamic client registration) — NOT personal access tokens, which is why the
// PAT-only catalog fields never worked for them. Per the MCP authorization
// spec the flow is:
//
//   1. Discover the authorization server: a 401 + WWW-Authenticate
//      resource_metadata hint, else RFC 9728 well-known probing on the
//      server URL. Fallback: the server origin is its own authorization
//      server (common for first-party remote servers).
//   2. Fetch authorization-server metadata (RFC 8414, incl. path-scoped
//      variants).
//   3. Dynamic client registration (RFC 7591) — public client, S256 PKCE.
//   4. Authorize in the USER'S browser (shell.openExternal); the callback is
//      caught by a single-use loopback HTTP server on 127.0.0.1 (RFC 8252 —
//      any port is allowed, so the port is chosen by the OS).
//   5. Exchange the code at the token endpoint (Node fetch — no CORS).
//
// Also exposes a Node-side HTTP passthrough (`orplex:mcp-request`) so the
// renderer's MCP JSON-RPC client never fights CORS on remote servers.
//
// Security posture: the loopback server binds 127.0.0.1 only, is single-use,
// validates `state`, and self-closes (callback or 5-minute timeout). The
// passthrough accepts only http(s) URLs.

import { BrowserWindow, ipcMain, shell } from "electron";
import http from "node:http";
import crypto from "node:crypto";

interface FetchResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

const CONTENT_TIMEOUT_MS = 12_000;
const OAUTH_WAIT_MS = 5 * 60_000;
/** Cap on renderer-supplied passthrough bodies (no multi-MB exfiltration). */
const MAX_PASSTHROUGH_BODY = 1 * 1024 * 1024;

/**
 * Local mirror of src/lib/mcp/ssrf-fetch.ts hostname policy (electron/
 * can't import src/ — tsconfig rootDir. Keep the two in sync by hand:
 * http(s) only, loopback allowed (local dev servers), private/link-local/
 * metadata/CGNAT blocked, public hosts require https).
 * Returns an error string, or null when the URL may be fetched.
 */
function mcpFetchUrlError(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Invalid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Only http(s) URLs are allowed";
  const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) return "URL has no host";
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  ) {
    return null; // loopback: local dev servers are first-class
  }
  if (
    /^169\.254\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^::$/.test(host) ||
    /^f[cd]/i.test(host) ||
    /^fe[89ab]/i.test(host)
  ) {
    return `Private/link-local host blocked: ${host}`;
  }
  if (u.protocol === "http:") return `Plain http to public host — https required (${host})`;
  return null;
}

/** Origin equality for pinning derived endpoints to their metadata source. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function parseWWWAuthenticate(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const m = /^(\w+)\s+(.*)$/.exec(header.trim());
  if (!m) return out;
  out.scheme = m[1];
  const re = /(\w+)="([^"]*)"/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(m[2]))) out[mm[1]] = mm[2];
  return out;
}
async function fetchText(url: string, init: RequestInit = {}, timeoutMs = CONTENT_TIMEOUT_MS): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // redirect: "manual" - the SSRF screen (mcpFetchUrlError) validated only
    // the INITIAL url, so `redirect: "follow"` let a public https URL that 302s
    // to http://169.254.169.254/... (or any RFC1918 host) walk straight past
    // the private/link-local policy. Following manually means every hop is
    // re-screened.
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(current, { ...init, signal: ctrl.signal, redirect: "manual" });
      if (res.status < 300 || res.status > 399) break;
      const loc = res.headers.get("location");
      if (!loc) break;
      let next: string;
      try {
        next = new URL(loc, current).toString();
      } catch {
        break;
      }
      // Re-screen the redirect target exactly as the initial URL.
      const screened = mcpFetchUrlError(next);
      if (screened) throw new Error(screened);
      current = next;
    }
    const finalRes = res!;
    const headers: Record<string, string> = {};
    finalRes.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const text = await finalRes.text();
    return { status: finalRes.status, headers, text };
  } finally {
    clearTimeout(timer);
  }
}
function originOf(url: string): string {
  return new URL(url).origin;
}

function pathOf(url: string): string {
  return new URL(url).pathname.replace(/\/+$/, "");
}

/** Minimal JSON-RPC initialize probe — used to trigger the spec's 401 hint. */
function initializeProbe(serverUrl: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "orplex", version: "1.0.0" },
    },
  });
}

/** Find the authorization server(s) for a remote MCP server URL. */
async function discoverAuthorizationServers(serverUrl: string): Promise<{ asUrls: string[]; scopeHint?: string; resourceParam?: string }> {
  const asUrls: string[] = [];
  let scopeHint: string | undefined;
  let resourceParam: string | undefined;

  // 1) Spec-preferred: a probe request's 401 WWW-Authenticate may carry
  //    resource_metadata pointing at the protected-resource document.
  try {
    const probe = await fetchText(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: initializeProbe(serverUrl),
    });
    if (probe.status === 401) {
      const www = parseWWWAuthenticate(probe.headers["www-authenticate"]);
      scopeHint = www.scope;
      resourceParam = www.resource;
      if (www.resource_metadata && !mcpFetchUrlError(www.resource_metadata)) {
        // NOTE: server-controlled URL — gated by policy above. A blocked
        // metadata URL simply yields no AS URLs from this hint (fall through
        // to well-known probing below).
        const rm = await fetchText(www.resource_metadata);
        if (rm.status === 200) {
          const j = JSON.parse(rm.text) as { authorization_servers?: string[]; scopes_supported?: string[]; resource?: string };
          for (const as of j.authorization_servers ?? []) asUrls.push(as);
          scopeHint = scopeHint ?? ((j.scopes_supported ?? []).join(" ") || undefined);
        }
      }
    }
  } catch {
    // Unreachable/probing failure — fall through to well-known discovery.
  }

  // 2) RFC 9728 well-known probing (origin + path-scoped variants).
  const wellKnowns = [
    `${originOf(serverUrl)}/.well-known/oauth-protected-resource`,
    `${originOf(serverUrl)}/.well-known/oauth-protected-resource${pathOf(serverUrl)}`,
  ];
  for (const wk of wellKnowns) {
    if (asUrls.length) break;
    try {
      const r = await fetchText(wk);
      if (r.status !== 200) continue;
      const j = JSON.parse(r.text) as { authorization_servers?: string[]; scopes_supported?: string[]; resource?: string };
      const servers = j.authorization_servers ?? [];
      if (servers.length) {
        asUrls.push(...servers);
        resourceParam = resourceParam ?? j.resource;
        scopeHint = scopeHint ?? ((j.scopes_supported ?? []).join(" ") || undefined);
      }
    } catch {}
  }

  // 3) Fallback: the MCP server is its own authorization server.
  if (!asUrls.length) asUrls.push(originOf(serverUrl));
  return { asUrls, scopeHint, resourceParam };
}

interface AsMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

async function fetchAsMetadata(asUrl: string): Promise<AsMetadata | null> {
  const asPath = pathOf(asUrl);
  const candidates = [
    `${originOf(asUrl)}/.well-known/oauth-authorization-server`,
    ...(asPath ? [`${originOf(asUrl)}/.well-known/oauth-authorization-server${asPath}`] : []),
  ];
  for (const url of candidates) {
    try {
      const r = await fetchText(url);
      if (r.status !== 200) continue;
      const j = JSON.parse(r.text) as AsMetadata;
      if (j.authorization_endpoint && j.token_endpoint) return j;
    } catch {}
  }
  return null;
}

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
}

async function registerClient(meta: AsMetadata, redirectUri: string, label: string): Promise<RegisteredClient | null> {
  if (!meta.registration_endpoint) return null;
  try {
    const r = await fetchText(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: `Orplex Code${label ? ` — ${label}` : ""}`,
        client_uri: "https://orplex.tech",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none", // public client, PKCE only
        ...(meta.scopes_supported?.length ? { scope: meta.scopes_supported.join(" ") } : {}),
      }),
    });
    if (r.status !== 200 && r.status !== 201) return null;
    const j = JSON.parse(r.text) as RegisteredClient;
    return j.client_id ? j : null;
  } catch {
    return null;
  }
}

/**
 * Single-use loopback server (RFC 8252). Binds port 0 FIRST and hands back
 * the OS-assigned port so the redirect URI carries the actual port — there
 * is deliberately no probe-then-rebind step (that leaves a window where a
 * local process could squat the port and steal the OAuth code).
 * Resolves with { code } or { error }; always closes itself.
 */
function bindOAuthCallback(
  state: string
): Promise<{ port: number; wait: Promise<{ code?: string; error?: string }>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let server: http.Server;
    const wait = new Promise<{ code?: string; error?: string }>((resolveWait, rejectWait) => {
      const finish = (value: { code?: string; error?: string }, isError: boolean) => {
        if (settled) return;
        settled = true;
        server.close(() => {});
        if (isError) rejectWait(new Error(value.error ?? "OAuth callback failed"));
        else resolveWait(value);
      };
      const timer = setTimeout(
        () => finish({ error: "Timed out waiting for the browser sign-in (5 min). Complete the sign-in in the browser that opened, or try again." }, true),
        OAUTH_WAIT_MS
      );
      const done = (value: { code?: string; error?: string }) => {
        clearTimeout(timer);
        finish(value, false);
      };
      const fail = (e: unknown) => {
        clearTimeout(timer);
        finish({ error: (e as Error)?.message ?? String(e) }, true);
      };
      let listening = false;
      server = http.createServer((req, res) => {
        try {
          const u = new URL(req.url ?? "/", "http://127.0.0.1");
          if (u.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          const code = u.searchParams.get("code");
          const err = u.searchParams.get("error");
          const gotState = u.searchParams.get("state");
          const ok = !err && !!code && gotState === state;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            ok
              ? `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#141414;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#ff6b00">&#10003; Orplex connected</h2><p style="color:#9aa">You can close this tab and return to the app.</p></div></body>`
              : `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#141414;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>Connection failed</h2><p style="color:#9aa">${err ?? "missing code"} — return to the app and try again.</p></div></body>`
          );
          // Single-use: only a MATCHED callback settles the flow. Unmatched
          // hits (port scans, stray probes) get their response above but must
          // not destroy the pending sign-in — the 5-minute timer is the
          // backstop, not every stray request.
          if (ok || gotState === state) {
            setTimeout(() => done(ok ? { code: code! } : { error: err ?? "missing code" }), 100); // let the response flush
          }
        } catch (e) {
          try {
            res.writeHead(500).end();
          } catch {}
          fail(e);
        }
      });
      server.on("error", (e) => {
        // A bind failure must reject the outer setup promise (not just the
        // wait) or the caller hangs forever awaiting a port that never comes.
        if (!listening) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
          }
          reject(e);
          return;
        }
        fail(e);
      });
      server.listen(0, "127.0.0.1", () => {
        listening = true;
        const port = (server.address() as { port: number }).port;
        resolve({
          port,
          wait,
          close: () => {
            try {
              server.close(() => {});
            } catch {}
          },
        });
      });
    });
  });
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface OAuthResult {
  ok: boolean;
  error?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  serverUrl?: string;
}

async function exchangeCode(tokenEndpoint: string, body: Record<string, string>): Promise<OAuthResult> {
  const r = await fetchText(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  let j: TokenResponse;
  try {
    j = JSON.parse(r.text) as TokenResponse;
  } catch {
    throw new Error(`Token endpoint returned non-JSON (HTTP ${r.status})`);
  }
  if (r.status !== 200 || !j.access_token) {
    throw new Error(`Token exchange failed: ${j.error_description ?? j.error ?? `HTTP ${r.status}`}`);
  }
  return {
    ok: true,
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresIn: j.expires_in,
    tokenType: j.token_type ?? "Bearer",
    scope: j.scope,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    tokenEndpoint,
  };
}

export function registerMcpIpc(): void {
  // ── SDK-driven flow (spec Phase 3): loopback only RELAYS the AS redirect ──
  // The renderer drives the official MCP client via /api/mcp/* and holds the
  // session cookie; the main process has none. So this listener's job is just:
  // bind a port BEFORE connect (exact redirect_uri into DCR), validate the
  // returned state (defense-in-depth — the server's one-time claim is
  // authoritative), show a holding page, and hand the params to the renderer.
  interface LoopbackState {
    server: http.Server;
    port: number;
    expectedState: string | null;
    timer: NodeJS.Timeout;
  }
  let loopback: LoopbackState | null = null;

  const closeLoopback = (): void => {
    if (!loopback) return;
    clearTimeout(loopback.timer);
    const lb = loopback;
    loopback = null;
    try {
      lb.server.close(() => {});
    } catch {}
  };

  const relayPage = (ok: boolean, detail: string): string =>
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#141414;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:${ok ? "#ff6b00" : "#eee"}">${ok ? "&#10003; Orplex received the sign-in" : "Connection failed"}</h2><p style="color:#9aa">${detail}</p></div></body>`;

  ipcMain.handle(
    "orplex:mcp-oauth-prepare",
    async (): Promise<{ ok: boolean; redirectUri?: string; error?: string }> => {
      closeLoopback(); // one active flow at a time
      return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
          try {
            const u = new URL(req.url ?? "/", "http://127.0.0.1");
            if (u.pathname !== "/callback") {
              res.writeHead(404).end();
              return;
            }
            const code = u.searchParams.get("code");
            const state = u.searchParams.get("state");
            const iss = u.searchParams.get("iss");
            const error = u.searchParams.get("error");
            const errorDescription = u.searchParams.get("error_description");
            const matched = !!state && !!loopback && state === loopback.expectedState;
            const ok = matched && !error && !!code;
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              ok
                ? relayPage(true, "You can close this tab and return to the Orplex app — the connector is being connected now.")
                : relayPage(false, `${error ?? "sign-in did not complete"} — return to the app and try again.`)
            );
            if (matched) {
              const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
              win?.webContents.send("orplex:mcp-oauth-callback", {
                code: code ?? undefined,
                state: state ?? undefined,
                iss: iss ?? undefined,
                error: error ?? undefined,
                error_description: errorDescription ?? undefined,
              });
              // Single-use: a MATCHED callback settles the flow. Unmatched
              // hits (scans, stray probes) must not destroy a pending
              // sign-in — the 5-minute timer is the backstop, not them.
              setTimeout(closeLoopback, 150);
            }
          } catch {
            res.writeHead(500).end();
            setTimeout(closeLoopback, 150);
          }
        });
        server.on("error", (e) => {
          if (loopback?.server === server) closeLoopback();
          resolve({ ok: false, error: (e as Error).message });
        });
        server.listen(0, "127.0.0.1", () => {
          const port = (server.address() as { port: number }).port;
          loopback = { server, port, expectedState: null, timer: setTimeout(closeLoopback, OAUTH_WAIT_MS) };
          resolve({ ok: true, redirectUri: `http://127.0.0.1:${port}/callback` });
        });
      });
    }
  );

  ipcMain.handle(
    "orplex:mcp-oauth-open",
    async (_e, params: { authUrl?: string }): Promise<{ ok: boolean; error?: string }> => {
      if (!loopback) return { ok: false, error: "No prepared loopback listener — call mcpOAuth.prepare() first." };
      if (!params.authUrl) return { ok: false, error: "Missing authUrl" };
      // The auth URL is renderer-supplied: enforce https (loopback http is
      // fine for local dev servers) and refuse private/intranet targets, so
      // a compromised renderer cannot turn the OS browser into an intranet
      // prober or file opener. Origin-pinning to the AS is enforced on the
      // SDK path (fetchAsMetadata + endpoint pins); here the browser itself
      // shows the user where they are signing in.
      const blocked = mcpFetchUrlError(params.authUrl);
      if (blocked) return { ok: false, error: `Blocked by URL policy: ${blocked}` };
      let state: string | null;
      try {
        state = new URL(params.authUrl).searchParams.get("state");
      } catch {
        return { ok: false, error: "authUrl is not a valid URL" };
      }
      if (!state) return { ok: false, error: "authUrl has no state parameter" };
      loopback.expectedState = state;
      await shell.openExternal(params.authUrl); // system browser — never a webview
      return { ok: true };
    }
  );

  // Generic HTTP passthrough so the renderer's MCP JSON-RPC client avoids
  // CORS on remote servers. SSRF-gated (same policy as the server lane),
  // method-allowlisted, body-capped, 30s ceiling.
  ipcMain.handle(
    "orplex:mcp-request",
    async (_e, params: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
      try {
        if (typeof params.url !== "string") throw new Error("Missing url");
        const blocked = mcpFetchUrlError(params.url);
        if (blocked) throw new Error(`Blocked by URL policy: ${blocked}`);
        const method = (params.method ?? "GET").toUpperCase();
        if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) {
          throw new Error(`HTTP method not allowed: ${method}`);
        }
        if (typeof params.body === "string" && params.body.length > MAX_PASSTHROUGH_BODY) {
          throw new Error("Request body too large");
        }
        const r = await fetchText(
          params.url,
          { method, headers: params.headers, body: params.body },
          30_000
        );
        return { ok: true, status: r.status, headers: r.headers, text: r.text };
      } catch (err) {
        return { ok: false, error: (err as Error)?.message ?? String(err) };
      }
    }
  );

  // Full OAuth 2.1 flow for a remote MCP server. Runs entirely in the main
  // process: discovery → DCR → browser sign-in → loopback callback → token
  // exchange. The renderer only supplies the server URL.
  ipcMain.handle("orplex:mcp-oauth-authorize", async (_e, params: { serverUrl: string; label?: string }): Promise<OAuthResult> => {
    try {
      if (typeof params.serverUrl !== "string") return { ok: false, error: "Missing serverUrl" };
      const entryBlocked = mcpFetchUrlError(params.serverUrl);
      if (entryBlocked) return { ok: false, error: `Blocked by URL policy: ${entryBlocked}` };
      const serverUrl = new URL(params.serverUrl).toString();
      const { asUrls, scopeHint, resourceParam } = await discoverAuthorizationServers(serverUrl);
      let lastError = "No OAuth-capable authorization server found for this MCP server.";

      for (const asUrl of asUrls) {
        // Discovered URLs come from server-controlled JSON — gate each one,
        // and pin every derived endpoint to the AS origin so a rogue
        // metadata document cannot redirect registration, auth, or token
        // exchange to an attacker origin.
        const asBlocked = mcpFetchUrlError(asUrl);
        if (asBlocked) {
          lastError = `Authorization server blocked by URL policy: ${asBlocked}`;
          continue;
        }
        const asOrigin = new URL(asUrl).origin;
        const meta = await fetchAsMetadata(asUrl);
        if (!meta) {
          lastError = `No OAuth metadata at ${asUrl}`;
          continue;
        }
        if (!sameOrigin(meta.authorization_endpoint, asOrigin) || !sameOrigin(meta.token_endpoint, asOrigin)) {
          lastError = `Authorization server metadata points outside its own origin — refusing (possible rogue metadata)`;
          continue;
        }
        if (meta.registration_endpoint && !sameOrigin(meta.registration_endpoint, asOrigin)) {
          lastError = `Registration endpoint points outside the authorization server origin — refusing`;
          continue;
        }

        // Bind the loopback server FIRST — the registered redirect URI must
        // carry the actual (OS-assigned) port, with no probe-then-rebind
        // window for a local squatter to steal the OAuth code.
        const state = crypto.randomBytes(16).toString("base64url");
        const bound = await bindOAuthCallback(state);
        const redirectUri = `http://127.0.0.1:${bound.port}/callback`;

        const client = await registerClient(meta, redirectUri, params.label ?? "");
        if (!client) {
          bound.close();
          lastError = `The authorization server (${asUrl}) does not support dynamic client registration, and no pre-registered client is configured for it.`;
          continue;
        }

        const verifier = crypto.randomBytes(48).toString("base64url");
        const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

        const authorizeUrl = new URL(meta.authorization_endpoint);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", client.client_id);
        authorizeUrl.searchParams.set("redirect_uri", redirectUri);
        authorizeUrl.searchParams.set("code_challenge", challenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
        authorizeUrl.searchParams.set("state", state);
        const scope = scopeHint || (meta.scopes_supported ?? []).join(" ");
        if (scope) authorizeUrl.searchParams.set("scope", scope);
        // RFC 8707 resource indicator — required by some MCP servers.
        if (resourceParam) authorizeUrl.searchParams.set("resource", resourceParam);

        await shell.openExternal(authorizeUrl.toString());

        const cb = await bound.wait;
        if (cb.error) {
          lastError = `Sign-in failed: ${cb.error}`;
          continue;
        }

  const result = await exchangeCode(meta.token_endpoint, {
    grant_type: "authorization_code",
    code: cb.code!,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    ...(client.client_secret ? { client_secret: client.client_secret } : {}),
    code_verifier: verifier,
  });
  // Strip every credential before this crosses into the renderer. Returning
  // `...result` shipped the access token, the refresh token AND the
  // dynamically-registered client_secret into renderer memory, contradicting
  // the server-lane invariant in src/app/api/mcp/connections/route.ts ("tokens
  // never leave store.ts"). Any script execution in the renderer - and we just
  // fixed an SVG-XSS path into exactly that - exfiltrated every connected MCP
  // server's long-lived credentials. Callers only need to know it worked.
  return { ok: true, serverUrl };
}
      return { ok: false, error: lastError };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  });

  ipcMain.handle(
    "orplex:mcp-oauth-refresh",
    async (_e, params: { serverUrl: string; refreshToken: string; clientId: string; clientSecret?: string; tokenEndpoint?: string }): Promise<OAuthResult> => {
      try {
        // A stored tokenEndpoint comes from the renderer's persisted
        // connection — policy-gate it (a tampered store must not redirect
        // refresh grants). Falls back to fresh discovery below.
        let tokenEndpoint = params.tokenEndpoint && !mcpFetchUrlError(params.tokenEndpoint)
          ? params.tokenEndpoint
          : undefined;
        if (!tokenEndpoint) {
          const { asUrls } = await discoverAuthorizationServers(params.serverUrl);
          for (const asUrl of asUrls) {
            const meta = await fetchAsMetadata(asUrl);
            if (meta) { tokenEndpoint = meta.token_endpoint; break; }
          }
        }
        if (!tokenEndpoint) throw new Error("No token endpoint found for refresh — reconnect the server instead.");
        const result = await exchangeCode(tokenEndpoint, {
          grant_type: "refresh_token",
          refresh_token: params.refreshToken,
          client_id: params.clientId,
          ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
        });
        return { ...result, serverUrl: params.serverUrl };
      } catch (err) {
        return { ok: false, error: (err as Error)?.message ?? String(err) };
      }
    }
  );
}
