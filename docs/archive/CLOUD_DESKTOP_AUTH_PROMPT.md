# Prompt for the cloud manager AI — Desktop (Electron) sign-in support

Copy everything below into the cloud AI on Freebuff.

---

## Task

Add desktop-app (Electron) sign-in support to the Orplex backend at
`https://orplextech.freebuff.app`. The desktop app's UI runs on its own origin
(`http://localhost:5000` behind the app's proxy), so a provider OAuth callback
can never set a session cookie on the app's origin. The fix is the standard
deep-link handoff: OAuth completes on the backend domain (Google/GitHub
redirect URIs stay EXACTLY as they are — do not touch them), the backend mints
a single-use code, redirects the browser to the app's custom protocol
`orplex://auth?code=...`, and the app exchanges that code for a session cookie
on its own origin via a same-origin proxied call.

The frontend/Electron side is already implemented and expects this exact
contract:

1. Browser opens `GET /api/auth/desktop/start?provider=google|github`.
2. After OAuth succeeds, the backend navigates the browser to
   `orplex://auth?code=<one-time-code>` (or `orplex://auth?error=<reason>` on
   failure).
3. The app POSTs `{ "code": "<one-time-code>" }` as JSON to
   `/api/auth/desktop/exchange` **through its own origin proxy** (so the
   `Set-Cookie` response lands first-party on the app's origin). Success =
   `200 {"ok":true,"user":{...}}` **with a valid next-auth session cookie**;
   failure = `4xx {"error":"..."}`.

## Context you need

- NextAuth v4, **JWT session strategy**, `NEXTAUTH_SECRET` signs the session
  token. Existing helpers in `src/lib/auth.ts`: `authOptions` (providers +
  Prisma adapter, for the `[...nextauth]` route) and `jwtOnlyOptions`
  (lightweight, no Prisma — use this for `getServerSession()` in new routes).
- `src/app/api/dev/session/route.ts` already contains the exact token-minting
  pattern to copy: `encode()` from `next-auth/jwt` with
  `{ sub, id, name, email, picture, image }` and `maxAge: 30*24*60*60`, set via
  `response.cookies.set(...)`.
- Cookie names: production NextAuth (https `NEXTAUTH_URL`) reads
  `__Secure-next-auth.session-token`; the app's own Edge proxy check reads the
  plain `next-auth.session-token`. **Set BOTH cookies with the same token** in
  the exchange response — Chromium allows `Secure` cookies on `localhost`.
- Do NOT add `domain=` to these cookies (the app's origin is localhost; a
  `.freebuff.app` domain would be rejected). Do not set `AUTH_COOKIE_DOMAIN`
  for this flow.
- Single-use code store: a module-level `Map` with 10-minute TTL is fine for
  the current single-instance deployment. If the backend ever runs multiple
  instances, move the store to Prisma/Redis.

## Implement these three routes

### 1. `src/lib/desktop-auth.ts` (new — shared code store)

```ts
import crypto from "node:crypto";

export interface DesktopAuthCode {
  provider: string;
  createdAt: number;
  used: boolean;
  /** Filled by the finish route once the user is authenticated. */
  session?: { id: string; name?: string | null; email?: string | null; image?: string | null };
}

const TTL_MS = 10 * 60_000;
const codes = new Map<string, DesktopAuthCode>();

function prune(): void {
  const now = Date.now();
  for (const [k, v] of codes) if (now - v.createdAt > TTL_MS) codes.delete(k);
}

export function mintDesktopCode(provider: string): string {
  prune();
  const code = crypto.randomUUID();
  codes.set(code, { provider, createdAt: Date.now(), used: false });
  return code;
}

export function getDesktopCode(code: string): DesktopAuthCode | null {
  prune();
  return codes.get(code) ?? null;
}

export function armDesktopCode(code: string, session: DesktopAuthCode["session"]): boolean {
  const entry = getDesktopCode(code);
  if (!entry || entry.used) return false;
  entry.session = session;
  return true;
}

/** Validate + burn atomically; returns null for unknown/expired/reused/unarmed codes. */
export function consumeDesktopCode(code: string): DesktopAuthCode | null {
  const entry = getDesktopCode(code);
  if (!entry || entry.used || !entry.session) return null;
  entry.used = true;
  codes.delete(code);
  return entry;
}
```

### 2. `src/app/api/auth/desktop/start/route.ts` (new)

Mint a code, then render a small page that performs the NextAuth CSRF dance
client-side (fetch `/api/auth/csrf`, then form-POST
`/api/auth/signin/<provider>` with `callbackUrl=/api/auth/desktop/finish?code=<code>`).
Do NOT rely on the deployed sign-in page passing `callbackUrl` through — this
page must be self-contained. If the provider's env credentials are missing
(Google: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; GitHub:
`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`), render an error page instead of
the auto-submit page.

```ts
import { NextResponse } from "next/server";
import { mintDesktopCode } from "@/lib/desktop-auth";

export const dynamic = "force-dynamic";

function page(body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Orplex Code — sign in</title>` +
      `<body style="font-family:system-ui;background:#141414;color:#eee;display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="text-align:center;max-width:420px">${body}</div></body>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function GET(request: Request) {
  const provider = (new URL(request.url).searchParams.get("provider") || "google").toLowerCase();
  if (provider !== "google" && provider !== "github") {
    return page(`<h2 style="color:#ff6b00">Unsupported provider</h2><p style="color:#9aa">Use google or github.</p>`);
  }
  const configured =
    provider === "google"
      ? !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
      : !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  if (!configured) {
    return page(`<h2 style="color:#ff6b00">${provider} sign-in is not configured</h2><p style="color:#9aa">Set the ${provider.toUpperCase()}_CLIENT_ID / _CLIENT_SECRET env vars on the backend.</p>`);
  }

  const code = mintDesktopCode(provider);
  const callbackUrl = `/api/auth/desktop/finish?code=${encodeURIComponent(code)}`;
  return page(
    `<h2 style="color:#ff6b00">Taking you to ${provider === "google" ? "Google" : "GitHub"}…</h2>` +
      `<p style="color:#9aa">Complete sign-in there; Orplex Code will reopen automatically.</p>` +
      `<script>
        fetch("/api/auth/csrf", { credentials: "same-origin" })
          .then((r) => r.json())
          .then(({ csrfToken }) => {
            const f = document.createElement("form");
            f.method = "POST";
            f.action = "/api/auth/signin/${provider}";
            for (const [n, v] of Object.entries({ csrfToken, callbackUrl: ${JSON.stringify(callbackUrl)} })) {
              const i = document.createElement("input");
              i.type = "hidden"; i.name = n; i.value = v; f.appendChild(i);
            }
            document.body.appendChild(f);
            f.submit();
          })
          .catch(() => { document.body.innerHTML = '<h2 style="color:#ff6b00">Sign-in could not start</h2><p style="color:#9aa">Return to the app and try again.</p>'; });
      </script>`
  );
}
```

### 3. `src/app/api/auth/desktop/finish/route.ts` (new)

Runs after the provider callback with the fresh session cookie. Arms the code
with the session user, then navigates the browser to `orplex://auth?code=...`.
A 302 to a custom scheme gets blocked by browsers, so render an HTML page that
navigates via JS with a manual link fallback.

```ts
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { armDesktopCode, getDesktopCode } from "@/lib/desktop-auth";

export const dynamic = "force-dynamic";

function page(body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Orplex Code — signed in</title>` +
      `<body style="font-family:system-ui;background:#141414;color:#eee;display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="text-align:center;max-width:420px">${body}</div></body>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code") || "";
  const entry = getDesktopCode(code);
  if (!entry) return page(`<h2 style="color:#ff6b00">Link expired</h2><p style="color:#9aa">Return to the app and start sign-in again.</p>`);

  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user) {
    return page(`<h2 style="color:#ff6b00">Sign-in did not complete</h2><p style="color:#9aa">Return to the app and try again.</p>`);
  }
  armDesktopCode(code, {
    id: (session.user as { id?: string }).id || session.user.email || "",
    name: session.user.name,
    email: session.user.email,
    image: session.user.image ?? null,
  });

  const deepLink = `orplex://auth?code=${encodeURIComponent(code)}`;
  return page(
    `<h2 style="color:#ff6b00">&#10003; Signed in</h2>` +
      `<p style="color:#9aa">Returning to Orplex Code… you can close this tab.</p>` +
      `<p><a href="${deepLink}" style="color:#ff8a3d">Open Orplex Code</a></p>` +
      `<script>setTimeout(() => { window.location.href = ${JSON.stringify(deepLink)}; }, 150);</script>`
  );
}
```

### 4. `src/app/api/auth/desktop/exchange/route.ts` (new)

Validates + burns the code and mints the session JWT **exactly like the dev
route does** (`encode()` from `next-auth/jwt`), setting BOTH cookie names.
Ensure a matching `User` row exists (upsert by `session.id`, mirroring
`/api/dev/session`) so FK-backed saves don't fail.

```ts
import { NextResponse } from "next/server";
import { encode } from "next-auth/jwt";
import { consumeDesktopCode } from "@/lib/desktop-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export async function POST(request: Request) {
  let code = "";
  try {
    code = String((await request.json())?.code || "");
  } catch {}
  const entry = code ? consumeDesktopCode(code) : null;
  if (!entry?.session?.id) {
    return NextResponse.json({ error: "Invalid or expired sign-in code" }, { status: 401 });
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "NEXTAUTH_SECRET is not set" }, { status: 500 });

  const user = entry.session;
  try {
    await prisma.user.upsert({
      where: { id: user.id },
      update: { name: user.name ?? undefined, email: user.email ?? undefined },
      create: { id: user.id, name: user.name ?? "Orplex User", email: user.email },
    });

    const token = await encode({
      token: { sub: user.id, id: user.id, name: user.name ?? null, email: user.email ?? null, picture: user.image ?? null, image: user.image ?? null },
      secret,
      maxAge: SESSION_MAX_AGE,
    });

    const response = NextResponse.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
    const base = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: SESSION_MAX_AGE };
    // Plain name: what the app's Edge proxy check reads.
    response.cookies.set("next-auth.session-token", token, { ...base, secure: false });
    // Prefixed name: what NextAuth in production reads. Chromium accepts
    // Secure cookies on localhost, so this lands on the app's origin too.
    response.cookies.set("__Secure-next-auth.session-token", token, { ...base, secure: true });
    return response;
  } catch (error) {
    console.error("[Desktop auth] exchange failed:", error);
    return NextResponse.json({ error: "Failed to create the desktop session" }, { status: 500 });
  }
}
```

## Acceptance checks (run after deploy)

```bash
# 1. Start page renders the auto-submit form
curl -s "https://orplextech.freebuff.app/api/auth/desktop/start?provider=google" | head -c 400

# 2. Exchange rejects junk codes with 401 JSON
curl -s -X POST "https://orplextech.freebuff.app/api/auth/desktop/exchange" \
  -H "Content-Type: application/json" -d '{"code":"nope"}' -w "\n%{http_code}\n"

# 3. Full flow (manual): open the start URL in a browser, sign in with Google,
#    confirm the browser lands on the "Signed in — returning to Orplex Code"
#    page and the OS prompts to open the orplex:// link.
```

## Constraints

- Do NOT change the Google/GitHub OAuth client configuration or redirect URIs.
- Do NOT change existing auth behavior for web users; these are additive routes.
- Keep the code store server-side only; never expose codes in logs.
