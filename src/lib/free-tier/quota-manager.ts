// quota-manager.ts — Free tier constants and high-level quota API
// Delegates actual enforcement to rate-limiter.ts (single source of truth)

import { prisma } from "../prisma";
import { checkUserQuota, incrementUserQuota } from "../rate-limiter";

// ---------------------------------------------------------------------------
// Tier Limits
// ---------------------------------------------------------------------------

export const FREE_TIER = {
  /** Max requests per day for free users */
  DAILY_LIMIT: 50,
  /** Max tokens per prompt */
  MAX_TOKENS_PER_PROMPT: 4096,
  /** Allowed models (free tier only gets M3) */
  ALLOWED_MODELS: ["minimax-m3"] as const,
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
 * Get today's date as YYYY-MM-DD string
 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Get the UserQuota record for a user, creating one if it doesn't exist.
 */
async function getOrCreateQuota(userId: string) {
  let quota = await prisma.userQuota.findUnique({ where: { userId } });

  if (!quota) {
    quota = await prisma.userQuota.create({
      data: {
        userId,
        requestsToday: 0,
        dailyLimit: FREE_TIER.DAILY_LIMIT,
        tier: "free",
      },
    });
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
  return result;
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
