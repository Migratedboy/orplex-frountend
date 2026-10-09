// ssrf-guard.ts — Shared gate for server-fetched URLs (preview, screenshot,
// browser lanes). Returns an error string when the URL must not be fetched,
// null when it passes.
//
// Blocks: non-http(s) schemes (file://, ftp://, …), literal private/loopback/
// link-local/metadata hosts. NOTE: a hostile domain resolving to a private
// IP (DNS rebinding) is out of scope — callers needing that must resolve +
// re-check (DNS-pinning) before fetching.

/** Max URL length accepted by the gate. */
export const MAX_URL_CHARS = 2000;

export function urlError(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_URL_CHARS) return "URL is required";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Invalid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Only http(s) URLs allowed";
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\.0\.0\.0$/.test(host)
  ) {
    return "Private/local URLs are not allowed";
  }
  return null;
}
