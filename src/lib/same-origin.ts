// src/lib/same-origin.ts — same-origin enforcement for mutations this app
// answers ITSELF.
//
// The cloud backend has its own CSRF middleware for the routes it owns. Two
// groups of routes never reach it:
//   1. the LOCAL_ONLY routes in src/proxy.ts (attachments, files, playbook,
//      conversations, plugins, workspace-cwd, system memory) — served by this
//      process on purpose, in EVERY deployment mode;
//   2. every /api/* route when no backend origin is configured (self-hosted,
//      Docker, split-API not set, `next dev`) — the proxy answers them itself.
// Before this module those two groups had no origin check at all: the proxy's
// own comment said "the BACKEND owns CORS + CSRF", which is only true for the
// routes that actually get forwarded.
//
// What it defends against: another site issuing a state-changing request that
// rides the user's ambient cookies. Today the session cookies are
// SameSite=Lax (src/lib/auth.ts, and the desktop exchange route), which already
// withholds them from cross-site POSTs — but AUTH_COOKIE_SAMESITE=none is a
// supported split-deployment setting that removes exactly that protection, and
// an origin check is the mitigation that survives it.
//
// Policy:
//   • GET/HEAD/OPTIONS are never blocked — they carry no ambient-authority
//     mutation.
//   • Origin wins; Referer is the fallback when Origin is absent.
//   • No Origin AND no Referer is allowed. A browser cannot issue a cross-site
//     form submit or fetch without at least one of them, so the remaining
//     callers are non-browser lanes (Electron main process, the stdio MCP
//     proxy, cron with a bearer token, curl, tests) that never carried a CSRF
//     token either. Denying them would break those lanes and buy nothing.
//   • `Origin: null` is refused — that is a sandboxed third-party frame, which
//     has no legitimate path into these routes.
//   • Loopback hosts are equal when the PORT matches: the desktop UI is served
//     on 127.0.0.1 while in-app links may legitimately use localhost (and
//     Windows resolves those to different addresses).
//
// Edge-safe on purpose — proxy.ts runs on the Edge runtime, so no Node APIs.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for methods that can change state (and therefore need the check). */
export function isStateChangingMethod(method: string | null | undefined): boolean {
  return !SAFE_METHODS.has((method || "GET").toUpperCase());
}

// localhost, 127.0.0.1, 0.0.0.0, [::1] — with or without an explicit port.
const LOOPBACK_HOST = /^(\[[0-9a-f:.]+\]|localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/;

/**
 * Canonical form of a Host value so equivalent spellings compare equal.
 * Loopback aliases collapse to one token that KEEPS the port, so a different
 * port never matches.
 */
export function canonicalHost(host: string): string {
  const lower = (host || "").trim().toLowerCase();
  if (!lower) return "";
  const loopback = LOOPBACK_HOST.exec(lower);
  if (loopback) return `loopback${loopback[2] || ""}`;
  return lower;
}

interface MinimalRequest {
  method?: string;
  url?: string;
  headers: { get(name: string): string | null };
}

/** Every host this request could legitimately have originated from. */
function ownHosts(request: MinimalRequest): Set<string> {
  const hosts = new Set<string>();
  const add = (raw: string | null) => {
    if (!raw) return;
    // x-forwarded-host / host can be a comma-separated chain; the first entry
    // is the client-facing one.
    const canonical = canonicalHost(raw.split(",")[0] || "");
    if (canonical) hosts.add(canonical);
  };

  try {
    add(new URL(request.url || "").host);
  } catch {
    // A request with no parseable URL falls back to the headers below.
  }
  add(request.headers.get("host"));
  add(request.headers.get("x-forwarded-host"));

  return hosts;
}

/**
 * Is this request allowed to mutate state?
 *
 * Returns true for safe methods, for callers that sent no Origin/Referer at
 * all, and for Origin/Referer values that match one of the request's own
 * hosts. Everything else — a foreign origin, an unparseable origin, or
 * `null` from a sandboxed frame — is refused.
 */
export function isSameOriginRequest(request: MinimalRequest): boolean {
  if (!isStateChangingMethod(request.method)) return true;

  const origin = request.headers.get("origin");
  if (origin === "null") return false;

  const referer = request.headers.get("referer");
  const candidate = origin || referer;
  // Non-browser caller: nothing to compare against, and no browser could have
  // reached this point cross-site without one of the two headers.
  if (!candidate) return true;

  let sourceHost: string;
  try {
    sourceHost = canonicalHost(new URL(candidate).host);
  } catch {
    return false;
  }
  if (!sourceHost) return false;

  return ownHosts(request).has(sourceHost);
}
