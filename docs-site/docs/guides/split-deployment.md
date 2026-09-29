---
sidebar_position: 6.5
---

# Split Deployment — Frontend and API on different origins

By default Orplex is one Next.js app: pages, API routes and the provider calls all run in the same server. But the frontend and the API are fully decoupled at the code level, so you can deploy them **separately** — a static/edge frontend close to your users, and the API server (which holds your database and provider keys) wherever it's cheapest or most secure.

```
Browser                          Backend (any host)
┌──────────────────────┐         ┌──────────────────────────────┐
│ Frontend (static)    │  CORS   │  /api/*  ──▶ providers       │
│ app.example.com      │─cookie─▶│ api.example.com              │
│ NEXT_PUBLIC_API_BASE │         │ ALLOWED_ORIGINS, DATABASE_URL│
└──────────────────────┘         └──────────────────────────────┘
```

## The three env vars

| Variable | Where it's set | What it does |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | **Frontend build** | e.g. `https://api.example.com`. All browser API calls go here. Unset = same-origin (unchanged desktop/local behavior). |
| `ALLOWED_ORIGINS` | **Backend** | Comma list of frontend origins allowed to call the API (CORS echo + CSRF check). |
| `AUTH_COOKIE_DOMAIN` | **Backend** | e.g. `.example.com` — makes the session cookie shared by both subdomains. |

Optional: `AUTH_COOKIE_SAMESITE=None` — **only** when frontend and API are on unrelated registrable domains; requires HTTPS on both sides.

## Walkthrough — Vercel frontend + Railway backend

1. **Backend** (Railway/Fly/VPS — needs Node + persistent disks for the embedded Postgres, or an external Postgres):
   - Deploy the repo as-is. Set `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL=https://api.example.com`, provider keys, and `ALLOWED_ORIGINS=https://app.example.com`.
   - Set `AUTH_COOKIE_DOMAIN=.example.com` (same parent domain as the frontend).
2. **Frontend** (Vercel/Netlify — static/edge):
   - Same repo, build with `NEXT_PUBLIC_API_BASE_URL=https://api.example.com` and no server-side env needed beyond `NEXTAUTH_SECRET`/`NEXTAUTH_URL` for the client-side session hook.
   - Point `app.example.com` at Vercel, `api.example.com` at Railway.
3. **Verify**: sign in on the frontend → the session cookie lands on `.example.com` → `/api/models/available` answers from the backend origin → chat streams through CORS.

## How it works under the hood

- **One seam**: every browser API call goes through `apiFetch`/`withApiBase` (`src/lib/api-base.ts`), which prefixes `NEXT_PUBLIC_API_BASE_URL` and sends `credentials: "include"` plus the `X-Requested-With` CSRF header. Unset base = byte-identical same-origin behavior.
- **CORS with credentials**: `src/proxy.ts` answers preflights for `/api/*` and echoes only origins in `ALLOWED_ORIGINS`, with `Access-Control-Allow-Credentials: true`. A wildcard `*` is impossible with cookies — that's why the allowlist is exact.
- **Auth cookie sharing**: NextAuth JWT session cookie gets `Domain` from `AUTH_COOKIE_DOMAIN` so `app.example.com` and `api.example.com` share one session. Same parent domain is the recommended topology — with unrelated domains you must add `AUTH_COOKIE_SAMESITE=None` **and** serve both origins over HTTPS, or browsers drop the cookie.
- **Streaming**: chat/run streams are plain `fetch` + `ReadableStream` (no EventSource), so CORS headers are all they need; no proxying or buffering changes.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| CORS error in console on first API call | Backend `ALLOWED_ORIGINS` doesn't include the frontend origin (exact scheme+host match). |
| Preflight `OPTIONS` returns 404/403 | Old build — middleware must handle `OPTIONS` before auth. Redeploy. |
| Logged in but API says 401 | Cookie not shared: `AUTH_COOKIE_DOMAIN` missing/wrong, or `SameSite=None` needed for unrelated domains (HTTPS required). |
| `CSRF validation failed` | Client must send `X-Requested-With` or `Content-Type: application/json` — `apiFetch` does this automatically; raw `fetch` calls don't. |
| Works locally, fails in production | `NEXT_PUBLIC_API_BASE_URL` is a **build-time** variable for the frontend — it must be present when the frontend is *built*, not just at runtime. |

## Local two-origin drill

Reproduce the topology on one machine:

```bash
# Terminal 1 — backend on :5000 (defaults)
npm run dev
# Terminal 2 — any static server on another port serving a page that calls
# fetch("http://localhost:5000/api/models/available", {credentials:"include"})
```

Add `http://localhost:5100` to `ALLOWED_ORIGINS` in the backend `.env` and the call succeeds with cookies; remove it and the browser blocks the response — proof the allowlist is enforced.

## Related

- [Self-hosting](./self-hosting.md) — running the backend executor persistently
- [orplex.config.json Reference](./orplex-config.md) — MCP gateway for machine callers
- [Extending Orplex](./extending-orplex.md) — providers, keys, and model fetching
