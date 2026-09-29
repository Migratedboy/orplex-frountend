# Orplex Backend

API-only deployment of Orplex Tech: 80 Next.js route handlers (auth, chat streaming, agent runs, conversations, projects roster, models, settings) with Prisma/Postgres and provider keys — the frontend is deployed separately and talks to this over CORS with cookie credentials.

```
Browser                       Backend (this repo build)
┌──────────────────┐          ┌─────────────────────────┐
│ Frontend          │  CORS   │ /api/*  → providers     │
│ app.example.com   │─cookie─▶│ api.example.com         │
│ NEXT_PUBLIC_API_  │         │ ALLOWED_ORIGINS         │
│   BASE_URL        │         │ DATABASE_URL, keys      │
└──────────────────┘          └─────────────────────────┘
```

## Deploy to Freebuff Cloud (checklist)

1. **Push/sync this repo** — it tracks the main app monorepo's `main` branch (`git push backend main` from the app checkout).
2. **Create the service** — Docker deploy with `Dockerfile.backend`, or Node 20 with:
   - Build: `npm ci && npx prisma generate && npm run build`
   - Start: `npx prisma migrate deploy && npm run start`
   - Migrations are **additive only** — they never reset or drop data.
3. **Set env vars** from [`.env.example.backend`](.env.example.backend). The three that make the split work:
   - `ALLOWED_ORIGINS` — your **frontend** origin (exact scheme+host).
   - `AUTH_COOKIE_DOMAIN` — shared parent domain (e.g. `.example.com`) so one sign-in covers both.
   - `BACKEND_ONLY=1` — pages return a JSON api-only stub; only `/api/*` serves.
4. **Verify**: `GET /api/health` → `{"status":"healthy","checks":{"database":"ok",...}}`.

## Frontend counterpart (the other half of the split)

Build the frontend with:

```
NEXT_PUBLIC_API_BASE_URL=https://api.your-domain.com
```

That's a **build-time** var — it must be present when the frontend is built, not just at runtime. `apiFetch` then sends every API call to the backend with `credentials: "include"` and the CSRF header automatically.

## How the pieces work

| Piece | File | Role |
|---|---|---|
| One seam | `src/lib/api-base.ts` | every browser API call prefixed with `NEXT_PUBLIC_API_BASE_URL`; unset = same-origin (desktop unchanged) |
| CORS | `src/proxy.ts` | preflight `OPTIONS` for `/api/*`, exact-echo of allowlisted origins with credentials, CSRF enforcement, `BACKEND_ONLY` page gate |
| Cookies | `src/lib/auth.ts` | `AUTH_COOKIE_DOMAIN` / `AUTH_COOKIE_SAMESITE=None` split-deployment cookie options |
| Streaming | `src/app/api/chat/*` | plain `fetch` + `ReadableStream` — CORS headers are all it needs cross-origin |

With credentials involved, `Access-Control-Allow-Origin: *` is illegal — that's why `ALLOWED_ORIGINS` is an exact allowlist and the server echoes the request origin only when it matches.

## Local two-origin drill

```bash
# Terminal 1 — backend (defaults, port 5000)
npm run dev
# Terminal 2 — any static page on :5100 that does
#   fetch("http://localhost:5000/api/models/available", { credentials: "include" })
# Add http://localhost:5100 to ALLOWED_ORIGINS → call succeeds with cookies.
# Remove it → browser blocks the response. Allowlist proven.
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| CORS error on first API call | Backend `ALLOWED_ORIGINS` missing the frontend origin (exact match incl. scheme). |
| Preflight 404/403 | Old build — `OPTIONS` must be answered by the proxy before auth. Redeploy. |
| Signed in but API 401 | Cookie not shared: check `AUTH_COOKIE_DOMAIN`, or set `AUTH_COOKIE_SAMESITE=None` for unrelated domains (HTTPS required on both). |
| `CSRF validation failed` | Client must send `X-Requested-With` or JSON content-type — `apiFetch` does this; raw `fetch` doesn't. |
| Page request returns JSON api-only stub | Expected: `BACKEND_ONLY=1` is on. Point the browser at the frontend origin instead. |
