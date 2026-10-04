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
    const res = await fetch(url, { ...init, signal: ctrl.signal, redirect: "follow" });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    const text = await res.text();
    return { status: res.status, headers, text };
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
      if (www.resource_metadata) {
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
 * Single-use loopback server (RFC 8252). Binds first so the redirect URI can
 * carry the actual port, then waits for the provider's callback. Resolves
 * with { code } or { error }; always closes itself.
 */
function authorizeViaLoopback(
  port: number,
  authorizeUrl: string,
  state: string
): Promise<{ code?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
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
        const finish = () => {
          if (settled) return;
          settled = true;
          server.close(() => {});
          resolve(ok ? { code: code! } : { error: err ?? "missing code" });
        };
        setTimeout(finish, 100); // let the response flush before closing
      } catch (e) {
        res.writeHead(500).end();
        if (!settled) {
          settled = true;
          server.close(() => {});
          reject(e as Error);
        }
      }
    });
    server.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    server.listen(port, "127.0.0.1");
    setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close(() => {});
        reject(new Error("Timed out waiting for the browser sign-in (5 min). Complete the sign-in in the browser that opened, or try again."));
      }
    }, OAUTH_WAIT_MS);
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
            }
            setTimeout(closeLoopback, 150); // single-use: first /callback settles it
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
  // CORS on remote servers. http(s) only, 30s ceiling.
  ipcMain.handle(
    "orplex:mcp-request",
    async (_e, params: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
      try {
        const url = new URL(params.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          throw new Error("Only http(s) URLs are allowed");
        }
        const r = await fetchText(
          params.url,
          { method: params.method ?? "GET", headers: params.headers, body: params.body },
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
      const serverUrl = new URL(params.serverUrl).toString();
      const { asUrls, scopeHint, resourceParam } = await discoverAuthorizationServers(serverUrl);
      let lastError = "No OAuth-capable authorization server found for this MCP server.";

      for (const asUrl of asUrls) {
        const meta = await fetchAsMetadata(asUrl);
        if (!meta) {
          lastError = `No OAuth metadata at ${asUrl}`;
          continue;
        }

        // Bind the loopback server first — the registered redirect URI must
        // carry the actual (OS-assigned) port.
        const port = await new Promise<number>((resolve, reject) => {
          const probe = http.createServer();
          probe.on("error", reject);
          probe.listen(0, "127.0.0.1", () => {
            const p = (probe.address() as { port: number }).port;
            probe.close(() => resolve(p));
          });
        });
        const redirectUri = `http://127.0.0.1:${port}/callback`;

        const client = await registerClient(meta, redirectUri, params.label ?? "");
        if (!client) {
          lastError = `The authorization server (${asUrl}) does not support dynamic client registration, and no pre-registered client is configured for it.`;
          continue;
        }

        const verifier = crypto.randomBytes(48).toString("base64url");
        const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
        const state = crypto.randomBytes(16).toString("base64url");

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

        const cb = await authorizeViaLoopback(port, authorizeUrl.toString(), state);
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
        return { ...result, serverUrl };
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
        let tokenEndpoint = params.tokenEndpoint;
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
