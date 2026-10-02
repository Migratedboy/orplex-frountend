// error-tracking.ts — Error tracking via Bugsink (self-hosted Sentry alternative)
//
// Bugsink is a drop-in replacement for Sentry that you self-host.
// It uses the Sentry SDK protocol, so the integration is identical.
//
// Setup:
// 1. Deploy Bugsink (podman run -p 8000:8000 bugsink/bugsink)
// 2. Create a project in the Bugsink UI
// 3. Set BUGSINK_DSN in your .env
//
// If BUGSINK_DSN is not set, errors are only logged to console.
// The @sentry/nextjs package is optional — if not installed, falls back to console logging.

let initialized = false;

interface ErrorContext {
  component?: string;
  action?: string;
  userId?: string;
  extra?: Record<string, unknown>;
}

/**
 * Initialize the error tracker. Safe to call multiple times.
 * Only initializes once, and only if BUGSINK_DSN is configured.
 */
export function initErrorTracking(): void {
  if (initialized || typeof window === "undefined") return;

  const dsn = process.env.NEXT_PUBLIC_BUGSINK_DSN || process.env.BUGSINK_DSN;
  if (!dsn) {
    console.log("[error-tracking] No BUGSINK_DSN configured - errors will only be logged to console.");
    initConsoleFallback();
    return;
  }

  // Try to dynamically import the Sentry SDK (same protocol as Bugsink)
  // If not installed, fall back to console-only logging
  import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.init({
        dsn,
        environment: process.env.NODE_ENV || "development",
        tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0.5,
        integrations: [],
      });
      initialized = true;
      console.log("[error-tracking] Initialized with Bugsink.");
    })
    .catch(() => {
      console.log("[error-tracking] @sentry/nextjs not installed - using console-only fallback.");
      initConsoleFallback();
    });
}

/**
 * Console-only fallback when Bugsink SDK is not available.
 */
function initConsoleFallback(): void {
  if (initialized) return;
  initialized = true;

  if (typeof window !== "undefined") {
    window.addEventListener("error", (event) => {
      console.error("[error-tracking] Uncaught error:", event.error);
    });
    window.addEventListener("unhandledrejection", (event) => {
      console.error("[error-tracking] Unhandled rejection:", event.reason);
    });
  }
}

/**
 * Report an error with context.
 * If Bugsink is configured, sends to Bugsink. Otherwise logs to console.
 */
export function reportError(error: Error, context: ErrorContext = {}): void {
  const payload = {
    message: error.message,
    stack: error.stack,
    ...context,
    timestamp: new Date().toISOString(),
  };

  // Always log to console
  console.error("[error-tracking]", payload);

  // Send to Bugsink if available
  if (initialized && typeof window !== "undefined") {
    import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.withScope((scope: any) => {
          if (context.component) scope.setComponent(context.component);
          if (context.action) scope.setTag("action", context.action);
          if (context.userId) scope.setUser({ id: context.userId });
          if (context.extra) scope.setExtras(context.extra);
          Sentry.captureException(error);
        });
      })
      .catch(() => {
        // SDK not available - already logged to console
      });
  }
}

/**
 * Report a non-error event (for tracking notable events).
 */
export function reportMessage(
  message: string,
  level: "info" | "warning" | "error" = "info",
  context: ErrorContext = {}
): void {
  console.log(`[error-tracking:${level}]`, message, context);

  if (initialized && typeof window !== "undefined") {
    import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.withScope((scope: any) => {
          if (context.component) scope.setComponent(context.component);
          if (context.extra) scope.setExtras(context.extra);
          Sentry.captureMessage(message, level);
        });
      })
      .catch(() => {
        // SDK not available
      });
  }
}
