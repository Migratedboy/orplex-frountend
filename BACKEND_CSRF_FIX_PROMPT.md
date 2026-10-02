# Backend fix: CSRF middleware blocks all next-auth sign-in (403)

## Symptom

Clicking any OAuth sign-in (desktop "Continue with Google" **and** the normal web
sign-in) dies with the browser showing:

```json
{"success":false,"error":{"message":"CSRF validation failed: missing required header"}}
```

## Root cause

`src/proxy.ts` (the backend's root middleware) requires every state-changing
request to send `Content-Type: application/json` **or** `X-Requested-With`:

```ts
// CSRF Protection: State-changing requests must include Content-Type or X-Requested-With header.
if (STATE_CHANGING_METHODS.has(request.method)) {
  const contentType = request.headers.get("content-type");
  const xhrHeader = request.headers.get("x-requested-with");

  if (!(contentType?.includes("application/json") || xhrHeader)) {
    return NextResponse.json(
      { success: false, error: { message: "CSRF validation failed: missing required header" } },
      { status: 403 }
    );
  }
  ...
}
```

But next-auth's own endpoints are **form-encoded** POSTs:

- `POST /api/auth/signin/google` — sent by a real HTML form (desktop start page)
  or by `signIn()` from next-auth/react. Form submissions can never set custom
  headers, so they always 403 here.
- `POST /api/auth/callback/google|github` and `/api/auth/signout` — same shape.

These routes already have next-auth's own CSRF protection (the `csrf-token`
cookie + `csrfToken` body field + `SameSite=Lax` cookies), so the extra header
check is redundant there — and it breaks every sign-in flow. The desktop flow's
`/api/auth/desktop/start` page verified healthy end-to-end otherwise: with the
header present the POST returns a correct 302 to
`https://accounts.google.com/o/oauth2/v2/auth?...` with client_id, PKCE
`code_challenge`, `state`, and `redirect_uri=https://orplextech.freebuff.app/api/auth/callback/google`.

## Fix (one change in `src/proxy.ts`)

Exempt next-auth's own routes from the CSRF header check:

```ts
// next-auth's own endpoints (/api/auth/*) are form-encoded POSTs — HTML form
// navigations can never set custom headers — and carry next-auth's own CSRF
// protection (csrf-token cookie + csrfToken body field + SameSite cookies),
// so this header check would 403 every sign-in flow. Exempt them.
const NEXT_AUTH_PATH = /^\/api\/auth(\/|$)/;

// CSRF Protection: State-changing requests must include Content-Type or X-Requested-With header.
if (STATE_CHANGING_METHODS.has(request.method) && !NEXT_AUTH_PATH.test(request.nextUrl.pathname)) {
  const contentType = request.headers.get("content-type");
  const xhrHeader = request.headers.get("x-requested-with");

  if (!(contentType?.includes("application/json") || xhrHeader)) {
    return NextResponse.json(
      { success: false, error: { message: "CSRF validation failed: missing required header" } },
      { status: 403 }
    );
  }

  // Additional origin check for sensitive state-changing operations
  if (!isOriginAllowed(request)) {
    return NextResponse.json(
      { success: false, error: { message: "Origin not allowed" } },
      { status: 403 }
    );
  }
}
```

Notes:

- The origin check can stay inside the same block — exempting the path skips it
  too, which is correct: next-auth binds its POSTs to its own CSRF cookie, and
  the desktop-exchange route is protected by the single-use one-time code.
- `/api/auth/desktop/exchange` (JSON POST from the app) passes the JSON
  content-type check either way, so nothing about it changes.
- No other middleware/routes need touching.

## Verification after deploy

```bash
# 1. Get a CSRF token + cookies
curl -s -c /tmp/cj.txt "https://orplextech.freebuff.app/api/auth/csrf"
TOK=$(curl -s -b /tmp/cj.txt "https://orplextech.freebuff.app/api/auth/csrf" | sed 's/.*"csrfToken":"\([^"]*\)".*/\1/')

# 2. This must now return 302 with a Location to accounts.google.com (was 403 before)
curl -s -i -b /tmp/cj.txt -X POST "https://orplextech.freebuff.app/api/auth/signin/google" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "csrfToken=$TOK" \
  --data-urlencode "callbackUrl=/api/auth/desktop/finish?code=test" | grep -i "^HTTP\|^Location"
```

Then in the app: click **Continue with Google** → sign in in the browser → the
`orplex://auth?code=…` deep link returns you to Orplex Code signed-in.
