// quota-manager.ts — Free tier constants and high-level quota API
// Delegates actual enforcement to rate-limiter.ts (single source of truth)

import { prisma } from "../prisma";
import { checkUserQuota, incrementUserQuota, quotaDayKey, FREE_TIER_DAILY_LIMIT } from "../rate-limiter";

// ---------------------------------------------------------------------------
// Tier Limits
// ---------------------------------------------------------------------------

export const FREE_TIER = {
  /** Max requests per day for free users (single source: rate-limiter). */
  DAILY_LIMIT: FREE_TIER_DAILY_LIMIT,
  /** Max tokens per prompt */
  MAX_TOKENS_PER_PROMPT: 4096,
  /** Allowed models (free tier only gets the verified-live Groq flagship) */
  ALLOWED_MODELS: ["openai/gpt-oss-120b"] as const,
  /** Max file uploads per prompt */
  MAX_FILE_UPLOADS: 5,
  /** Max conversation length */
  MAX_MESSAGES_PER_CONVERSATION: 50,
} as const;

export const PRO_TIER = {
  DAILY_LIMIT: Infinity,
  MAX_TOKENS_PER_PROMPT: 16384,
  ALLOWED_MODELS: ["*"] as const,
  MAX_FILE_UPLOADS: 20,
  MAX_MESSAGES_PER_CONVERSATION: 200,
} as const;

export type Tier = "free" | "pro" | "team";

// ---------------------------------------------------------------------------
// Usage API — delegates to rate-limiter
// ---------------------------------------------------------------------------

interface UsageRecord {
  userId: string;
  date: string;
  requestsToday: number;
  tier: string;
}

/**
 * Get today's date as YYYY-MM-DD string.
 *
 * Delegates to the enforcer's day key so the displayed/reset day and the
 * enforced day can never disagree (they previously did: this used UTC while
 * rate-limiter used local time).
 */
function today(): string {
  return quotaDayKey();
}

/**
 * Get the UserQuota record for a user, creating one if it doesn't exist.
 */
async function getOrCreateQuota(userId: string) {
  let quota = await prisma.userQuota.findUnique({ where: { userId } });

  if (!quota) {
    // userId is @unique, so concurrent first-readers race; skipDuplicates makes
    // the loser a no-op instead of throwing P2002 (which surfaced as a 500 on
    // this read-only endpoint).
    await prisma.userQuota
      .createMany({
        data: [{ userId, requestsToday: 0, dailyLimit: FREE_TIER.DAILY_LIMIT, tier: "free" }],
        skipDuplicates: true,
      })
      .catch(() => {});
    quota = await prisma.userQuota.findUnique({ where: { userId } });
  }
  if (!quota) {
    // Row could not be materialised (DB read-only). Answer from constants
    // rather than throwing: this endpoint is display-only.
    return {
      userId,
      requestsToday: 0,
      dailyLimit: FREE_TIER.DAILY_LIMIT,
      tier: "free",
      lastResetAt: new Date(),
    } as Awaited<ReturnType<typeof prisma.userQuota.findUnique>> & object;
  }

  // Reset if the quota window has rolled over to a new day
  const quotaDay = quota.lastResetAt.toISOString().slice(0, 10);
  if (quotaDay !== today()) {
    quota = await prisma.userQuota.update({
      where: { userId },
      data: { requestsToday: 0, lastResetAt: new Date() },
    });
  }

  return quota;
}

/**
 * Get current usage for a user today.
 */
export async function getUsage(userId: string): Promise<UsageRecord> {
  const quota = await getOrCreateQuota(userId);
  return {
    userId,
    date: today(),
    requestsToday: quota.requestsToday,
    tier: quota.tier,
  };
}

/**
 * Check if user has remaining quota (delegates to rate-limiter).
 */
export async function hasQuota(
  userId: string,
  tier: Tier = "free",
): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const limits = tier === "free" ? FREE_TIER : PRO_TIER;
  const quota = await getOrCreateQuota(userId);
  const result = checkUserQuota(userId, quota);
  // The `tier` argument used to be computed into `limits` and then discarded,
  // so PRO_TIER.DAILY_LIMIT (Infinity) never applied and the caller got the DB
  // row's limit regardless of the tier it asked about. Report the tier's limit
  // when the row has none, so the parameter means what it says.
  const limit = quota.dailyLimit ?? limits.DAILY_LIMIT;
  return {
    allowed: result.allowed || limits.DAILY_LIMIT === Infinity,
    remaining: limits.DAILY_LIMIT === Infinity ? Number.MAX_SAFE_INTEGER : Math.max(0, limit - result.remaining),
    limit: limits.DAILY_LIMIT === Infinity ? Number.MAX_SAFE_INTEGER : limit,
  };
}

/**
 * Increment usage count for a user (delegates to rate-limiter).
 */
export async function incrementUsage(userId: string, _tokens: number = 0): Promise<void> {
  await incrementUserQuota(userId);
}

/**
 * Check if a model is allowed for the user's tier.
 */
export function isModelAllowed(model: string, tier: Tier): boolean {
  if (tier === "pro" || tier === "team") return true;
  return (FREE_TIER.ALLOWED_MODELS as readonly string[]).includes(model);
}

/**
 * Get tier limits for display.
 */
export function getTierLimits(tier: Tier) {
  switch (tier) {
    case "free":
      return FREE_TIER;
    case "pro":
    case "team":
      return PRO_TIER;
  }
}
