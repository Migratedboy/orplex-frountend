/**
 * rate-limiter.ts — Database-backed rate limiting with in-memory cache layer.
 *
 * Architecture:
 *   - Burst limiter: DB-backed per-minute sliding window (survives restarts)
 *   - Daily quota: Already DB-backed via UserQuota (unchanged)
 *   - Legacy rate limiter: DB-backed per-minute window (survives restarts)
 *
 * The in-memory Map acts as a write-through cache to avoid hitting the DB
 * on every single request. Stale entries are cleaned up by a periodic sweep.
 */

import { prisma } from "./prisma";

// ---------------------------------------------------------------------------
// In-memory cache layer (write-through, evicts expired entries periodically)
// ---------------------------------------------------------------------------

interface CachedWindow {
  count: number;
  expiresAt: number;
}

const cache = new Map<string, CachedWindow>();
const CACHE_SWEEP_INTERVAL_MS = 60_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function startSweepIfNeeded(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now > entry.expiresAt) cache.delete(key);
    }
  }, CACHE_SWEEP_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Burst Limiter (per-minute, DB-backed)
// ---------------------------------------------------------------------------

const BURST_LIMIT = 10;
const BURST_WINDOW_MS = 60_000;

/**
 * Check and increment the per-minute burst counter for a user.
 * Returns false if the burst limit is exceeded.
 */
export async function checkBurstLimit(userId: string): Promise<boolean> {
  startSweepIfNeeded();
  const key = `burst:${userId}`;
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / BURST_WINDOW_MS) * BURST_WINDOW_MS);
  const expiresAt = new Date(windowStart.getTime() + BURST_WINDOW_MS);

  // Fast path: check in-memory cache
  const cached = cache.get(key);
  if (cached && now <= cached.expiresAt) {
    if (cached.count >= BURST_LIMIT) return false;
    cached.count++;
    // Write-through to DB (fire and forget for performance)
    prisma.rateLimitWindow
      .upsert({
        where: { key_windowStart: { key, windowStart } },
        update: { count: { increment: 1 } },
        create: { key, windowStart, count: 1, expiresAt },
      })
      .catch(() => {});
    return true;
  }

  // Slow path: query DB for current window
  try {
    const existing = await prisma.rateLimitWindow.findUnique({
      where: { key_windowStart: { key, windowStart } },
    });

    const currentCount = existing?.count || 0;
    if (currentCount >= BURST_LIMIT) {
      cache.set(key, { count: currentCount, expiresAt: expiresAt.getTime() });
      return false;
    }

    // Increment
    const newCount = currentCount + 1;
    cache.set(key, { count: newCount, expiresAt: expiresAt.getTime() });

    if (existing) {
      await prisma.rateLimitWindow.update({
        where: { key_windowStart: { key, windowStart } },
        data: { count: { increment: 1 } },
      });
    } else {
      await prisma.rateLimitWindow.create({
        data: { key, windowStart, count: 1, expiresAt },
      });
    }

    return true;
  } catch {
    // On DB error, fall back to allowing the request (fail-open)
    return true;
  }
}

// ---------------------------------------------------------------------------
// Daily Quota (already DB-backed via UserQuota — unchanged)
// ---------------------------------------------------------------------------

export function checkUserQuota(
  userId: string,
  quota?: { requestsToday: number; dailyLimit: number; lastResetAt: Date },
): { allowed: boolean; remaining: number; limit: number } {
  const now = new Date();
  const lastReset = quota?.lastResetAt || new Date(0);
  const isNewDay = now.toDateString() !== lastReset.toDateString();
  const requests = isNewDay ? 0 : (quota?.requestsToday || 0);
  const limit = quota?.dailyLimit || 50;

  return {
    allowed: requests < limit,
    remaining: Math.max(0, limit - requests),
    limit,
  };
}

