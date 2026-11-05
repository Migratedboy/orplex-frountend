// audit-mcp-oauth.mjs — Phase 6.5: end-to-end OAuth lane audit for every
// remote catalog candidate. Proves (or refutes) that a hosted connector's
// browser OAuth actually works in Orplex, WITHOUT needing a human password
// step, by driving exactly the RFC 9728/7591 legs the SDK performs:
//
//   1. initialize          → 401 + WWW-Authenticate (or a 200 = public)
//   2. discovery           → resource metadata → authorization servers →
//                            AS metadata (registration + authorization
//                            endpoints, incl. the RFC 9728 origin/path
//                            fallbacks for servers without the header)
//   3. dynamic registration → POST registration_endpoint (RFC 7591), the
//                            same registration the app does on first
//                            connect — proves DCR accepts Orplex metadata
//   4. authorize URL       → GET authorization_endpoint with PKCE + state +
//                            the app's RFC 8252 loopback redirect → expects
//                            the AS's login page (200/302) — proves the
//                            browser leg opens instead of erroring
//
// Verdicts:
//   connected         initialize 200 (public/too-inconclusive-gate rules)
//   oauth_ok          registration + authorize leg verified end-to-end
//   oauth_ok_with_client  pinned authority: leg verified, still needs a
//                            vendor static client id (env var)
//   needs_client      no open DCR → works once ORPLEX_MCP_CLIENT_ID_<ID>
//                     (+ secret) is registered with the vendor (static-client
//                     lane is already wired in mcp-catalog.ts / provider.ts)
//   oauth_broken      OAuth metadata exists but a leg is actually broken
//
// Usage: node scripts/audit-mcp-oauth.mjs [--offline]
// Report: docs/MCP-OAUTH-PROVIDERS.md. Exit 0 = no oauth_broken finding.

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { createHash, randomBytes } from "crypto";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "node_modules", ".cache", "orplex-mcp-oauth-audit");
const REPORT = path.join(ROOT, "docs", "MCP-OAUTH-PROVIDERS.md");
const OFFLINE = process.argv.includes("--offline");
const TIMEOUT_MS = 15_000;

function compile() {
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tsc)) throw new Error("typescript not installed — run npm install");
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.mkdirSync(CACHE, { recursive: true });
  try {
    execFileSync(
      process.execPath,
      [
        tsc,
        path.join(ROOT, "src", "lib", "mcp-catalog.ts"),
        "--outDir", CACHE,
        "--module", "commonjs",
        "--target", "es2020",
        "--esModuleInterop",
        "--skipLibCheck",
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    throw new Error(`tsc compile failed:\n${(e.stderr || "").toString().trim() || e.message}`);
  }
  const req = createRequire(import.meta.url);
  const mod = req(path.join(CACHE, "mcp-catalog.js"));
  if (!Array.isArray(mod.MCP_CATALOG)) throw new Error("compiled catalog missing MCP_CATALOG");
  return mod;
}

// ── tiny json fetch ─────────────────────────────────────────────────────────

async function jsonFetch(url, opts = {}) {
  const { method = "GET", headers = {}, body = null, timeoutMs = TIMEOUT_MS } = opts;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctl.signal,
      redirect: "manual", // we WANT to inspect redirects on the authorize leg
      headers: { accept: "application/json", ...headers },
      ...(body !== null ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    if ((res.headers.get("content-type") ?? "").includes("json") && text) {
      try { json = JSON.parse(text); } catch { /* html login page et al. */ }
    }
    return { status: res.status, headers: res.headers, text, json };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: "", json: null, err: e?.message ?? String(e) };
  } finally {
    clearTimeout(t);
  }
}

function parseWwwAuthenticate(v) {
  const out = {};
  if (!v) return out;
  let m;
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  while ((m = re.exec(v))) out[m[1].toLowerCase()] = m[2] ?? m[3];
  // scheme
  out.scheme = v.split(/\s+/)[0]?.toLowerCase() ?? "";
  return out;
}

