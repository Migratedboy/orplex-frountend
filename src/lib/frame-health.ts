/**
 * frame-health.ts — failure detection for the embedded browser's iframe.
 *
 * Chromium does NOT fire a usable `onerror` for a frame that fails to load
 * (DNS failure, connection refused, blocked embed): the iframe fires onLoad
 * with an unreadable/empty document instead. Browser-side probes can't help
 * either — CORS makes every external response opaque (a healthy 200 and a
 * refusal are indistinguishable). So reachability is probed THROUGH the app
 * origin:
 *   - internal app routes  → same-origin HEAD (status readable)
 *   - localhost dev ports  → /api/localhost-probe (TCP check)
 *   - other external URLs  → /api/probe-url (server-side HEAD, SSRF-guarded)
 */

export type FrameFailureKind = "offline" | "unreachable" | "blocked" | "unknown";

export interface FrameFailure {
  kind: FrameFailureKind;
  /** Headline shown in the viewport overlay. */
  title: string;
  /** One-sentence explanation. */
  hint: string;
}

/** Probe timeout — short, because a reachable page usually answers in ms. */
export const FRAME_PROBE_TIMEOUT_MS = 4_000;

export type FrameProbe =
  | { kind: "internal"; url: string }
  | { kind: "localhost"; port: number; url: string }
  | { kind: "external"; url: string };

/** Classify the current iframe URL into a probe plan (or null = nothing to probe). */
export function frameProbeTarget(url: string): FrameProbe | null {
  if (!url) return null;
  if (url.startsWith("/")) {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return { kind: "internal", url: `${origin}${url}` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (isLocal) {
    const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
    return { kind: "localhost", port, url: parsed.toString() };
  }
  return { kind: "external", url: parsed.toString() };
}

/** Map a probe failure to a user-facing classification. */
export function classifyFrameFailure(
  probeKind: FrameProbe["kind"],
  detail?: string
): FrameFailure {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (offline) {
    return { kind: "offline", title: "You're offline", hint: "Reconnect to the internet and retry." };
  }
  if (probeKind === "internal") {
    return {
      kind: "unreachable",
      title: "This app page failed to load",
      hint: detail
        ? `The app server answered with an error (${detail}). Retry in a moment.`
        : "The app server is unreachable or restarting. Retry in a moment.",
    };
  }
  if (probeKind === "localhost") {
    return {
      kind: "unreachable",
      title: "This site can't be reached",
      hint: "Nothing is listening on this port of your machine — is your dev server running?",
    };
  }
  return {
    kind: "unreachable",
    title: "This site can't be reached",
    hint: "The server refused the connection — it may be down, or the address may be wrong.",
  };
}
