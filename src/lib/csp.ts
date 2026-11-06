// src/lib/csp.ts — the ONE definition of this app's Content-Security-Policy.
//
// Why this is a module instead of a header string: the policy used to exist
// twice — a static list in next.config.js and a second, DIFFERENT string built
// in src/proxy.ts. A response carrying two CSP headers is enforced by browsers
// as their INTERSECTION, so the app silently ran "whichever directive happened
// to be strictest across two files that disagreed", and editing either one had
// no predictable effect. next.config.js no longer sets a policy at all;
// proxy.ts is the only writer, because it is the only layer that knows the API
// origin at request time.
//
// connect-src is deliberately NOT a blanket `https:`. The renderer's complete
// external surface is enumerated here — the split-deployment API host and the
// offline probe — because every provider/BYOK call is made server-side with
// credentials that never reach the browser, where CSP does not apply.
//
// Adding a source here is a security decision, not a convenience: script-src
// and connect-src are the renderer's last line of defence if anything upstream
// (a model answer, a fetched page, an attachment) manages to inject markup.
//
// Edge-safe on purpose — proxy.ts runs on the Edge runtime, so no Node APIs.

export interface CspOptions {
  /** Production build? Selects the unsafe-eval-free, https-only frame variant. */
  isProd: boolean;
  /**
   * Every origin the BROWSER may call directly — in split deployment that is
   * the API host, and there can legitimately be more than one value (see
   * proxy.ts). Duplicates collapse; malformed values are dropped rather than
   * emitted as invalid source expressions.
   */
  apiOrigins?: Array<string | null | undefined>;
}

/**
 * The single external host the renderer connects to: OfflineBanner probes
 * https://www.google.com/generate_204 to detect offline state.
 *
 * (The Google URLs in components/right-panel/preview-tab.tsx are a favicon
 * <img> and an omnibox search link — img-src and navigation respectively, not
 * connect-src. MCP servers are dialled by the server behind the SSRF guard.)
 *
 * Kept as a constant because a test asserts it still matches the URL
 * OfflineBanner actually fetches: moving the probe must move this too.
 */
export const OFFLINE_PROBE_ORIGIN = "https://www.google.com";

const ABSOLUTE_ORIGIN = /^https?:\/\/[^\s;'"]+$/i;

function normalizeOrigins(values: Array<string | null | undefined> | undefined): string[] {
  const out: string[] = [];
  for (const value of values || []) {
    const trimmed = (value || "").trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    // Never emit a malformed source expression: a browser drops the ENTIRE
    // directive on a parse error, so one bad env value would silently block
    // every API call — worse than omitting that origin.
    if (!ABSOLUTE_ORIGIN.test(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Build the policy string. Every directive below is deliberate; the comments
 * record WHY a source is present so nobody has to guess before removing one.
 */
export function buildCsp({ isProd, apiOrigins }: CspOptions): string {
  const origins = normalizeOrigins(apiOrigins);

  const directives = [
    "default-src 'self'",
    // 'unsafe-inline' is required by Next's inline bootstrap script and by
    // Tailwind's inline style attributes. 'unsafe-eval' is a dev-only
    // requirement of the bundler and is never sent in production.
    `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    // data: covers inlined images; blob: covers object-URL previews the
    // renderer creates itself; https: is needed for remote images the chat
    // renders (message attachments, provider-authored markdown, avatars).
    "img-src 'self' data: blob: https:",
    // Fonts are self-hosted (scripts/fetch-fonts.mjs writes both @font-face
    // sets), so no font CDN belongs in this list.
    "font-src 'self' data:",
    // 'self' covers every same-origin call: /api/* when self-hosted, /_next/*,
    // and next-auth's session polling. In SPLIT deployment the browser calls
    // the API host DIRECTLY — api-base.ts prefixes every relative path with the
    // build-time NEXT_PUBLIC_API_BASE_URL and sends credentials — so those
    // origins are listed explicitly. Callers pass both env values because the
    // runtime base (ORPLEX_API_URL) and the baked-in one can differ, and naming
    // only one would block every request in the deployments where they do.
    //
    // No wss: in production — the renderer opens no socket of its own. (A
    // same-origin https source already permits the wss upgrade, and streaming
    // runs over same-origin fetch.) Development needs the HMR socket, which is
    // explicit here rather than relying on that upgrade rule.
    `connect-src 'self'${origins.map((o) => ` ${o}`).join("")} ${OFFLINE_PROBE_ORIGIN}${
      isProd ? "" : " ws://localhost:* ws://127.0.0.1:*"
    }`,
    // Artifact/preview frames: SandboxArtifact frames a live app server —
    // loopback in dev/local preview, an https preview host in production.
    isProd
      ? "frame-src 'self' https:"
      : "frame-src 'self' https: http://localhost:* http://127.0.0.1:*",
    // The app is never meant to be framed by anyone, and injected markup must
    // not be able to navigate or submit out of this origin.
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  return directives.join("; ");
}