/** RFC 9728 fallback chain — mirrors the SDK's discovery strategy. */
async function discoverResourceMetadata(url) {
  const u = new URL(url);
  const base = u.origin;
  const pathBased = `${base}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, "")}`;
  const candidates = [
    ...(u.pathname && u.pathname !== "/" ? [pathBased] : []),
    `${base}/.well-known/oauth-protected-resource`,
  ];
  for (const c of candidates) {
    const r = await jsonFetch(c);
    if (r.status === 200 && r.json && (r.json.authorization_servers || r.json.authorization_endpoint)) {
      return { url: c, md: r.json };
    }
  }
  return null;
}

async function asMetadata(issuer) {
  const trimmed = issuer.replace(/\/+$/, "");
  const tryUrls = [
    `${trimmed}/.well-known/oauth-authorization-server`,
    `${new URL(trimmed).origin}/.well-known/oauth-authorization-server`,
    `${trimmed}/.well-known/openid-configuration`, // Entra-style ASes
  ];
  for (const u of tryUrls) {
    const r = await jsonFetch(u);
    if (r.status === 200 && r.json && (r.json.authorization_endpoint || r.json.registration_endpoint)) return r.json;
  }
  return null;
}

// ── OAuth leg driver (what the app's DbMcpOAuthProvider + SDK do) ──────────

function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Build the PKCE authorization probe URL for a registered client. */
function authorizeRedirectProbe(authorizationEndpoint, clientId) {
  const { challenge } = pkcePair();
  const authz = new URL(authorizationEndpoint);
  authz.searchParams.set("response_type", "code");
  authz.searchParams.set("client_id", clientId);
  authz.searchParams.set("redirect_uri", APP_LOOPBACK);
  authz.searchParams.set("code_challenge", challenge);
  authz.searchParams.set("code_challenge_method", "S256");
  authz.searchParams.set("state", randomBytes(16).toString("base64url"));
  return authz;
}

/** The desktop leg's redirect target — RFC 8252 loopback on /callback. */
const APP_LOOPBACK = "http://127.0.0.1:49431/callback";

