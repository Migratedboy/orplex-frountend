import { withAuth } from "next-auth/middleware";
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

// Dynamically match request Origin against allowed origins
function getCorsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = getAllowedOrigins();
  const headers: Record<string, string> = {};

  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  } else if (allowed.length === 1) {
    headers["Access-Control-Allow-Origin"] = allowed[0];
  }

  headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Request-ID";
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

// Middleware with request ID tracking, CSRF protection, dynamic CORS, and request timeout
export default withAuth(
  function middleware(request) {
    const requestId = request.headers.get("x-request-id") || generateRequestId();
    const corsHeaders = getCorsHeaders(request);

    // Handle CORS preflight (OPTIONS)
    if (request.method === "OPTIONS") {
      return new NextResponse(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const response = NextResponse.next();

    // Add request ID and timing headers
    response.headers.set("X-Request-ID", requestId);
    response.headers.set("X-Response-Time", new Date().toISOString());

    // Add CORS headers
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value);
    }

    // Content Security Policy — prevents XSS, data injection, and unauthorized resource loading
    response.headers.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Next.js requires unsafe-inline/eval
        "style-src 'self' 'unsafe-inline'", // Tailwind requires unsafe-inline
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self' https: wss:", // WebSocket for streaming
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
  },
  {
    pages: { signIn: "/auth/signin" },
  }
);

export const config = {
  // SECURITY: Page routes go through withAuth (Edge JWT check + redirect to /auth/signin).
  // ALL API routes are excluded — they handle their own auth via getServerSession()
  // in Node.js, so the Edge middleware check is redundant and adds ~1-3ms per request.
  // Static files (paths with extensions) are excluded so images load without auth.
  matcher: ["/((?!auth|api/|_next|favicon.ico|[^/]+\.[^/]+$).*)"],
};
