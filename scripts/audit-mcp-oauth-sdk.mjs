// audit-mcp-oauth-sdk.mjs — Phase 6.6: SDK-level OAuth audit.
//
// The Phase 6.5 audit (audit-mcp-oauth.mjs) re-implements the OAuth legs by
// hand. This one drives the REAL SDK path the app uses —
// @modelcontextprotocol/client's auth() with an in-memory provider that
// mirrors DbMcpOAuthProvider exactly (same client_name, same redirect_uris,
// same scopes, same pinned authority, same DCR/no-DCR behaviour). It proves
// that "click Connect → browser opens → Allow → connected" works with the
// code that actually ships, not with a re-implementation.
//
// Verdicts:
//   oauth_ok       the SDK produced a browser authorization URL (REDIRECT)
//   needs_client   the SDK asked for a client we don't have (no open DCR /
//                  registration rejected) — the Connectors panel collects the
//                  user's own client id and retries (no app-side error)
//   oauth_broken   the SDK failed for a reason a client id cannot fix
//
// Usage: node scripts/audit-mcp-oauth-sdk.mjs [--only=id,id]

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "node_modules", ".cache", "orplex-mcp-oauth-sdk-audit");
const REDIRECT = "http://127.0.0.1:49431/callback";
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim())) : null;

function compileCatalog() {
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.mkdirSync(CACHE, { recursive: true });
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
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  const req = createRequire(import.meta.url);
  const mod = req(path.join(CACHE, "mcp-catalog.js"));
  if (!Array.isArray(mod.MCP_CATALOG)) throw new Error("compiled catalog missing MCP_CATALOG");
  return mod;
}

/** In-memory provider mirroring DbMcpOAuthProvider (provider.ts). */
function makeProvider(entry) {
  const oauth = entry.oauth ?? {};
  const state = { clientInfo: undefined, discovery: undefined, authUrl: null };
  // CIMD: when the AS advertises client_id_metadata_document_supported, the
  // SDK uses clientMetadataUrl as the client_id and skips registration.
  const clientMetadataUrl = oauth.cimd ? "https://orplex.app/api/mcp/oauth/client-metadata" : undefined;
  return {
    state,
    provider: {
      get clientMetadata() {
        const md = {
          client_name: `Orplex · ${entry.name}`,
          redirect_uris: [REDIRECT],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
        if (oauth.scopes?.length) md.scope = oauth.scopes.join(" ");
        return md;
      },
      state: () => "sdk-audit-state",
      redirectUrl: REDIRECT,
      clientMetadataUrl,
      clientInformation: async () => {
        if (state.clientInfo) return state.clientInfo;
        if (oauth.clientId) {
          const info = { client_id: oauth.clientId };
          if (oauth.clientSecret) info.client_secret = oauth.clientSecret;
          return info;
        }
        return undefined; // → SDK dynamic registration
      },
      saveClientInformation: async (info) => {
        state.clientInfo = info;
      },
      tokens: async () => undefined,
      saveTokens: async () => {},
      saveCodeVerifier: async () => {},
      codeVerifier: async () => "audit-verifier",
      saveDiscoveryState: async (d) => {
        state.discovery = d;
      },
      discoveryState: async () => state.discovery ?? (oauth.authority ? { authorizationServerUrl: oauth.authority } : undefined),
      redirectToAuthorization: async (url) => {
        state.authUrl = url.toString();
      },
    },
  };
}

async function main() {
  const { MCP_CATALOG } = compileCatalog();
  const { auth } = await import("@modelcontextprotocol/client");

  const candidates = [];
  for (const e of MCP_CATALOG) {
    if (!e.remote) continue;
    if (ONLY && !ONLY.has(e.id)) continue;
    candidates.push(e);
  }

  console.log(`MCP OAuth SDK audit — ${candidates.length} remote connectors (real @modelcontextprotocol/client auth())\n`);
  const rows = [];
  for (const entry of candidates) {
    const { provider, state } = makeProvider(entry);
    let verdict = "oauth_broken";
    let detail = "";
    try {
      const result = await auth(provider, {
        serverUrl: entry.remote.url,
        ...(entry.oauth?.scopes?.length ? { scope: entry.oauth.scopes.join(" ") } : {}),
        // Mirror flow.ts makeTransport: the transports skip issuer validation
        // ONLY for catalog-pinned authorities (Entra publishes a {tenantid}
        // placeholder issuer).
        ...(entry.oauth?.authority ? { skipIssuerMetadataValidation: true } : {}),
      });
      if (result === "AUTHORIZED") {
        verdict = "connected";
        detail = "SDK authorized without a browser leg";
      } else if (state.authUrl) {
        verdict = "oauth_ok";
        const u = new URL(state.authUrl);
        detail = `browser URL ready → ${u.origin}${u.pathname}`;
      } else {
        verdict = "oauth_broken";
        detail = `SDK returned ${result} with no authorization URL`;
      }
    } catch (e) {
      const name = e?.name ?? "Error";
      const msg = e?.message ?? String(e);
      if (/registration/i.test(name) || /register|client_id/i.test(msg) && /403|forbidden|invalid_client/i.test(msg)) {
        verdict = "needs_client";
        detail = `registration unavailable (${name}: ${msg.slice(0, 90)})`;
      } else if (/no .*registration|does not support (dynamic )?client registration|not supported|unsupported/i.test(msg)) {
        verdict = "needs_client";
        detail = msg.slice(0, 120);
      } else {
        verdict = "oauth_broken";
        detail = `${name}: ${msg.slice(0, 120)}`;
      }
    }
    rows.push({ id: entry.id, name: entry.name, verdict, detail, url: entry.remote.url });
    const icon = verdict === "oauth_ok" || verdict === "connected" ? "%" : verdict === "needs_client" ? "~" : "✗";
    console.log(`  ${icon} ${entry.id.padEnd(14)} ${verdict.padEnd(13)} ${detail}`);
  }

  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  console.log(`\nVerdicts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  const broken = rows.filter((r) => r.verdict === "oauth_broken");
  if (broken.length) {
    console.error(`\n✗ ${broken.length} SDK OAuth leg(s) broken: ${broken.map((r) => r.id).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("✓ SDK OAuth audit passed — every leg either opens a browser URL or asks for a user-owned client id");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
