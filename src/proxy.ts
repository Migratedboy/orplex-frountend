// proxy.ts — the split-deployment gatekeeper (formerly middleware.ts, renamed
// per the Next.js 16 proxy convention).
//
// EVERYTHING flows through this proxy:
//  - pages: Edge JWT auth (redirect to /auth/signin when absent)
//  - /api/*: CORS + credentials + CSRF (routes still do their own
//    getServerSession — the Edge check would be redundant there)
//  - static files (paths with extensions) skip auth so images load.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

// Simple request ID generation - Edge Runtime compatible (no Node.js modules)
function generateRequestId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// State-changing methods that need CSRF protection
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Get allowed origins from env (comma-separated)
function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS || "http://localhost:5000";
  return raw.split(",").map(o => o.trim()).filter(Boolean);
}

// Dynamically match request Origin against allowed origins.
// Split deployment: the frontend origin must be in ALLOWED_ORIGINS —
// credentials (cookies) make `*` illegal, so this is always an exact echo.
function getCorsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = getAllowedOrigins();
  const headers: Record<string, string> = {};

  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Vary"] = "Origin";
  } else if (!origin && allowed.length === 1) {
    // No-Origin (same-origin/server) request: hint the single configured origin.
    headers["Access-Control-Allow-Origin"] = allowed[0];
  }

  headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Request-ID, X-Requested-With";
  headers["Access-Control-Max-Age"] = "86400";

  return headers;
}

// Check if Origin header matches allowed origins (for sensitive operations)
function isOriginAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Same-origin requests don't send Origin
  const allowed = getAllowedOrigins();
  return allowed.includes(origin);
}

// Backend-only mode: when deployed as JUST the API server (separate repo /
// host from the frontend), page requests get a JSON stub instead of the UI
// bundle. API routes, auth routes and static assets are untouched.
function isBackendOnly(): boolean {
  return process.env.BACKEND_ONLY === "1";
}

// Page routes that require a session (API routes do their own auth in Node).
function requiresPageAuth(pathname: string): boolean {
  // Sign-in/out and static assets never redirect.
  if (pathname.startsWith("/auth") || pathname.startsWith("/_next") || pathname === "/favicon.ico") return false;
  if (/[^/]+\.[^/]+$/.test(pathname)) return false; // has a file extension
  if (pathname.startsWith("/api/")) return false; // API routes: getServerSession inside
  return true;
}

// Proxy: request ID tracking, CSRF protection, dynamic CORS (applied to
// API routes too — required for split deployment), and page-route auth.
export default async function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || generateRequestId();
  const corsHeaders = getCorsHeaders(request);

  // Handle CORS preflight (OPTIONS) — must answer for /api/* or a split
  // frontend's first cross-origin call dies here.
  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // Page-route auth: same effect as the old withAuth wrapper (Edge JWT check,
  // redirect to /auth/signin), but as a plain function so /api/* can flow
  // through the CORS logic below. API routes authenticate themselves via
  // getServerSession() in Node — unchanged.
  if (isBackendOnly() && requiresPageAuth(request.nextUrl.pathname)) {
    // Not a page a backend should serve — point humans at health, keep the
    // response cheap (no UI bundle streamed to a browser that hit the API host).
    return NextResponse.json(
      {
        service: "orplex-backend",
        status: "api-only",
        hint: "This host serves the API only. Point the frontend at it via NEXT_PUBLIC_API_BASE_URL and allowlist this origin there.",
        health: "/api/health",
      },
      { status: 404, headers: corsHeaders }
    );
  }

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

  // Add CORS headers (all paths — /api/* is the point of split deployment)
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }

  // Content-Security-Policy — connect-src explicitly includes the split-API
  // origin when configured (blanket https: stays for provider-side lanes).
  // NOTE: the embedded browser no longer proxies third-party pages through
  // the app — the desktop shell renders them in real Chromium — so there is
  // no special branch for /api/proxy-style routes anymore.
  const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL || "").trim();
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

    // Additional origin check for sensitive state-changing operations
    if (!isOriginAllowed(request)) {
      return NextResponse.json(
        { success: false, error: { message: "Origin not allowed" } },
        { status: 403 }
      );
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
