/**
 * retry.ts — Shared retry helper for provider calls.
 *
 * One provider blip (504/429/ECONNRESET) must not burn a multi-minute
 * orchestration run: SPARC spends ~4-5 minutes across 5 sequential model
 * calls, and losing phase 4 to a transient 504 throws away phases 1-3.
 * LIVE-VALIDATED: NVIDIA returned 504s mid-run during the first live task,
 * killing both the ToT and Blueprint fallbacks in the same session.
 */

export interface RetryOptions {
  /** Total attempts INCLUDING the first (default 2 = one retry). */
  attempts?: number;
  /** Base backoff in ms before the first retry (doubled each attempt). */
  baseDelayMs?: number;
  /** Full-jitter ceiling in ms (delay = random between 0 and computed). */
  maxDelayMs?: number;
  /** Per-attempt timeout applied when fn doesn't provide its own signal. */
  attemptTimeoutMs?: number;
  /** Extra context for log lines. */
  label?: string;
  /** Quiet mode — no console output (tests). */
  silent?: boolean;
}

/** Status codes / error shapes worth retrying. */
export function isTransientError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err);
  // HTTP status blips
  if (/\b(408|429|500|502|503|504|522|524)\b/.test(msg)) return true;
  // Network-level failures
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|fetch failed|socket/i.test(msg)) return true;
  return false;
}

/**
 * Rate/quota-limited (429 / quota / TPM-RPM). Retryable in place, but also
 * the signal for the executor's failover chain to move to the next provider.
 */
export function isRateLimitError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err);
  if (/\b429\b/.test(msg)) return true;
  if (/rate.?limit|quota|too many requests|TPM|RPM/i.test(msg)) return true;
  return false;
}

/**
 * Extract a server-provided Retry-After hint (seconds or HTTP-date) from an
 * error message; falls back to null when absent/unparseable. Capped at 30s
 * so a hostile/buggy header can't stall an agent loop for minutes.
 */
export function retryAfterMs(err: unknown, now = Date.now()): number | null {
  const msg = String((err as Error)?.message || err);
  const m = msg.match(/retry[- ]after["':=\s]*([0-9]{1,3})/i);
  if (m) {
    const secs = Number(m[1]);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  }
  const dateMatch = msg.match(/retry[- ]after["':=\s]*([A-Za-z]{3},\s[^"']{10,40})/i);
  if (dateMatch) {
    const at = Date.parse(dateMatch[1]);
    if (Number.isFinite(at)) return Math.min(Math.max(at - now, 0), 30_000);
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry `fn` on transient failures with exponential backoff + full jitter.
 * Non-transient errors (400, 401, 403 — bad request/key) rethrow immediately:
 * retrying those just burns the caller's budget.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  const base = opts.baseDelayMs ?? 1500;
  const maxDelay = opts.maxDelayMs ?? 12_000;
  const label = opts.label || "provider";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (opts.attemptTimeoutMs) {
        return await Promise.race([
          fn(attempt),
          sleep(opts.attemptTimeoutMs).then(() => {
            throw new Error(`${label} attempt ${attempt} timed out after ${opts.attemptTimeoutMs}ms`);
          }),
        ]);
      }
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isTransientError(err)) throw err;
      // Honor a server Retry-After when present; otherwise exponential + jitter.
      const hint = retryAfterMs(err);
      const computed = hint ?? Math.min(base * 2 ** (attempt - 1), maxDelay);
      const delay = hint ?? Math.floor(Math.random() * computed);
      if (!opts.silent) {
        console.warn(`[retry] ${label} attempt ${attempt}/${attempts} failed (${String((err as Error)?.message || err).slice(0, 120)}) — retrying in ${delay}ms`);
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}
