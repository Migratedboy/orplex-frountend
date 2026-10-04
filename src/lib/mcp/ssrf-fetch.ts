// ssrf-fetch.ts — SSRF guard for every HTTP request the MCP stack makes
// (spec Phase 4, conflict C7). The official transports accept a custom
// fetch, and they use it for the MCP POSTs/SSE streams AND the OAuth
// discovery/DCR/token-exchange requests they drive themselves — so handing
// them this one function covers the whole SDK network surface.
//
// Policy (an MCP edition of browser-verification's checkUrlPolicy):
//   • http/https only — file:, ftp:, data:, gopher: … rejected outright
//   • loopback (localhost / 127.0.0.0/8 / [::1]) allowed over http AND
//     https: local dev MCP servers are a first-class use case
//   • private, link-local, CGNAT and cloud-metadata hosts blocked
//     (RFC1918, 169.254/16 incl. 169.254.169.254, 100.64/10, ULA)
//   • public hosts must be https — plain http to the internet would leak
//     bearer tokens in cleartext
//
// Known limitation (documented, accepted): the check runs per request, and
// fetch follows redirects internally — redirect HOPS are not re-checked.
// That is safe here because the transports default to same-origin redirects
// (a hop cannot change origin, let alone downgrade https → http), and the
// catalog only ever admits https or loopback URLs.

import type { FetchLike } from "@modelcontextprotocol/client";

/** Private/link-local host shapes, tested against the bracket-stripped hostname. */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^169\.254\./, // link-local + cloud metadata (169.254.169.254)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
  /^192\.168\./, // RFC1918
  /^10\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^::1$/, // IPv6 loopback (bracket-stripped)
  /^f[cd]/i, // IPv6 unique-local
];

/** 127.0.0.0/8 in any dotted form plus localhost and [::1]. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
}

export interface McpUrlVerdict {
  allowed: boolean;
  reason?: string;
}

/** Pure policy check — used by ssrfFetch and directly in tests. */
export function checkMcpUrl(rawUrl: string): McpUrlVerdict {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "unparseable URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { allowed: false, reason: `scheme not allowed: ${u.protocol}` };
  }
  // URL.hostname keeps IPv6 literals bracketed — strip for matching.
  const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) return { allowed: false, reason: "no host" };
  if (isLoopbackHost(host)) return { allowed: true };
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    return { allowed: false, reason: `private/link-local host blocked: ${host}` };
  }
  if (u.protocol === "http:") {
    return { allowed: false, reason: `plain http to public host — https required (${host})` };
  }
  return { allowed: true };
}

/** Thrown (never returned) so SDK transports surface the block as a request failure. */
export class McpSsrfError extends Error {
  readonly code = "mcp_ssrf_blocked";
  constructor(
    readonly url: string,
    readonly reason: string
  ) {
    super(`Blocked by MCP SSRF policy: ${reason} — ${url}`);
    this.name = "McpSsrfError";
  }
}

export type SsrfFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url ?? String(input);
}

/**
 * Wrap a fetch implementation with the policy. `base` defaults to the
 * global fetch — tests inject their own to observe blocked/passing calls.
 */
export function createSsrfFetch(
  base?: (input: string | URL, init?: RequestInit) => Promise<Response>
): SsrfFetch {
  const fetchImpl = base ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
  return async (input, init) => {
    const url = requestUrl(input);
    const verdict = checkMcpUrl(url);
    if (!verdict.allowed) throw new McpSsrfError(url, verdict.reason ?? "blocked");
    if (!fetchImpl) throw new McpSsrfError(url, "no fetch implementation available");
    return fetchImpl(input as string | URL, init);
  };
}

/** The guard every MCP transport gets as its `fetch` (C7). */
export const ssrfFetch: SsrfFetch = createSsrfFetch();
