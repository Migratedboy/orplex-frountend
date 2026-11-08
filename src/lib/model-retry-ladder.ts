// model-retry-ladder.ts — knobs for the worker's MODEL RESPONSE retry ladder.
//
// The model call for one turn used to tolerate exactly ONE transient blip
// (2 attempts, 1.5s apart) while the server-side provider ladder already
// climbed 20. A provider outage that outlived those two attempts therefore
// ended the turn in ~15 seconds with "The response failed" — even though the
// next retry usually answered.
//
// The ladder now matches the server (20 attempts) and every retry is labelled
// `[attempt N/20]` in the process feed, so a slow recovery is visible instead
// of looking like a hang or an immediate failure. Pure constants/formatting —
// no imports, no React, no I/O — so the rules stay unit-testable.

/** Total attempts for ONE model turn before the run fails. */
export const MODEL_RESPONSE_ATTEMPTS = 20;

/**
 * How much LONGER each retry waits than the one before it (ms).
 *
 * A provider that answers 429/quota needs the rate-limit WINDOW to roll over —
 * hammering it every second just burns attempts against a window that has not
 * reset yet. 2s steps give the window room to clear while still recovering
 * quickly from a plain connection blip.
 */
export const MODEL_RETRY_STEP_MS = 2_000;

/** Ceiling for one wait (ms) — the same 30s cap the provider ladder uses. */
export const MODEL_RETRY_MAX_DELAY_MS = 30_000;

/**
 * Backoff before retry `attempt` (1-based): 2s, 4s, 6s, … capped at 30s.
 * Strictly increasing, so no two rungs ever wait the same (or less) time.
 */
export function modelRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.trunc(Number(attempt) || 1));
  return Math.min(MODEL_RETRY_STEP_MS * n, MODEL_RETRY_MAX_DELAY_MS);
}

/** Whole seconds left before the next attempt — what the UI counts down. */
export function modelRetryCountdownSeconds(attempt: number): number {
  return Math.max(1, Math.ceil(modelRetryDelayMs(attempt) / 1000));
}

/** The user-visible attempt marker, e.g. "[attempt 3/20]". */
export function modelAttemptLabel(attempt: number, total: number = MODEL_RESPONSE_ATTEMPTS): string {
  return `[attempt ${Math.max(1, Math.trunc(Number(attempt) || 1))}/${total}]`;
}
