// logger.ts — Structured logging with Pino
// Production-grade logging following Node.js backend patterns

import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  // NOTE: pino-pretty uses thread-stream to spawn a worker thread.
  // Turbopack resolves modules to virtual paths like [project]\... which
  // aren't valid filesystem paths, causing worker creation to crash the
  // entire route. Disabling the transport avoids this — pino still logs
  // to stdout in development, just without color formatting.
  transport: undefined,
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  base: { pid: process.pid, app: "orplex" },
});

// === Request Logger (for Next.js route handlers) ===

export function logRequest(method: string, path: string, startMs: number, status: number, extra?: Record<string, unknown>) {
  const duration = Date.now() - startMs;
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  logger[level]({ method, path, status, duration: `${duration}ms`, ...extra }, `${method} ${path} ${status} ${duration}ms`);
}

// === Error Logger ===

export function logError(error: unknown, context?: Record<string, unknown>) {
  if (error instanceof Error) {
    logger.error({ err: error, ...context }, error.message);
  } else {
    logger.error({ error, ...context }, "Unknown error");
  }
}

// === Performance Logger ===

export function logPerformance(operation: string, durationMs: number, extra?: Record<string, unknown>) {
  const level = durationMs > 5000 ? "warn" : "info";
  logger[level]({ operation, duration: `${durationMs}ms`, ...extra }, `${operation} completed in ${durationMs}ms`);
}
