/**
 * circuit-breaker-reset.ts — PostgreSQL-level circuit breaker auto-reset.
 *
 * Calls the SQL functions created by migration 20260902040000:
 *   • reset_circuit_breakers()       — bulk reset all expired circuit breakers
 *   • reset_provider_circuit_breaker(provider) — reset a single provider
 *   • next_open_circuit_breaker()    — find the next provider ready for probe
 *
 * Advisory lock (key=42) ensures only one process runs the bulk reset at a time.
 */

import { prisma } from "./prisma";

// --------------------------------------------------------------------------- Types
// ---------------------------------------------------------------------------

export interface ResetResult {
  provider: string;
  wasReset: boolean;
}

export interface CircuitProbeCandidate {
  provider: string;
  openUntil: Date;
}

// --------------------------------------------------------------------------- Bulk reset
// ---------------------------------------------------------------------------

/**
 * Reset all circuit breakers whose openUntil has passed.
 *
 * Uses `pg_try_advisory_lock(42)` inside the SQL function — if another
 * process is already running the reset, this call returns immediately
 * with an empty array (no-op).
 *
 * Call this:
 *   • On a cron schedule (e.g. every minute)
 *   • At startup
 *   • Before any provider call (idempotent, fast no-op)
 *
 * @returns Array of providers that were reset. Empty if nothing to reset
 *          or if another process already handled it.
 */
export async function resetCircuitBreakers(): Promise<ResetResult[]> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{ provider: string; was_reset: boolean }>
    >`SELECT * FROM reset_circuit_breakers()`;

    return rows.map((r) => ({
      provider: r.provider,
      wasReset: r.was_reset,
    }));
  } catch (err) {
    console.warn(
      "[circuit-breaker-reset] Bulk reset failed:",
      (err as Error).message,
    );
    return [];
  }
}

// --------------------------------------------------------------------------- Single-provider reset
// ---------------------------------------------------------------------------

/**
 * Reset a single provider's circuit breaker.
 *
 * Useful after a successful health check or probe request to manually
 * close the circuit without waiting for the bulk reset.
 *
 * @returns true if the provider was reset, false if it was already closed
 *          or another process handled it.
 */
export async function resetProviderCircuitBreaker(
  provider: string,
): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{ reset_provider_circuit_breaker: boolean }>
    >`SELECT reset_provider_circuit_breaker(${provider})`;

    return rows[0]?.reset_provider_circuit_breaker ?? false;
  } catch (err) {
    console.warn(
      `[circuit-breaker-reset] Reset ${provider} failed:`,
      (err as Error).message,
    );
    return false;
  }
}

// --------------------------------------------------------------------------- Probe candidate
// ---------------------------------------------------------------------------

/**
 * Find the next provider whose circuit breaker is ready for a half-open probe.
 *
 * Returns the provider with the earliest expired openUntil, or null if
 * no circuit breaker is ready to reset yet.
 */
export async function nextOpenCircuitBreaker(): Promise<CircuitProbeCandidate | null> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{ provider: string; open_until: Date }>
    >`SELECT * FROM next_open_circuit_breaker()`;

    if (rows.length === 0) return null;

    return {
      provider: rows[0].provider,
      openUntil: new Date(rows[0].open_until),
    };
  } catch (err) {
    console.warn(
      "[circuit-breaker-reset] Probe query failed:",
      (err as Error).message,
    );
    return null;
  }
}

// --------------------------------------------------------------------------- Scheduled auto-reset
// ---------------------------------------------------------------------------

let _resetInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start a periodic auto-reset that calls resetCircuitBreakers() every
 * `intervalMs` milliseconds. Only one interval can be active at a time.
 *
 * @param intervalMs How often to check (default: 60_000 = 1 minute)
 * @returns A stop function to cancel the interval.
 */
export function startAutoReset(intervalMs = 60_000): () => void {
  if (_resetInterval) {
    clearInterval(_resetInterval);
  }

  // Run once immediately, then on interval
  resetCircuitBreakers().catch(() => {});

  _resetInterval = setInterval(() => {
    resetCircuitBreakers().catch(() => {});
  }, intervalMs);
  // Don't hold the process open just for breaker resets.
  _resetInterval.unref?.();

  return () => {
    if (_resetInterval) {
      clearInterval(_resetInterval);
      _resetInterval = null;
    }
  };
}
