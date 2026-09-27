/**
 * proxy-guard.ts — SSRF defenses for the embedded-browser proxy.
 *
 * The proxy fetches attacker-influenceable URLs server-side, so every target
 * (and every redirect hop) must pass:
 *  1. scheme allowlist (http/https only)
 *  2. hostname shape check — must be a real domain or dotted-quad IPv4
 *     (blocks decimal/hex IPv4 tricks like `2130706433` / `0x7f.1` whose
 *     DNS-level checks wouldn't parse the way fetch() would)
 *  3. string-level private-host block (fast path)
 *  4. DNS resolution — every resolved A/AAAA address must be public
 *     (kills `localtest.me` → 127.0.0.1 and friends; residual risk: a
 *     rebinding DNS name that flips between validation and fetch)
 */

import { isProxiableUrl } from "./browser-proxy";

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

export type DnsLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** Patterns that must never be fetched, checked against the literal hostname. */
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.home$/i,
  /\.lan$/i,
  /\.internal$/i,
  /\.arpa$/i, // reverse-DNS style names
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^::1$/,
  /^f[cd]/i, // IPv6 unique-local fc00::/7
  /^fe[89ab]/i, // IPv6 link-local fe80::/10
];

/** Is `ip` (v4 or v6, brackets stripped, lowercase) a private/non-public address? */
export function isNonPublicIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4-mapped IPv6 (::ffff:10.0.0.1)
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isNonPublicIp(mapped[1]);
  if (v.includes(":")) {
    if (v === "::1" || v === "::") return true; // loopback / unspecified
    if (/^f[cd]/.test(v)) return true; // unique-local
    if (/^fe[89ab]/.test(v)) return true; // link-local
    return false;
  }
  const o = v.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // unparseable → treat as bad
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || b === 0)) return true; // 192.168/16, 192.0.0/24, 192.0.2/24 (TEST-NET)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Scheme + hostname-shape + string-level checks (no DNS). */
export function staticUrlGuard(rawUrl: string): GuardResult {
  if (!isProxiableUrl(rawUrl)) return { ok: false, reason: "scheme not allowed" };
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: "unparseable URL" };
  }
  // Only real domains or dotted-quad IPv4 — kills decimal/hex IPv4 aliases.
  const isDottedQuad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host);
  const isDomain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(host);
  if (!isDottedQuad && !isDomain) return { ok: false, reason: `hostname not a public web target: ${host}` };
  if (isDottedQuad && isNonPublicIp(host)) return { ok: false, reason: `private address blocked: ${host}` };
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) return { ok: false, reason: `blocked host: ${host}` };
  return { ok: true };
}

/**
 * Full guard incl. DNS: resolves every address and requires all of them to
 * be public. `lookup` is injectable for tests.
 */
export async function resolveTargetGuard(
  rawUrl: string,
  lookup: DnsLookup,
): Promise<GuardResult> {
  const stat = staticUrlGuard(rawUrl);
  if (!stat.ok) return stat;
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: "unparseable URL" };
  }
  // Literal IPs skip DNS; domains must resolve to only-public addresses.
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    let records: { address: string; family: number }[];
    try {
      records = await lookup(host);
    } catch {
      return { ok: false, reason: `DNS resolution failed for ${host}` };
    }
    if (!records || records.length === 0) return { ok: false, reason: `no DNS records for ${host}` };
    for (const r of records) {
      if (isNonPublicIp(r.address)) {
        return { ok: false, reason: `${host} resolves to a non-public address (${r.address})` };
      }
    }
  }
  return { ok: true };
}

/** Absolute redirect target from a Location header, or null when absent/invalid. */
export function nextRedirectUrl(fromUrl: string, location: string | null): string | null {
  if (!location) return null;
  try {
    return new URL(location, fromUrl).toString();
  } catch {
    return null;
  }
}

const PASSTHROUGH_SAFE_HEADERS = ["content-type", "content-length"] as const;

/**
 * Build the response headers for a proxied resource. Only a strict allowlist
 * passes through — critically this drops upstream `Set-Cookie` (cookie
 * tossing onto the app origin), `Content-Security-Policy` /
 * `X-Frame-Options` (the page must render in-frame), and anything else that
 * could re-expose upstream auth state.
 */
export function buildPassthroughHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const name of PASSTHROUGH_SAFE_HEADERS) {
    const v = upstream.get(name);
    if (v) out.set(name, v);
  }
  return out;
}
