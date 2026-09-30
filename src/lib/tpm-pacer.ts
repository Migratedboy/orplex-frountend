// tpm-pacer.ts — Global TPM token bucket shared by ALL model callers.
//
// The free-tier provider allows ~8k tokens/min ACCOUNT-WIDE. Two concurrent
// runs that each pace themselves independently will jointly exceed the
// account budget and cascade into 429s. This module is the fix: ONE
// process-wide bucket (globalThis singleton, runtime-state rationale) that
// every model call acquires from before sending. The browser worker and the
// server executor live in different runtimes, so each reports its usage
// here; the server side (the durable, always-on process) enforces waits.
//
// Design:
//   * Token bucket: capacity = budget/2 burst, refill budget per 60s.
//   * acquire(tokens) resolves when the bucket can pay; FIFO queue, no
//     starvation (a queued request keeps its place).
//   * Priority: runs marked "priority" jump ahead of batch work.
//   * Best-effort by design: on any internal error, acquire resolves
//     immediately — pacing must never break a run.

export interface PacerState {
  budgetPerMinute: number;
  available: number;
  queueDepth: number;
  lastRefillAt: number;
  totalWaitedMs: number;
  totalAcquired: number;
}

interface Waiter {
  tokens: number;
  priority: boolean;
  resolve: () => void;
  queuedAt: number;
}

const GLOBAL_KEY = "__orplexTpmPacer";

interface PacerInternal {
  budgetPerMinute: number;
  available: number;
  lastRefillAt: number;
  queue: Waiter[];
  totalWaitedMs: number;
  totalAcquired: number;
  pumpTimer: ReturnType<typeof setInterval> | null;
}

function pacer(): PacerInternal {
  const g = globalThis as unknown as { [GLOBAL_KEY]?: PacerInternal };
  if (!g[GLOBAL_KEY]) {
    const budget = defaultBudget();
    g[GLOBAL_KEY] = {
      budgetPerMinute: budget,
      available: budget / 2, // burst = half a window
      lastRefillAt: Date.now(),
      queue: [],
      totalWaitedMs: 0,
      totalAcquired: 0,
      pumpTimer: null,
    };
  }
  return g[GLOBAL_KEY];
}

/**
 * Lazy pump timer: refills the bucket and releases queued waiters every
 * second. Without it a queued waiter would only wake on the NEXT acquire —
 * and two runs waiting together would deadlock. Unref'd: never keeps the
 * process alive. Lives on the singleton so resetPacer clears it.
 */
function ensurePumpTimer(p: PacerInternal): void {
  if (p.pumpTimer) return;
  if (typeof setInterval !== "function") return;
  p.pumpTimer = setInterval(() => {
    try {
      pump(p);
    } catch {
      // never crash the timer
    }
  }, 1_000);
  if (p.pumpTimer.unref) p.pumpTimer.unref();
}

function defaultBudget(): number {
  const raw = Number(process.env.ORPLEX_TPM_BUDGET || "");
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : 8_000;
}

/** Test hook: reset the singleton (clears the pump timer). */
export function resetPacer(budgetPerMinute?: number): void {
  const g = globalThis as unknown as { [GLOBAL_KEY]?: PacerInternal };
  const old = g[GLOBAL_KEY];
  if (old?.pumpTimer) clearInterval(old.pumpTimer);
  delete g[GLOBAL_KEY];
  if (budgetPerMinute) pacer().budgetPerMinute = budgetPerMinute;
}

function refill(p: PacerInternal): void {
  const now = Date.now();
  const elapsed = now - p.lastRefillAt;
  if (elapsed <= 0) return;
  const refund = (elapsed / 60_000) * p.budgetPerMinute;
  p.available = Math.min(p.budgetPerMinute / 2, p.available + refund);
  p.lastRefillAt = now;
}

/** Report tokens actually consumed (called after a model response). */
export function reportUsage(tokens: number): void {
  if (tokens <= 0) return;
  const p = pacer();
  p.available = Math.max(0, p.available - tokens);
  p.totalAcquired += tokens;
}

function pump(p: PacerInternal): void {
  refill(p);
  // Priority waiters first, FIFO within class — no starvation.
  const ordered = [...p.queue].sort((a, b) => Number(b.priority) - Number(a.priority));
  const remaining: Waiter[] = [];
  for (const w of ordered) {
    if (p.available >= w.tokens) {
      p.available -= w.tokens;
      p.totalWaitedMs += Date.now() - w.queuedAt;
      w.resolve();
    } else {
      remaining.push(w);
    }
  }
  p.queue = remaining;
}

/**
 * Acquire `tokens` before a model call. Resolves when the bucket has paid
 * (or immediately on any internal error — pacing is best-effort). Requests
 * larger than the burst capacity are clamped to it (reportUsage reconciles
 * the real cost afterwards) — otherwise a huge prompt could never be paid
 * and would wait forever.
 */
export async function acquireTokens(tokens: number, priority = false): Promise<void> {
  try {
    const p = pacer();
    const capacity = p.budgetPerMinute / 2;
    const want = Math.max(0, Math.min(Math.floor(tokens), capacity));
    if (want === 0) return;
    ensurePumpTimer(p);
    refill(p);
    if (p.available >= want && p.queue.length === 0) {
      p.available -= want;
      p.totalAcquired += want;
      return;
    }
    await new Promise<void>((resolve) => {
      p.queue.push({ tokens: want, priority, resolve, queuedAt: Date.now() });
      pump(p);
    });
  } catch {
    return; // pacing must never break a run
  }
}

/** Estimated tokens for a message list (chars/4, matches the worker). */
export function estimateTokensOfMessages(messages: Array<{ content: string }>): number {
  return messages.reduce((s, m) => s + Math.ceil((m.content?.length ?? 0) / 4), 0);
}

/** Snapshot for the System lane panel. */
export function getPacerState(): PacerState {
  const p = pacer();
  refill(p);
  return {
    budgetPerMinute: p.budgetPerMinute,
    available: Math.floor(p.available),
    queueDepth: p.queue.length,
    lastRefillAt: p.lastRefillAt,
    totalWaitedMs: p.totalWaitedMs,
    totalAcquired: p.totalAcquired,
  };
}
