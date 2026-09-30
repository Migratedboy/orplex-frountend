# Orplex Backend

The **backend** app of Orplex's physical split. API-only: it owns **every
route handler** (`src/app/api`, 80 routes), **next-auth**, **Prisma**, the
agent executor, all crons and all processing. It renders no UI — the frontend
(repo root, a separate app/repo) is pure UI/UX.

```
Frontend (UI-only)                    Backend (API-only, this repo)
┌─────────────────────────┐           ┌──────────────────────────────┐
│ src/app     → pages     │  fetch    │ src/app/api → ALL 80 routes  │
│ src/components          │ ────────► │ src/app/auth → next-auth     │
│ src/hooks               │  + cookies│ src/lib     → prisma, exec…  │
│ NO api/, NO prisma,     │           │ instrumentation.ts (executor)│
│ NO next-auth server,    │           │ proxy.ts → CORS + CSRF       │
│ proxy.ts → page auth +  │           │ prisma/ → schema+migrations  │
│ /api/auth rewrite       │           └──────────────────────────────┘
└─────────────────────────┘
        NEXT_PUBLIC_API_BASE_URL on the UI points here.
```

## Local development (split)

```bash
# 1. Local dev database (embedded Postgres, this repo's script):
node scripts/local-db.mjs start             # Postgres on :5433

# 2. Backend on :5010 (this directory):
npm run dev -- -p 5010

# 3. Frontend on :5000 (root repo, separate terminal):
npm run dev:ui
# or both at once from the root:
npm run dev:split
```

Root `.env` sets `NEXT_PUBLIC_API_BASE_URL=http://localhost:5010`; this
directory's `.env` holds the backend's own DATABASE_URL / NEXTAUTH_* /
ALLOWED_ORIGINS (see `.env.example`). `NEXTAUTH_SECRET` must match between
the two apps.

## Tests & checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # jest (66 suites / 572 tests)
npm run build       # next build
```

## Deployment

```bash
docker build -t orplex-backend .
docker run --env-file .env -p 8080:8080 orplex-backend
# boots with `prisma migrate deploy` (additive only), then next start
```

Human page hits get a JSON `{"service":"orplex-backend","status":"api-only"}`
identity from the proxy; only `/api/*` is served. Point the frontend at this
origin with `NEXT_PUBLIC_API_BASE_URL` and allowlist the UI origin in
`ALLOWED_ORIGINS` (exact match, credentials-enabled).

Cookie topology options: same parent domain → `AUTH_COOKIE_DOMAIN=.example.com`;
unrelated domains → `AUTH_COOKIE_SAMESITE=None` (HTTPS required). In split
local dev, the frontend proxy rewrites `/api/auth/*` to this origin so the
whole next-auth dance stays same-origin in the browser.
