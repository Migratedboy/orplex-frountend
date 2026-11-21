// signin-mediator.ts — how a button starts an OAuth sign-in in this app.
//
// NextAuth v4 refuses to start a provider sign-in over GET ("This action with
// HTTP GET is not supported by NextAuth.js"), and the app's CSP blocks the POST
// form that would normally do it. The working path is the mediator site's
// desktop-grant flow: the OAuth round-trip (state cookies, provider redirect
// URIs) lives on the site origin, and the callback redirects back here with
// ?grant= for the app to redeem.
//
// The return target must be /auth/signin and nothing else. That page is the only
// place that calls /api/auth/desktop/exchange — returning to "/" (or to the
// project picker) drops the grant on a page that never redeems it, the session
// cookie is never written, and the user is bounced straight back to
// /auth/signin?callbackUrl=%2F. That was a real bug: the "Connect GitHub"
// buttons returned to the caller's path.
//
// This is an OAuth App flow on purpose: we only need a token that can read the
// user's repositories (scope `repo`). A GitHub App would replace that with
// installation tokens and a different callback contract, which is a different
// feature, not a fix for the 405.

const DEFAULT_SITE = "https://orplex-code.vercel.app";

export function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE).replace(/\/+$/, "");
}

/** Where the mediator sends the browser back to: the grant-redeeming page. */
export function signInCallbackPath(): string {
  return "/auth/signin";
}

/**
 * Navigate to the mediator's desktop sign-in start.
 *
 * `returnPath` is where the user should end up INSIDE the app after the
 * callback; it travels as ?next= because the immediate return target has to be
 * the grant-redeeming page.
 */
export function startMediatorSignIn(provider: "github" | "google", returnPath = "/"): void {
  if (typeof window === "undefined") return;
  window.location.href = mediatorSignInUrl(provider, window.location.origin, returnPath);
}

/** The exact URL handed to the browser — pure, so it can be asserted in tests. */
export function mediatorSignInUrl(
  provider: "github" | "google",
  appOrigin: string,
  returnPath = "/",
  site: string = siteOrigin()
): string {
  const callback = `${signInCallbackPath()}${returnPath && returnPath !== "/" ? `?next=${encodeURIComponent(returnPath)}` : ""}`;
  const returnTo = encodeURIComponent(`${appOrigin}${callback}`);
  return `${site}/api/auth/desktop/start?provider=${provider}&return_to=${returnTo}`;
}

/**
 * Post-sign-in destination from `?next=`, or `fallback` when it is absent or
 * unsafe. Only same-origin absolute paths are honoured, so a crafted
 * `?next=//evil.example` cannot turn the sign-in page into an open redirect.
 */
export function safeNextPath(search: string, fallback = "/"): string {
  try {
    const raw = new URLSearchParams(search).get("next") || "";
    if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) return raw;
  } catch {
    /* fall through */
  }
  return fallback;
}
