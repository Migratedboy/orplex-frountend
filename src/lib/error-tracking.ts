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

// ---------------------------------------------------------------------------
// Optional @sentry/nextjs loader
//
// A LITERAL `import("@sentry/nextjs")` is resolved by the bundler at build
// time, and this package is deliberately not a dependency (see header) —
// Turbopack therefore failed the whole production build with
// "Module not found: Can't resolve '@sentry/nextjs'" at three call sites.
// Going through a runtime specifier keeps the package genuinely optional:
// installed → used, absent → the caller's fallback runs.
// ---------------------------------------------------------------------------

const SENTRY_PACKAGE = "@sentry/nextjs";

interface SentryScopeLike {
  setComponent(name?: string): void;
  setTag(key: string, value: string): void;
  setUser(user: Record<string, unknown>): void;
  setExtras(extras: Record<string, unknown>): void;
}

interface SentryLike {
  init(options: Record<string, unknown>): void;
  withScope(callback: (scope: SentryScopeLike) => void): void;
  captureException(error: unknown): void;
  captureMessage(message: string, level?: string): void;
}

/** Resolves to null (never rejects) when the SDK is not installed. */
async function loadSentry(): Promise<SentryLike | null> {
  try {
    const specifier = SENTRY_PACKAGE;
    return (await import(/* webpackIgnore: true */ specifier)) as SentryLike;
  } catch {
    return null;
  }
}

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
  loadSentry().then((Sentry) => {
    if (!Sentry) {
      console.log("[error-tracking] @sentry/nextjs not installed - using console-only fallback.");
      initConsoleFallback();
      return;
    }
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
    loadSentry().then((Sentry) => {
      if (!Sentry) return; // SDK not available - already logged to console
      Sentry.withScope((scope) => {
        if (context.component) scope.setComponent(context.component);
        if (context.action) scope.setTag("action", context.action);
        if (context.userId) scope.setUser({ id: context.userId });
        if (context.extra) scope.setExtras(context.extra);
        Sentry.captureException(error);
      });
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
    loadSentry().then((Sentry) => {
      if (!Sentry) return; // SDK not available
      Sentry.withScope((scope) => {
        if (context.component) scope.setComponent(context.component);
        if (context.extra) scope.setExtras(context.extra);
        Sentry.captureMessage(message, level);
      });
    });
  }
}
