// backend-client.ts — server-side calls from the desktop app to the cloud API.
//
// Some data only exists on the backend: provider OAuth tokens (GitHub) are
// issued during the OAuth round-trip there and never shipped to the client. The
// app still needs to answer questions that require them ("which repositories can
// I clone?"), so those routes forward the request.
//
// Auth: the backend issued this app an Ed25519-signed `orplex-app-session`
// cookie and verifies it with appSessionUserFromRequest(). We forward that ONE
// cookie — never the local next-auth cookie, never the whole Cookie header — so
// a compromised backend cannot replay the desktop's local session.
//
// Every function here is a no-op-safe reader: an unconfigured or unreachable
// backend returns null and the caller falls back to local behaviour.

const DEFAULT_BACKEND = "https://orplex-backend.vercel.app";
export const APP_SESSION_COOKIE = "orplex-app-session";

/** Base URL of the cloud API, or null when this build has none configured. */
export function backendBaseUrl(): string | null {
  const raw = (
    process.env.ORPLEX_BACKEND_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    DEFAULT_BACKEND
  ).trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The app-session cookie value from an inbound request, if present. */
export function appSessionFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === APP_SESSION_COOKIE) {
      const value = rest.join("=").trim();
      return value || null;
    }
  }
  return null;
}

export interface BackendJsonResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

/**
 * Call the backend with this app's session cookie.
 *
 * Returns null (not throws) when the backend is unconfigured, the cookie is
 * missing, or the network fails — callers degrade to local data instead of
 * turning a missing cloud into a broken feature.
 */
export async function backendJson<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; cookieHeader?: string | null; timeoutMs?: number } = {}
): Promise<BackendJsonResult<T> | null> {
  const base = backendBaseUrl();
  const session = appSessionFromCookieHeader(init.cookieHeader);
  if (!base || !session || !path.startsWith("/")) return null;

  const headers: Record<string, string> = {
    cookie: `${APP_SESSION_COOKIE}=${session}`,
    accept: "application/json",
  };
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (payload !== undefined) headers["content-type"] = "application/json";

  try {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: payload,
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
    const data = (await res.json().catch(() => null)) as T | null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return null;
  }
}