export async function incrementUserQuota(userId: string): Promise<void> {
  const now = new Date();
  const existing = await prisma.userQuota.findUnique({
    where: { userId },
  });

  if (!existing) {
    await prisma.userQuota.create({
      data: { userId, requestsToday: 1 },
    });
    return;
  }

  const isNewDay =
    now.toDateString() !== existing.lastResetAt.toDateString();

  await prisma.userQuota.update({
    where: { userId },
    data: {
      requestsToday: isNewDay ? 1 : { increment: 1 },
      lastResetAt: isNewDay ? now : existing.lastResetAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Usage Logging (unchanged)
// ---------------------------------------------------------------------------

export async function logUsage(params: {
  userId: string;
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  success?: boolean;
}): Promise<void> {
  await prisma.usageLog.create({
    data: {
      userId: params.userId,
      provider: params.provider,
      model: params.model,
      tokensIn: params.tokensIn || 0,
      tokensOut: params.tokensOut || 0,
      latencyMs: params.latencyMs || 0,
      success: params.success !== false,
    },
  });
}

export async function getUsageStats() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  const [todayLogs, weekLogs, topUsers] = await Promise.all([
    prisma.usageLog.findMany({ where: { createdAt: { gte: todayStart } } }),
    prisma.usageLog.findMany({ where: { createdAt: { gte: weekStart } } }),
    prisma.usageLog.groupBy({
      by: ["userId"],
      where: { createdAt: { gte: todayStart } },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 10,
    }),
  ]);

  const todayRequests = todayLogs.length;
  const byProvider: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let totalLatency = 0;

  for (const log of todayLogs) {
    byProvider[log.provider] = (byProvider[log.provider] || 0) + 1;
    byModel[log.model] = (byModel[log.model] || 0) + 1;
    totalLatency += log.latencyMs;
  }

  const weekRequests = weekLogs.length;
  const uniqueUsersToday = new Set(todayLogs.map((l) => l.userId)).size;

  return {
    today: {
      totalRequests: todayRequests,
      byProvider,
      byModel,
      uniqueUsers: uniqueUsersToday,
      avgLatencyMs:
        todayRequests > 0 ? Math.round(totalLatency / todayRequests) : 0,
    },
    thisWeek: {
      totalRequests: weekRequests,
    },
    topUsers: topUsers.map((u) => ({
      userId: u.userId,
      requests: u._count.id,
    })),
  };
}

// ---------------------------------------------------------------------------
// Legacy Rate Limiter (per-minute, DB-backed, for non-chat API routes)
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

export function checkRateLimit(key: string): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} {
  // This function must remain synchronous for backward compatibility
  // with existing callers. Use the in-memory cache as primary store.
  const now = Date.now();
  const windowStart = new Date(
    Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS,
  );
  const cacheKey = `ratelimit:${key}`;
  const expiresAt = windowStart.getTime() + RATE_LIMIT_WINDOW_MS;

  startSweepIfNeeded();

  const cached = cache.get(cacheKey);
  if (cached && now <= cached.expiresAt) {
    if (cached.count >= RATE_LIMIT_MAX) {
      return { allowed: false, remaining: 0, resetAt: cached.expiresAt };
    }
    cached.count++;
    // Async DB write (fire and forget)
    prisma.rateLimitWindow
      .upsert({
        where: { key_windowStart: { key: cacheKey, windowStart } },
        update: { count: { increment: 1 } },
        create: { key: cacheKey, windowStart, count: 1, expiresAt: new Date(expiresAt) },
      })
      .catch(() => {});
    return {
      allowed: true,
      remaining: RATE_LIMIT_MAX - cached.count,
      resetAt: expiresAt,
    };
  }

  // Initialize new window
  cache.set(cacheKey, { count: 1, expiresAt });
  prisma.rateLimitWindow
    .create({
      data: {
        key: cacheKey,
        windowStart,
        count: 1,
        expiresAt: new Date(expiresAt),
      },
    })
    .catch(() => {});
  return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetAt: expiresAt };
}

export function applyRateLimitHeaders(
  response: Response,
  rateLimit: { remaining: number; resetAt: number },
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-RateLimit-Remaining", String(rateLimit.remaining));
  headers.set(
    "X-RateLimit-Reset",
    String(Math.ceil(rateLimit.resetAt / 1000)),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove expired rate limit windows from the DB. Call periodically.
 */
export async function cleanupExpiredWindows(): Promise<void> {
  await prisma.rateLimitWindow.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
}
