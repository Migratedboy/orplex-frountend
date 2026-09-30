/**
 * circuit-breaker.ts — Database-backed circuit breaker for AI provider resilience.
 *
 * State is persisted in the CircuitBreakerState table. An in-memory cache
 * provides fast reads while DB writes happen asynchronously (fire-and-forget).
 *
 * States:
 *   - CLOSED (healthy): requests flow normally
 *   - OPEN (tripped): requests are blocked for OPEN_DURATION_MS after threshold failures
 *   - HALF-OPEN: after open duration, one probe request is allowed through
 */

import { prisma } from "./prisma";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FAILURE_THRESHOLD = 3;
const OPEN_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// In-memory cache (write-through, single source of truth after hydration)
// ---------------------------------------------------------------------------

interface ProviderState {
  failures: number;
  isOpen: boolean;
  openUntil: number;
  lastFailure: number;
  hydrated: boolean;
}

const states = new Map<string, ProviderState>();

/**
 * Ensure the provider state is loaded from the DB (lazy hydration).
 */
async function hydrateState(provider: string): Promise<ProviderState> {
  const cached = states.get(provider);
  if (cached?.hydrated) return cached;

  try {
    const dbState = await prisma.circuitBreakerState.findUnique({
      where: { provider },
    });

    if (dbState) {
      const now = Date.now();
      const state: ProviderState = {
        failures: dbState.failures,
        isOpen: dbState.isOpen && dbState.openUntil ? dbState.openUntil.getTime() > now : false,
        openUntil: dbState.openUntil?.getTime() || 0,
        lastFailure: dbState.lastFailure?.getTime() || 0,
        hydrated: true,
      };
      states.set(provider, state);
      return state;
    }
  } catch {
    // DB unavailable — continue with in-memory only
  }

  // No DB record — initialize fresh
  const fresh: ProviderState = {
    failures: 0,
    isOpen: false,
    openUntil: 0,
    lastFailure: 0,
    hydrated: true,
  };
  states.set(provider, fresh);
  return fresh;
}

/**
 * Persist state to DB asynchronously (fire-and-forget).
 */
function persistState(provider: string, state: ProviderState): void {
  prisma.circuitBreakerState
    .upsert({
      where: { provider },
      update: {
        failures: state.failures,
        isOpen: state.isOpen,
        openUntil: state.isOpen ? new Date(state.openUntil) : null,
        lastFailure: state.lastFailure > 0 ? new Date(state.lastFailure) : null,
      },
      create: {
        provider,
        failures: state.failures,
        isOpen: state.isOpen,
        openUntil: state.isOpen ? new Date(state.openUntil) : null,
        lastFailure: state.lastFailure > 0 ? new Date(state.lastFailure) : null,
      },
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a failure for a provider. Trips the circuit if threshold is reached.
 */
export async function recordFailure(provider: string): Promise<void> {
  const state = await hydrateState(provider);
  state.failures++;
  state.lastFailure = Date.now();

  if (state.failures >= FAILURE_THRESHOLD) {
    state.isOpen = true;
    state.openUntil = Date.now() + OPEN_DURATION_MS;
  }

  states.set(provider, state);
  persistState(provider, state);
}

/**
 * Record a success — reset failure count and close the circuit.
 */
export async function recordSuccess(provider: string): Promise<void> {
  const state = await hydrateState(provider);
  state.failures = 0;
  state.isOpen = false;
  state.openUntil = 0;
  state.lastFailure = 0;

  states.set(provider, state);
  persistState(provider, state);
}

/**
 * Check if a provider is available (circuit is closed or half-open).
 */
export async function isAvailable(provider: string): Promise<boolean> {
  const state = await hydrateState(provider);

  if (state.isOpen && Date.now() > state.openUntil) {
    // Half-open: allow one probe request
    state.isOpen = false;
    state.failures = 0;
    states.set(provider, state);
    persistState(provider, state);
    return true;
  }

  return !state.isOpen;
}

/**
 * Get health status for all known providers.
 */
export async function getProviderHealth(): Promise<
  Array<{
    name: string;
    status: string;
    failures: number;
    isOpen: boolean;
    openUntil: Date | null;
  }>
> {
  // Load all known providers from DB
  let dbStates: Array<{
    provider: string;
    failures: number;
    isOpen: boolean;
    openUntil: Date | null;
  }> = [];

  try {
    dbStates = await prisma.circuitBreakerState.findMany();
  } catch {
    // Fall back to in-memory states
  }

  const allProviders = new Set<string>();
  for (const s of dbStates) allProviders.add(s.provider);
  for (const [name] of states) allProviders.add(name);

  const results: Array<{
    name: string;
    status: string;
    failures: number;
    isOpen: boolean;
    openUntil: Date | null;
  }> = [];

  for (const name of allProviders) {
    const state = states.get(name);
    const failures = state?.failures ?? 0;
    const isOpen = state?.isOpen ?? false;

    let status: string;
    if (isOpen) {
      status = "circuit-open";
    } else if (failures > 0) {
      status = "degraded";
    } else {
      status = "healthy";
    }

    results.push({
      name,
      status,
      failures,
      isOpen,
      openUntil: state?.openUntil ? new Date(state.openUntil) : null,
    });
  }

  return results;
}

/**
 * Synchronous availability check (uses cached state only).
 * Falls back to "available" if state hasn't been hydrated yet.
 */
export function isAvailableSync(provider: string): boolean {
  const state = states.get(provider);
  if (!state) return true;

  if (state.isOpen && Date.now() > state.openUntil) {
    return true; // Half-open
  }

  return !state.isOpen;
}
