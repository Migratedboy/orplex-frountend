import { NextResponse } from "next/server";
import { mintDesktopCode, DESKTOP_FLOW_COOKIE } from "@/lib/desktop-auth";
import { checkRateLimit, clientIp } from "@/lib/rate-limiter";

export const dynamic = "force-dynamic";

function page(body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Orplex Code — sign in</title>` +
      `<body style="font-family:system-ui;background:#141414;color:#eee;display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="text-align:center;max-width:420px">${body}</div></body>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

const PROVIDER_HOSTS: Record<string, string[]> = {
  google: ["accounts.google.com"],
  github: ["github.com"],
};

/**
 * The provider redirect must point at the provider we asked for — never leak
 * the OAuth handshake to an unexpected host.
 */
function isProviderRedirect(location: string, provider: string): boolean {
  try {
    const url = new URL(location);
    return PROVIDER_HOSTS[provider]?.includes(url.hostname) ?? false;
  } catch {
    return false;
  }
}

/** Strip a Domain attribute so the cookie lands host-only on this origin. */
function hostOnly(setCookie: string): string {
  return setCookie.replace(/;\s*domain=[^;]*/gi, "");
}

export async function GET(request: Request) {
  const rl = checkRateLimit(`desktop-start:${clientIp(request)}`);
  if (!rl.allowed) {
    return page(`<h2 style="color:#ff6b00">Too many sign-in attempts</h2><p style="color:#9aa">Wait a minute and try again.</p>`);
  }
  const provider = (new URL(request.url).searchParams.get("provider") || "google").toLowerCase();
  if (provider !== "google" && provider !== "github") {
    return page(`<h2 style="color:#ff6b00">Unsupported provider</h2><p style="color:#9aa">Use google or github.</p>`);
  }
  const configured =
    provider === "google"
      ? !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
      : !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  if (!configured) {
    return page(
      `<h2 style="color:#ff6b00">${provider} sign-in is not configured</h2><p style="color:#9aa">Set the ${provider.toUpperCase()}_CLIENT_ID / _CLIENT_SECRET env vars on the backend.</p>`
    );
  }

  // One-time code: the finish route verifies it after the OAuth round-trip
  // and hands the app an encrypted grant instead.
  // The flow cookie binds the code to THIS browser (login-CSRF defense) —
  // HttpOnly so page JS (and any XSS) cannot read it; SameSite=Lax so it
  // rides the OAuth callback navigation back.
  const { code, flowToken } = mintDesktopCode(provider);
  const origin = new URL(request.url).origin;
  const callbackUrl = `${origin}/api/auth/desktop/finish?code=${encodeURIComponent(code)}`;

  // NextAuth v4 only starts a provider sign-in over POST with a CSRF token.
  // The browser-side form that used to do this is blocked by our own CSP
  // (`form-action 'self'`), which left the browser parked on "Taking you to
  // …" forever. So the CSRF handshake runs HERE, server-side: fetch the
  // token, POST the sign-in, then forward the provider redirect (and every
  // cookie NextAuth minted — state, PKCE verifier, nonce, callback url) to
  // the browser. The browser then navigates straight to the provider.
  let csrfToken: string | undefined;
  let csrfCookies: string[] = [];
  // The browser may already hold a csrf-token cookie (left by an earlier
  // sign-in attempt). NextAuth then REUSES that token and answers WITHOUT a
  // Set-Cookie — so the internal POST below would carry no CSRF cookie and
  // fail verification ("Sign-in could not start" on every attempt AFTER the
  // first). Strip it: the handshake must always mint a fresh token here.
  const browserCookies = (request.headers.get("cookie") || "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !/csrf-token/i.test(c))
    .join("; ");
  try {
    const csrfRes = await fetch(`${origin}/api/auth/csrf`, {
      headers: browserCookies ? { cookie: browserCookies } : {},
      cache: "no-store",
    });
    if (csrfRes.ok) {
      const body = (await csrfRes.json()) as { csrfToken?: string };
      csrfToken = body.csrfToken;
      csrfCookies = csrfRes.headers.getSetCookie();
    }
    if (csrfToken && csrfCookies.length === 0) {
      // Still no cookie (NextAuth reused a token): ask again with a clean
      // slate so a fresh token + cookie pair comes back.
      const retry = await fetch(`${origin}/api/auth/csrf`, { cache: "no-store" });
      if (retry.ok) {
        const body = (await retry.json()) as { csrfToken?: string };
        csrfToken = body.csrfToken;
        csrfCookies = retry.headers.getSetCookie();
      }
    }
  } catch {
    csrfToken = undefined;
  }
  if (!csrfToken) {
    return page(
      `<h2 style="color:#ff6b00">Sign-in could not start</h2><p style="color:#9aa">Return to the app and try again.</p>`
    );
  }

  let location: string | null = null;
  let signinCookies: string[] = [];
  try {
    const signinRes = await fetch(`${origin}/api/auth/signin/${provider}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: csrfCookies.map((c) => c.split(";")[0]).join("; "),
      },
      body: new URLSearchParams({ csrfToken, callbackUrl }).toString(),
      redirect: "manual",
      cache: "no-store",
    });
    location = signinRes.headers.get("location");
    signinCookies = signinRes.headers.getSetCookie();
  } catch {
    location = null;
  }
  if (!location || !isProviderRedirect(location, provider)) {
    return page(
      `<h2 style="color:#ff6b00">Sign-in could not start</h2><p style="color:#9aa">Return to the app and try again.</p>`
    );
  }

  const res = NextResponse.redirect(location, 302);
  for (const cookie of [...csrfCookies, ...signinCookies]) {
    res.headers.append("set-cookie", hostOnly(cookie));
  }
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.headers.append(
    "set-cookie",
    `${DESKTOP_FLOW_COOKIE}=${flowToken}; Path=/api/auth/desktop; HttpOnly; SameSite=Lax; Max-Age=600${secure}`
  );
  return res;
}
