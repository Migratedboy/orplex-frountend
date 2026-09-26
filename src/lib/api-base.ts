// api-base.ts — THE seam for split deployment: browser frontend anywhere,
// API server anywhere.
//
// Default (env unset): every path stays same-origin — byte-identical to the
// historical behavior, so desktop/local installs are untouched.
// Split mode: set NEXT_PUBLIC_API_BASE_URL at FRONTEND BUILD time (e.g.
// "https://api.example.com") and every client call goes to the server origin
// with credentials so the NextAuth session cookie flows (server must
// allowlist the frontend origin in ALLOWED_ORIGINS — see middleware.ts).
//
// Browser-only by design: server-internal callers (executor, route-to-route)
// must keep relative paths — they run where the API lives.

export const API_BASE: string = (() => {
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL || "";
  return raw.trim().replace(/\/+$/, "");
})();

/** True when the frontend talks to a DIFFERENT origin than its own. */
export function isSplitDeployment(): boolean {
  if (typeof window === "undefined") return false;
  return API_BASE !== "" && API_BASE !== window.location.origin;
}

/** Prefix a relative API path with the configured base (no-op same-origin). */
export function withApiBase(path: string): string {
  if (!path.startsWith("/")) return path; // already absolute or non-API
  return `${API_BASE}${path}`;
}

export interface ApiFetchInit extends RequestInit {
  /** Response is always parsed as JSON when the server answers JSON. */
}

/**
 * fetch + the pieces cross-origin authenticated calls need:
 *  - credentials: "include" so the session cookie rides along;
 *  - X-Requested-With: satisfies the middleware CSRF rule together with the
 *    JSON content-type;
 *  - relative paths rewritten through withApiBase.
 * Same-origin behavior is unchanged (credentials are the default there).
 */
export async function apiFetch(path: string, init: ApiFetchInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("X-Requested-With")) headers.set("X-Requested-With", "fetch");
  return fetch(withApiBase(path), {
    ...init,
    headers,
    credentials: init.credentials ?? "include",
  });
}

/**
 * apiFetch + JSON parsing + { ok, data, error } envelope. Non-2xx responses
 * resolve (not throw) with the server's error message when available.
 */
export async function apiJson<T = unknown>(
  path: string,
  init: ApiFetchInit = {}
): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  try {
    const res = await apiFetch(path, init);
    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    const data = isJson ? await res.json().catch(() => null) : null;
    if (res.ok) return { ok: true, status: res.status, data: data as T, error: null };
    const message =
      (data as { error?: { message?: string } | string } | null)?.error &&
      typeof (data as { error: { message?: string } | string }).error === "object"
        ? ((data as { error: { message?: string } }).error.message ?? null)
        : ((data as { error?: string } | null)?.error as string) ?? `HTTP ${res.status}`;
    return { ok: false, status: res.status, data: data as T, error: message };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : "Network error" };
  }
}
