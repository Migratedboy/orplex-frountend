// proxy.ts — FRONTEND gatekeeper (physical split: UI-only app).
//
// The frontend owns ZERO API routes. Everything under /api/* used to live
// here; it now runs in the backend app (backend/src/app/api). This proxy:
//  1. Rewrites /api/auth/* to the backend origin so the browser keeps using
//     same-origin next-auth URLs (no CORS on the OAuth dance) while the real
//     handlers run on the API app.
//  2. Runs page-route Edge auth: redirect to /auth/signin when no session
//     token cookie is present (static assets and auth pages excluded).
//
// The BACKEND owns CORS + CSRF (see backend/src/proxy.ts) — a split UI has no
// same-origin API traffic left to protect.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

// Simple request ID generation - Edge Runtime compatible (no Node.js modules)
function generateRequestId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Backend origin for auth rewrites. Empty (monolith deployments) disables
// rewriting — same-origin /api/auth keeps working for single-app setups.
function backendOrigin(): string | null {
  const raw = (process.env.NEXT_PUBLIC_API_BASE_URL || "").trim().replace(/\/$/, "");
  return raw || null;
}

// Page routes that require a session (the frontend has no API routes left).
function requiresPageAuth(pathname: string): boolean {
  // Sign-in/out and static assets never redirect.
  if (pathname.startsWith("/auth") || pathname.startsWith("/_next") || pathname === "/favicon.ico") return false;
  if (/[^/]+\.[^/]+$/.test(pathname)) return false; // has a file extension
  if (pathname.startsWith("/api/")) return false; // rewrites below (no local handlers)
  return true;
}

// Proxy: page-route auth (Edge JWT check, redirect to /auth/signin) and
// same-origin auth/dev rewrites to the backend app.
export default async function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || generateRequestId();

  // Same-origin auth → backend. The rewrite keeps the browser on one origin
  // for the entire next-auth flow (provider callbacks included), so cookies
  // stay first-party and no CORS round-trips are needed.
  const origin = backendOrigin();
  if (origin && request.nextUrl.pathname.startsWith("/api/auth/")) {
    const backendUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, origin);
    const headers = new Headers(request.headers);
    headers.set("x-request-id", requestId);
    headers.set("x-forwarded-host", request.headers.get("host") || "");
    return NextResponse.rewrite(backendUrl, {
      request: { headers },
    });
  }

  // Dev session helper is backend-owned too (it mints the session cookie).
  if (origin && request.nextUrl.pathname.startsWith("/api/dev/")) {
    const backendUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, origin);
    const headers = new Headers(request.headers);
    headers.set("x-request-id", requestId);
    headers.set("x-forwarded-host", request.headers.get("host") || "");
    return NextResponse.rewrite(backendUrl, { request: { headers } });
  }

  // Page-route auth: same effect as the old withAuth wrapper (Edge JWT check,
  // redirect to /auth/signin). API routes authenticate themselves in the
  // backend app via getServerSession() in Node — unchanged.
  if (requiresPageAuth(request.nextUrl.pathname)) {
    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
    });
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
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Next.js requires unsafe-inline/eval
      "style-src 'self' 'unsafe-inline'", // Tailwind requires unsafe-inline
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      apiBase
        ? `connect-src 'self' ${apiBase} https: wss:` // split API + WebSocket/streaming
        : "connect-src 'self' https: wss:",
      "frame-src 'self' https: http://localhost:* http://127.0.0.1:*", // embedded browser (proxy + direct dev servers)
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
