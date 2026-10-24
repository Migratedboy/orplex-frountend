// proxy.ts — FRONTEND gatekeeper (physical split: UI-only app).
//
// The frontend owns ZERO API routes. Everything under /api/* used to live
// here; it now runs in the backend app (backend/src/app/api). This proxy:
//  1. Rewrites /api/auth/* to the backend origin so the browser keeps using
//     same-origin next-auth URLs (no CORS on the OAuth dance) while the real
//     handlers run on the API app.
//  2. Runs page-route Edge auth: redirect to /auth/signin when no session
//     token cookie is present (static assets and auth pages excluded).
//  The sign-in PAGE is a frontend page (src/app/auth/signin) — all UI/UX
//  renders here per the split architecture.
//
// The BACKEND owns CORS + CSRF (see backend/src/proxy.ts) — a split UI has no
// same-origin API traffic left to protect.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { meetsMinimum } from "@/lib/app-version";

// Simple request ID generation - Edge Runtime compatible (no Node.js modules)
function generateRequestId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Backend origin for the API forward. Reads ORPLEX_API_URL (server-side
// Electron/cloud mode) or NEXT_PUBLIC_API_BASE_URL. Deliberately NOT exposed
// to the client bundle: the BROWSER always calls same-origin /api/*, and this
// server forwards to the backend — session cookies stay first-party on the
// UI origin and no CORS exists anywhere in the app.
function backendOrigin(): string | null {
  const raw = (process.env.ORPLEX_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
  return raw || null;
}

// Proxied auth routes that browsers poll continuously (session heartbeat).
// When the forward fails — no internet, cloud down, DNS dead — Next.js would
// otherwise return a plain-text 500 ("Internal Server Error"), which the
// next-auth client chokes on: CLIENT_FETCH_ERROR "Unexpected token 'I'".
// Returning JSON with an honest status instead gives the client a real error
// to render and keeps the failure legible in one place.
const PROXIED_AUTH_PREFIXES = ["/api/auth/", "/api/dev/"];

// Local-only API routes (never rewritten to the backend): machine-local
// diagnostics whose whole point is THIS host's hardware. /api/system/memory
// feeds low-memory failure messages — the cloud backend would report the
// Vercel host's RAM instead of the user's machine.
// Workspace-cwd registration is local too: it records a folder on the USER'S
// disk (a Windows/Mac path), and the filesystem that matters — the one agent
// exec/merge run against in desktop mode — is THIS machine's. The backend
// cannot stat a client OS path and rejected every registration with 400
// "Invalid directory", leaving the desktop terminal cwd-less. The local route
// verifies the session JWT itself (page auth below already does exactly this
// with the shared NEXTAUTH_SECRET).
const LOCAL_ONLY_API_ROUTES = [
  "/api/system/memory",
  "/api/attachments",
  "/api/attachments/extract",
  "/api/agent/workspace-cwd",
  // Agent create_file staging store: the bytes are held in THIS process's heap
  // (memory-file-store.ts) — the whole feature is "memory, not disk", and the
  // serverless backend cannot hold module state between the create and the
  // download. Forwarding would also 404: the backend has no such route.
  "/api/files",
  // Conversations: top-level list/create. Children (rename/delete/fork,
  // migrate-from-cloud) are covered by the /api/conversations/ prefix below.
  "/api/conversations",
];

// Conversations are LOCAL-FIRST in the desktop app: history CRUD reads and
// writes the on-device store through the Electron bridge, and the one-time
// migration pulls the full cloud thread list. Forwarding them to the backend
// would resurrect cloud writes the desktop no longer owns.
// The WEB build has no Electron bridge — its transport calls the same paths,
// which then forward to the backend and behave exactly as they did before.
// Prefix entry, so dynamic children (/api/conversations/[id]) match too.
// The one-time migration route (/api/conversations/migrate-from-cloud) also
// sits under this prefix ON PURPOSE: it stays local-served and does its own
// backend loopback — it must never be forwarded or it would double-proxy.
const LOCAL_ONLY_API_PREFIXES = [
  "/api/attachments/",
  // create_file staged-file children (/api/files/<id> and /status) — see the
  // LOCAL_ONLY_API_ROUTES comment above.
  "/api/files/",
  "/api/conversations/",
];

// Chat image attachments are local BY DESIGN: the bytes live on the user's own
// disk under <workspace>/.orplex/attachments and the Message row keeps only a
// reference. Proxying these to the backend would write them to Vercel's
// EPHEMERAL filesystem, where they are lost on the next cold start — which is
// exactly the "images don't survive a reload" bug this store exists to fix.
// Images are never persisted to Postgres, so there is no DB copy to lose.
// The nested serve route needs a PREFIX entry: LOCAL_ONLY_API_ROUTES matches
// exactly, so "/api/attachments/<id>.png" would otherwise still be proxied and
// 404 against a backend that has no such file.

// MCP connector routes USED to live in this process (conflict C2: OAuth
// pending states, token store, stdio configs in the local Prisma). That
// Postgres is gone — the one source of truth is the cloud backend now, which
// owns the same routes verbatim. Forwarding splits nothing: tokens, pending
// states and snapshots all resolve in one place (cloud), while the desktop
// stdio bridge still briefly holds runtime secrets it already did, client
// side (mcp-bridge.ts). The complete leg POSTs the loopback {code,state} to
// the backend with the user's own session cookie, so writes stay on the
// right owner.

// Model-catalog opt-out: the picker normally polls the cloud backend
// (/api/models/available) because that is where BYOK listings and the durable
// catalog snapshot live. ?local=1 opts a single poll into the DESKTOP's own
// sweep result instead — the long-lived local process probes models for real
// (the serverless backend cannot sustain a sweep), so the picker shows live
// rows immediately and publishes them to the backend via /api/models/ingest,
// converging its snapshot (see ChatInput's catalog loader).
const LOCAL_MODELS_QUERY = "local";

function isLocalOnlyApi(pathname: string, searchParams?: URLSearchParams): boolean {
  if (LOCAL_ONLY_API_ROUTES.includes(pathname)) return true;
  if (
    pathname === "/api/models/available" &&
    searchParams?.get(LOCAL_MODELS_QUERY) === "1"
  ) {
    return true;
  }
  return LOCAL_ONLY_API_PREFIXES.some((p) => pathname.startsWith(p));
}

// Page routes that require a session (the frontend has no API routes left).
function requiresPageAuth(pathname: string): boolean {
  // Sign-in/out and static assets never redirect.
  if (pathname.startsWith("/auth") || pathname.startsWith("/_next") || pathname === "/favicon.ico") return false;
  // "has a file extension" -> treated as a static asset, so no auth. This is
  // latent rather than exploitable today (no page route in src/app contains a
  // dot), but it is a footgun: adding a route like /settings/2.0 or a dotted
  // slug would silently opt out of authentication. Constrain the exemption to
  // paths that actually look like files - an extension of letters/digits, and
  // not a bare dotfile-style segment.
  if (/[^/]+\.[A-Za-z0-9]{1,8}$/.test(pathname) && !/\/\.[^/]+$/.test(pathname))
    return false; // has a file extension
  if (pathname.startsWith("/api/")) return false; // rewrites below (no local handlers)
  return true;
}

// Cached reachability probe — Edge runtime has no DNS/TCP APIs, so an HTTP
// HEAD to the cloud origin is the honest check. Any HTTP response (even a
// 5xx from the app itself) proves the network path works; only a thrown
// fetch (DNS failure, connection refused, timeout) means unreachable.
// Reachable results cache 30s (don't probe per poll); failures only 5s so
// recovery feels instant when the network returns.
let probeAt = 0;
let probeOk = false;
/** In-flight probe, so a cold cache does not fan out one HEAD per request. */
let probeInFlight: Promise<boolean> | null = null;
async function isCloudReachable(origin: string): Promise<boolean> {
  const now = Date.now();
  if (now - probeAt < (probeOk ? 30_000 : 5_000)) return probeOk;
  if (probeInFlight) return probeInFlight;

  // Page load fans out session + catalog + conversations + notifications in the
  // same tick, so without this every one of them started its own HEAD.
  probeInFlight = (async () => {
    const startedAt = Date.now();
    let ok: boolean;
    try {
      await fetch(origin, { method: "HEAD", signal: AbortSignal.timeout(4000) });
      ok = true;
    } catch {
      ok = false;
    }
    // Last RESOLUTION won before, not last INITIATION: if an older probe failed
    // on a transient blip and resolved after a newer one succeeded, probeOk was
    // left false and cached for 5s — bouncing every /api/auth/* request to a
    // 503 "offline" and signing the user out while the cloud was reachable.
    // A probe result now only lands if no newer probe has started since it did.
    if (startedAt >= probeAt) {
      probeOk = ok;
      // Stamp AFTER completion. The old code stamped the pre-await time, so a
      // 4s-timeout probe recorded its verdict as fresh up to 4s early.
      probeAt = Date.now();
    }
    probeInFlight = null;
    return ok;
  })();

  return probeInFlight;
}

// Proxy: page-route auth (Edge JWT check, redirect to /auth/signin) and
// same-origin auth/dev rewrites to the backend app.
export default async function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || generateRequestId();

// Version handshake (cloud backends set MIN_SUPPORTED_APP_VERSION; local
// desktop servers leave it unset and skip this entirely). Desktops send
// X-Orplex-App-Version via apiFetch; below the floor -> 426 so the app can
// prompt an update instead of failing mysteriously.
const minSupported = (process.env.MIN_SUPPORTED_APP_VERSION || "").trim();
if (
    minSupported &&
    request.nextUrl.pathname.startsWith("/api/") &&
    !isLocalOnlyApi(request.nextUrl.pathname, request.nextUrl.searchParams)
  ) {
  const clientVersion = (request.headers.get("x-orplex-app-version") || "").trim();
  // Previously a MISSING header was allowed and the gate was skipped entirely
  // for every local-only route. So the floor protected nothing: omit the header
  // (or send 999.0.0 - it is client-chosen either way) and you are through. If
  // the floor exists to keep incompatible clients off the backend, it has to
  // reject clients that cannot prove they are new enough. The header is absent
  // only from a genuinely browser-hosted preview, which is the one caller with
  // no app version to report.
  const isBrowserPreview = (request.headers.get("user-agent") || "").includes("Mozilla");
  if (!clientVersion && !isBrowserPreview) {
    return NextResponse.json(
      { error: "Missing client version — update Orplex to continue.", minVersion: minSupported, updateRequired: true },
      { status: 426 },
    );
  }
  if (clientVersion && !meetsMinimum(clientVersion, minSupported)) {
    return NextResponse.json(
      { error: "Client too old — update Orplex to continue.", minVersion: minSupported, updateRequired: true },
        { status: 426 }
      );
    }
  }

  // ALL /api/* traffic forwards to the backend origin: the browser stays
  // same-origin (cookies first-party on the UI origin, zero CORS), while the
  // real handlers run in the cloud backend. Covers next-auth (/api/auth/*),
  // the dev-session helper (/api/dev/*) and every data route in one rule.
  const origin = backendOrigin();
  if (
    origin &&
    request.nextUrl.pathname.startsWith("/api/") &&
    !isLocalOnlyApi(request.nextUrl.pathname, request.nextUrl.searchParams)
  ) {
    const backendUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, origin);
    const headers = new Headers(request.headers);
    headers.set("x-request-id", requestId);
    headers.set("x-forwarded-host", request.headers.get("host") || "");

    // No internet / cloud unreachable: the rewrite would surface as a
    // plain-text 500. For the auth heartbeat routes, respond with JSON the
    // next-auth client can parse (CLIENT_FETCH_ERROR with a readable body)
    // and a 503 so callers treat it as retryable, not a server bug.
    const cloudReachable = await isCloudReachable(origin);
    if (!cloudReachable && PROXIED_AUTH_PREFIXES.some((p) => request.nextUrl.pathname.startsWith(p))) {
      return NextResponse.json(
        { error: "offline", message: "No internet connection — Orplex cloud is unreachable. Reconnect to sign in and sync." },
        { status: 503, headers: { "x-orplex-offline": "1" } }
      );
    }

    return NextResponse.rewrite(backendUrl, {
      request: { headers },
    });
  }

  // The sign-in PAGE is frontend-owned (all UI/UX renders in the UI app).
  // /auth/* falls through to the app's own pages below — the next-auth ROUTES
  // stay on the backend via the /api/auth/* rewrite above.

  // Page-route auth: same effect as the old withAuth wrapper (Edge JWT check,
  // redirect to /auth/signin). API routes authenticate themselves in the
  // backend app via getServerSession() in Node — the forwarded cookies above
  // are what it reads.
  if (requiresPageAuth(request.nextUrl.pathname)) {
    // Desktop sign-in (orplex:// deep link) can set either the plain or the
    // __Secure- session cookie depending on the environment — accept both.
    const token =
      (await getToken({
        req: request,
        secret: process.env.NEXTAUTH_SECRET,
      })) ??
      (await getToken({
        req: request,
        secret: process.env.NEXTAUTH_SECRET,
        cookieName: "__Secure-next-auth.session-token",
      }));
    if (!token) {
      const signIn = new URL("/auth/signin", request.url);
      signIn.searchParams.set("callbackUrl", request.nextUrl.pathname);
      return NextResponse.redirect(signIn);
    }
  }

  const response = NextResponse.next();

  // Add request ID and timing headers
  response.headers.set("X-Request-ID", requestId);
  response.headers.set("X-Response-Time", new Date().toISOString());

  // Content-Security-Policy — connect-src explicitly includes the split-API
  // origin when configured (blanket https: stays for provider-side lanes).
  const apiBase = backendOrigin();
  const isProd = process.env.NODE_ENV === "production";
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // unsafe-eval is a Next.js dev requirement — never ship it in production.
      isProd ? "script-src 'self' 'unsafe-inline'" : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'", // Tailwind requires unsafe-inline
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      apiBase
        ? `connect-src 'self' ${apiBase} https: wss:` // split API + WebSocket/streaming
        : "connect-src 'self' https: wss:",
      // localhost frames are a dev/preview requirement — production gets https only.
      isProd ? "frame-src 'self' https:" : "frame-src 'self' https: http://localhost:* http://127.0.0.1:*",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
