// proxy.ts — BACKEND gatekeeper (physical split: API-only app).
//
// This app owns ALL API routes (backend/src/app/api), next-auth, Prisma and
// every cron/job. The frontend is a separate UI-only app that calls this one
// cross-origin via NEXT_PUBLIC_API_BASE_URL, so this proxy:
//  1. Answers CORS preflights and stamps credentials-capable CORS headers for
//     exact origins listed in ALLOWED_ORIGINS (credentials make `*` illegal).
//  2. Enforces the CSRF header check (Content-Type JSON or X-Requested-With)
//     plus an exact-allowlist origin check on state-changing requests.
//  3. Answers human page hits with a cheap JSON identity instead of a UI
//     bundle — this host serves the API only.
//
// API routes still do their own getServerSession() in Node — unchanged.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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

// Human-facing page routes: this backend serves none of them. next-auth's own
// endpoints (/api/auth/*) must flow through untouched, as must static assets
// (they don't exist here, but excluding them keeps the matcher cheap).
function isPageRequest(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/_next") || pathname === "/favicon.ico") return false;
  if (/[^/]+\.[^/]+$/.test(pathname)) return false; // has a file extension
  return true;
}

// Proxy: request ID tracking, CSRF protection, dynamic CORS (applied to
// API routes too — required for split deployment), and an API-only identity
// for human page hits.
export default async function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || generateRequestId();
  const corsHeaders = getCorsHeaders(request);

  // Handle CORS preflight (OPTIONS) — must answer or a split frontend's
  // first cross-origin call dies here.
  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // Page routes: no UI bundle lives here — point humans at health and keep
  // the response cheap.
  if (isPageRequest(request.nextUrl.pathname)) {
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

  const response = NextResponse.next();

  // Add request ID and timing headers
  response.headers.set("X-Request-ID", requestId);
  response.headers.set("X-Response-Time", new Date().toISOString());

  // Add CORS headers (all /api/* paths — the point of split deployment)
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }

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
