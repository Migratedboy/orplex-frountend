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
  // Don't hold the Node process (or a Jest worker) open just for cache sweeps.
  sweepTimer.unref?.();
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
    // Write-through to DB. The upsert is atomic (unique on key+windowStart),
    // and the DB is authoritative: when its count comes back, it overwrites
    // this process's optimistic cache value, healing any drift caused by
    // concurrent processes serving the same user.
    prisma.rateLimitWindow
      .upsert({
        where: { key_windowStart: { key, windowStart } },
        update: { count: { increment: 1 } },
        create: { key, windowStart, count: 1, expiresAt },
      })
      .then((row) => {
        const entry = cache.get(key);
        if (entry && now <= entry.expiresAt) entry.count = row.count;
      })
      .catch(() => {});
    return true;
  }

  // Slow path: single atomic upsert that returns the new count. Doing the
  // increment inside the DB (rather than findUnique → update) removes the
  // check-then-act race where two concurrent cold requests both read count
  // < limit and both pass. If the increment pushes us over, we deny — a
  // rare, off-by-one deny is fail-closed and far better than fail-open.
  try {
    const row = await prisma.rateLimitWindow.upsert({
      where: { key_windowStart: { key, windowStart } },
      update: { count: { increment: 1 } },
      create: { key, windowStart, count: 1, expiresAt },
    });

    cache.set(key, { count: row.count, expiresAt: expiresAt.getTime() });
    return row.count <= BURST_LIMIT;
  } catch {
    // Fail closed on DB error: burst protection must not evaporate exactly
    // when the DB is stressed. Fall back to the in-memory count if present,
    // otherwise deny (429) so abuse can't ride an outage.
    console.error("[rate-limiter] DB error in checkBurstLimit — failing closed");
    const cachedFallback = cache.get(key);
    if (cachedFallback && now <= cachedFallback.expiresAt) {
      return cachedFallback.count < BURST_LIMIT;
    }
    return false;
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

  // Aggregates in the database — the old version did findMany() over a full
  // day plus a full week of rows just to .length() them, which is O(rows) of
  // RAM on every admin page view. Response shape is unchanged.
  const [byProviderRows, byModelRows, latency, uniqueUsers, weekRequests, topUsers] =
    await Promise.all([
      prisma.usageLog.groupBy({
        by: ["provider"],
        where: { createdAt: { gte: todayStart } },
        _count: { _all: true },
      }),
      prisma.usageLog.groupBy({
        by: ["model"],
        where: { createdAt: { gte: todayStart } },
        _count: { _all: true },
      }),
      prisma.usageLog.aggregate({
        where: { createdAt: { gte: todayStart } },
        _avg: { latencyMs: true },
      }),
      prisma.usageLog.groupBy({
        by: ["userId"],
        where: { createdAt: { gte: todayStart } },
        _count: { _all: true },
      }),
      prisma.usageLog.count({ where: { createdAt: { gte: weekStart } } }),
      prisma.usageLog.groupBy({
        by: ["userId"],
        where: { createdAt: { gte: todayStart } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
      }),
    ]);

  const byProvider: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let todayRequests = 0;
  for (const row of byProviderRows) {
    byProvider[row.provider] = row._count._all;
    todayRequests += row._count._all;
  }
  for (const row of byModelRows) byModel[row.model] = row._count._all;

  return {
    today: {
      totalRequests: todayRequests,
      byProvider,
      byModel,
      uniqueUsers: uniqueUsers.length,
      avgLatencyMs: Math.round(latency._avg.latencyMs || 0),
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

/**
 * Best-effort client IP for THROTTLING keys (never for auth decisions).
 * Prefers x-real-ip (set — and overwritten — by the edge, not spoofable);
 * falls back to the leftmost x-forwarded-for entry, which a client CAN
 * spoof to rotate buckets. Fine for abuse friction, not a security boundary.
 */
export function clientIp(request: Request): string {
  try {
    const real = request.headers.get("x-real-ip");
    if (real && real.trim()) return real.trim().slice(0, 64);
    const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    return (first || "unknown").slice(0, 64);
  } catch {
    return "unknown";
  }
}

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

  // Initialize new window. Upsert, not create: a restart mid-window hits the
  // unique (key, windowStart) constraint, and the swallowed error meant the
  // first request of the new process never reached the DB — the "survives
  // restarts" guarantee only held from the second request on.
  prisma.rateLimitWindow
    .upsert({
      where: { key_windowStart: { key: cacheKey, windowStart } },
      update: { count: { increment: 1 } },
      create: { key: cacheKey, windowStart, count: 1, expiresAt: new Date(expiresAt) },
    })
    .then((row) => {
      const entry = cache.get(cacheKey);
      if (entry && now <= entry.expiresAt) entry.count = row.count;
    })
    .catch(() => {});
  cache.set(cacheKey, { count: 1, expiresAt });
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