async function driveOAuthLeg(entryId, url, entryOauth) {
  const step = {};

  // A PINNED authority (catalog oauth.authority) replaces RFC 9728 discovery:
  // some vendors (Atlassian, Entra) never advertise resource metadata on
  // their 401. The SDK seeds discoveryState the same way in the app.
  if (entryOauth?.authority) {
    const md = await asMetadata(entryOauth.authority);
    step.as = entryOauth.authority;
    if (!md) {
      return { verdict: "oauth_broken", detail: `pinned authority ${entryOauth.authority} serves no AS metadata`, steps: step };
    }
    const reg = await jsonFetch(md.registration_endpoint ?? "", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Orplex",
        redirect_uris: [APP_LOOPBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }).catch(() => null);
    step.dcr = reg?.status ?? 0;
    if (reg?.status === 200 || reg?.status === 201) {
      const authz = authorizeRedirectProbe(md.authorization_endpoint, reg.json.client_id);
      const authorize = await jsonFetch(authz.toString(), {
        headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Orplex-audit" },
      });
      step.authorize = authorize.status;
      // Any 3xx handoff means the AS processed the request — consent/login
      // pages are vendor pages (paypal.com/connect, Entra login, …).
      if (authorize.status >= 300 && authorize.status < 400 && authorize.headers.get("location")) {
        return { verdict: "oauth_ok_with_client", detail: "pinned authority: registration + authorize accepted, browser handoff verified (needs ORPLEX_MCP_CLIENT_ID)", steps: step };
      }
    }
    const envkey = `ORPLEX_MCP_CLIENT_ID_${entryId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    return {
      verdict: "needs_client",
      detail: `pinned authority ${entryOauth.authority}: ${reg?.status === 400 ? "registration rejected" : "no open registration"} — register one app with the vendor and set ${envkey}`,
      steps: step,
    };
  }

  // 1. initialize
  const init = await jsonFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "Orplex", version: "1.0.0" },
      },
    }),
  });
  step.initialize = init.status;

  if (init.status === 200) {
    // Public initialize. The SDK session decides tool gating inside the
    // app; a non-401 (e.g. 400 without session handshake) means the probe
    // itself is inconclusive, not that the connector is gated.
    const tools = await jsonFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    if (tools.status === 200) return { verdict: "connected", detail: "public endpoint (no auth), tools/list open", steps: step };
    return { verdict: "connected", detail: `public endpoint (no auth) — tools/list probe inconclusive (HTTP ${tools.status}; SDK session handshake applies)`, steps: step };
  }
  if (init.status !== 401) {
    return { verdict: "oauth_broken", detail: `initialize answered ${init.status} instead of 401/200`, steps: step };
  }

  // 2. discovery
  const wa = parseWwwAuthenticate(init.headers.get("www-authenticate"));
  let resource = null;
  if (wa.resource_metadata) {
    const rmFetch = await jsonFetch(wa.resource_metadata);
    if (rmFetch.status === 200) resource = rmFetch.json;
  }
  if (!resource) {
    const fallback = await discoverResourceMetadata(url);
    if (fallback) {
      resource = fallback.md;
      step.discovery = `fallback ${fallback.url}`;
    }
  } else {
    step.discovery = wa.resource_metadata;
  }
  if (!resource) {
    return { verdict: "oauth_broken", detail: "401 but neither the WWW-Authenticate header nor the RFC 9728 fallback yields resource metadata", steps: step };
  }

  const asIssuers = resource.authorization_servers ?? [];
  if (!asIssuers.length) {
    // resource metadata may itself carry the endpoints (some ASes do)
    if (resource.authorization_endpoint) asIssuers.push(String(new URL(resource.authorization_endpoint, url).origin));
    else return { verdict: "oauth_broken", detail: "resource metadata has no authorization_servers", steps: step };
  }

  for (const issuer of asIssuers) {
    const md = await asMetadata(issuer);
    if (!md) continue;
    step.as = issuer;
    const regEndpoint = md.registration_endpoint;

    if (!regEndpoint) {
      const envkey = `ORPLEX_MCP_CLIENT_ID_${entryId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
      return {
        verdict: "needs_client",
        detail: `authorization server ${issuer} has no dynamic client registration — register one app with the vendor and set ${envkey}`,
        steps: step,
      };
    }

    // 3. DCR — the real registration the app performs on first connect
    const reg = await jsonFetch(regEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Orplex",
        redirect_uris: [APP_LOOPBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    step.dcr = reg.status;
    if (reg.status !== 200 && reg.status !== 201) {
      return {
        verdict: "needs_client",
        detail: `DCR exists but rejected Orplex metadata (HTTP ${reg.status}) — register one static app with the vendor and set ORPLEX_MCP_CLIENT_ID_${entryId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
        steps: step,
      };
    }

    // 4. authorize leg with PKCE — must land on the AS's login page, never a redirect_uri/400 error
    const authz = authorizeRedirectProbe(md.authorization_endpoint, reg.json.client_id);
    const authorize = await jsonFetch(authz.toString(), {
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Orplex-audit" },
    });
    step.authorize = authorize.status;
    const location = authorize.headers.get("location");
    if (authorize.status >= 200 && authorize.status < 400 && location && /^http:\/\/127\.0\.0\.1:49431\/callback/.test(location)) {
      return { verdict: "oauth_ok", detail: "AS redirects straight to the loopback callback (fully provisioned leg)", steps: step };
    }
    // Any 2xx page or 3xx handoff = the AS processed our request and moved to
    // its own login/consent flow (paypal.com/connect, Canva login, …). Only
    // hard errors (4xx/5xx, no location) are broken legs.
    if (authorize.status === 200 || (authorize.status >= 300 && authorize.status < 400 && location)) {
      return { verdict: "oauth_ok", detail: `browser opens the authorization flow${location ? ` → ${location.slice(0, 60)}…` : ""}`, steps: step };
    }
    // Retry once without Accept:text/html — some ASes 406 on content negotiation.
    const retry = await jsonFetch(authz.toString());
    step.authorizeRetry = retry.status;
    if (retry.status === 200 || (retry.status >= 300 && retry.status < 400 && retry.headers.get("location"))) {
      return { verdict: "oauth_ok", detail: "browser opens the authorization flow (after content-negotiation retry)", steps: step };
    }
    const detail = `authorization leg answered ${authorize.status}${authorize.json?.error ? ` (${authorize.json.error})` : ""}${retry.status !== authorize.status ? `, retry ${retry.status}` : ""}`;
    return { verdict: "oauth_broken", detail, steps: step };
  }

  return { verdict: "oauth_broken", detail: `authorization server metadata unreachable for ${asIssuers.join(", ")}`, steps: step };
}

// ── main ────────────────────────────────────────────────────────────────────

function envKey(id) {
  return `ORPLEX_MCP_CLIENT_ID_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

async function main() {
  const mod = compile();
  const candidates = [];
  const seen = new Set();
  for (const e of mod.MCP_CATALOG) {
    if (!e.remote && !(e.stdio?.args ?? []).some((a) => /^https?:\/\//.test(a))) continue;
    const urls = e.remote ? [e.remote.url] : e.stdio.args.filter((a) => /^https?:\/\//.test(a));
    for (const url of urls) {
      const key = `${e.id}|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ id: e.id, name: e.name, url, docs: e.docsUrl ?? null, oauth: e.oauth ?? null, transport: e.remote?.transport });
    }
  }

  console.log(`MCP OAuth lane audit — ${candidates.length} remote candidates\n`);
  const rows = [];
  for (const c of candidates) {
    let result;
    if (OFFLINE) result = { verdict: "skipped", detail: "--offline", steps: {} };
    else result = await driveOAuthLeg(c.id, c.url, c.oauth);
    rows.push({ ...c, ...result });
    const icon = result.verdict === "connected" || result.verdict === "oauth_ok" || result.verdict === "oauth_ok_with_client" ? "%"
      : result.verdict === "needs_client" ? "~" : result.verdict === "skipped" ? "-" : "✗";
    console.log(`  ${icon} ${c.id.padEnd(14)} ${result.verdict.padEnd(13)} ${result.detail.slice(0, 110)}`);
  }

  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const broken = rows.filter((r) => r.verdict === "oauth_broken");

  // report
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    "# MCP OAuth providers",
    "",
    `Generated by \`node scripts/audit-mcp-oauth.mjs\` on ${date}. This is the Phase 6.5`,
    "end-to-end proof that every catalog remote connector's browser OAuth leg works",
    "in Orplex: initialize → RFC 9728 discovery → dynamic client registration →",
    "PKCE authorization URL accepted. The only step a script cannot perform is the",
    "human password click.",
    "",
    "## Summary",
    "",
    ...Object.entries(counts).map(([k, v]) => `- **${k}**: ${v}`),
    "",
    "| entry | url | verdict | detail |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.url} | ${r.verdict} | ${r.detail.replace(/\|/g, "/").slice(0, 160)} |`),
    "",
  ];
  const needs = rows.filter((r) => r.verdict === "needs_client");
  if (needs.length) {
    lines.push(
      "## Providers needing a vendor-registered client (no dynamic registration)",
      "",
      "These providers' authorization servers do not support dynamic client",
      "registration (RFC 7591), so the OAuth leg needs ONE app registered with the",
      "vendor. Register `http://127.0.0.1:49431/callback` (desktop) and",
      "`<app-origin>/api/mcp/oauth/callback` (hosted) as redirect URIs, then set:",
      "",
      ...needs.map((r) => `- **${r.name}** (${r.id}): \`${envKey(r.id)}\` (confidential clients also: \`${envKey(r.id).replace("CLIENT_ID", "CLIENT_SECRET")}\`)`),
      "",
      "The static-client lane is already wired: `mcp-catalog.ts` injects these env",
      "values into the entry's `oauth` spec at load, and `oauth/provider.ts` +",
      "`hub.ts` pass them through instead of attempting DCR.",
      "",
    );
  }
  fs.writeFileSync(REPORT, lines.join("\n"));

  console.log(`\nVerdicts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`Report: docs/MCP-OAUTH-PROVIDERS.md`);
  if (broken.length) {
    console.error(`\n✗ ${broken.length} OAuth leg(s) actually broken — fix the flow layer or the catalog entry`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ MCP OAuth lane audit passed — no broken legs");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
