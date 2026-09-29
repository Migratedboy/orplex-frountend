// graceful-shutdown.ts — Handles SIGTERM/SIGINT for clean server shutdown
// Ensures in-flight requests complete, DB connections close, and cron jobs stop

import { prisma } from "./prisma";

type CleanupFn = () => Promise<void>;

const cleanupFns: CleanupFn[] = [];
let shuttingDown = false;

/**
 * Register a cleanup function to run on shutdown.
 * Examples: closing DB pools, stopping cron jobs, flushing logs.
 */
export function onShutdown(fn: CleanupFn): void {
  cleanupFns.push(fn);
}

/**
 * Start listening for shutdown signals.
 * Call once at server startup (e.g., in server.ts or layout.tsx).
 */
export function startGracefulShutdown(): void {
  if (typeof process === "undefined") return; // Browser — skip
  if (shuttingDown) return;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[shutdown] Received ${signal} — starting graceful shutdown...`);

    // Set a hard deadline — force exit after 30s
    const forceExit = setTimeout(() => {
      console.error("[shutdown] Forced exit after timeout");
      process.exit(1);
    }, 30_000);
    forceExit.unref(); // Don't keep the process alive just for this timer

    try {
      // Run all registered cleanup functions in parallel
      const results = await Promise.allSettled(
        cleanupFns.map((fn) =>
          Promise.race([
            fn(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Cleanup timeout")), 10_000)
            ),
          ])
        )
      );

      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        console.error(`[shutdown] ${failures.length} cleanup(s) failed:`, failures);
      }

      // Close Prisma connection
      console.log("[shutdown] Closing database connection...");
      await prisma.$disconnect();

      console.log("[shutdown] Clean shutdown complete.");
      process.exit(0);
    } catch (err) {
      console.error("[shutdown] Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Handle uncaught errors — log but don't crash.
  // Client-side aborts (user navigates away / a poll is superseded / the dev
  // HMR websocket re-connects) surface as `Error: aborted` / ECONNRESET from
  // Node's HTTP internals. They are routine noise, not defects: log them ONCE
  // per burst at a single line instead of a full stack each time — Next's dev
  // overlay was flooding with ⨯ uncaughtException on every one.
  let connAbortLogAt = 0;
  const isConnAbort = (err: unknown): boolean => {
    const e = err as { code?: string; message?: string };
    return e?.code === "ECONNRESET" || e?.code === "EPIPE" ||
      /aborted|ECONNRESET|EPIPE/i.test(e?.message || "");
  };
  const logConnAbort = () => {
    const now = Date.now();
    if (now - connAbortLogAt < 60_000) return; // max one line per minute
    connAbortLogAt = now;
    console.log("[net] client disconnected mid-request (aborted/ECONNRESET) — routine");
  };

  process.on("uncaughtException", (err) => {
    if (isConnAbort(err)) {
      logConnAbort();
      return; // Don't exit — let the process recover if possible
    }
    console.error("[shutdown] Uncaught exception:", err);
  });

  process.on("unhandledRejection", (reason) => {
    if (isConnAbort(reason)) {
      logConnAbort();
      return;
    }
    console.error("[shutdown] Unhandled rejection:", reason);
  });
}
