/**
 * rate-limit-retry.ts — Automatic retry with countdown for rate-limited requests
 * 
 * When a 429 is received, waits and retries automatically.
 * Shows countdown in the UI so user knows what's happening.
 */

export interface RetryConfig {
  maxRetries: number;        // Max retry attempts (default: 3)
  waitTime: number;          // Seconds to wait between retries (default: 60)
  onRetry?: (attempt: number, waitTime: number) => void;  // Callback for UI updates
  onComplete?: () => void;   // Callback when retry succeeds
  onFailed?: (error: string) => void;  // Callback when all retries fail
}

export interface RetryResult {
  success: boolean;
  attempts: number;
  totalTime: number;
  error?: string;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  waitTime: 60,
};

/**
 * Sleep for specified seconds, calling onRetry each second for countdown
 */
async function sleepWithCountdown(
  seconds: number,
  onTick?: (remaining: number) => void
): Promise<void> {
  for (let i = seconds; i > 0; i--) {
    onTick?.(i);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/**
 * Check if error is rate limit (429)
 */
export function isRateLimitError(error: any, statusCode?: number): boolean {
  if (statusCode === 429) return true;
  const msg = (error?.message || error || '').toLowerCase();
  return msg.includes('rate') || msg.includes('429') || msg.includes('too many');
}

/**
 * Extract retry-after from error response (default 60s)
 */
export function getRetryAfter(error: any): number {
  const msg = (error?.message || error || '').toLowerCase();
  // Try to extract retry_after_seconds from OpenRouter error
  const match = msg.match(/retry_after_seconds['":\s]+(\d+)/);
  if (match) return parseInt(match[1], 10);
  return 60; // Default
}

/**
 * Execute a function with automatic retry on rate limit
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<RetryResult & { data?: T }> {
  const { maxRetries, waitTime, onRetry, onComplete, onFailed } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  const startTime = Date.now();
  let lastError = '';

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const data = await fn();
      onComplete?.();
      return {
        success: true,
        attempts: attempt,
        totalTime: Date.now() - startTime,
        data,
      };
    } catch (error: any) {
      const statusCode = error?.status || error?.statusCode;
      lastError = error?.message || String(error);

      if (isRateLimitError(error, statusCode) && attempt <= maxRetries) {
        const retryAfter = getRetryAfter(error);
        onRetry?.(attempt, retryAfter);

        // Wait with countdown
        await sleepWithCountdown(retryAfter, (remaining) => {
          onRetry?.(attempt, remaining);
        });

        continue; // Retry
      }

      // Non-rate-limit error or max retries exceeded
      break;
    }
  }

  onFailed?.(lastError);
  return {
    success: false,
    attempts: maxRetries + 1,
    totalTime: Date.now() - startTime,
    error: lastError,
  };
}

/**
 * SSE-compatible retry: sends retry events to the client
 */
export function createRetrySSEController() {
  let retryAttempt = 0;
  let retryWaitTime = 0;

  return {
    /**
     * Check if a response is rate limited and handle retry
     */
    async handleRateLimit(
      response: Response,
      retryFn: () => Promise<Response>
    ): Promise<{ response: Response; retried: boolean }> {
      if (response.status === 429) {
        retryAttempt++;
        if (retryAttempt > 3) {
          return { response, retried: false };
        }

        // Parse retry-after from response
        const retryAfter = parseInt(
          response.headers.get('retry-after') || '60',
          10
        );

        // Send retry event to client
        const encoder = new TextEncoder();
        const retryEvent = `data: ${JSON.stringify({
          type: 'rate_limit_retry',
          attempt: retryAttempt,
          maxAttempts: 3,
          waitTime: retryAfter,
          message: `Rate limited. Retrying in ${retryAfter}s... (${retryAttempt}/3)`,
        })}\n\n`;

        // Wait and retry
        await sleepWithCountdown(retryAfter);

        const newResponse = await retryFn();
        return { response: newResponse, retried: true };
      }

      return { response, retried: false };
    },

    getAttempt: () => retryAttempt,
    reset: () => { retryAttempt = 0; },
  };
}
