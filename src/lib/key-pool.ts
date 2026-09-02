import { prisma } from "./prisma";
import { decryptKey } from "./key-encryption";

export interface PoolKey {
  id: string;
  provider: string;
  model: string;
  apiKey: string; // decrypted
  priority: number;
}

/**
 * Get an available API key from the pool.
 * Priority: highest priority first, then lowest usage.
 * Skips keys that hit daily limit or are inactive.
 */
export async function getAvailableKey(provider?: string): Promise<PoolKey | null> {
  const where: any = { isActive: true };
  if (provider) where.provider = provider;

  const keys = await prisma.apiKeyPool.findMany({
    where,
    orderBy: [{ priority: "desc" }, { usageToday: "asc" }],
  });

  for (const key of keys) {
    if (key.usageToday < key.dailyLimit) {
      try {
        const decrypted = decryptKey(key.apiKey);
        return {
          id: key.id,
          provider: key.provider,
          model: key.model,
          apiKey: decrypted,
          priority: key.priority,
        };
      } catch {
        // Key decryption failed — skip
        continue;
      }
    }
  }

  return null;
}

/**
 * Get the best key for a specific model.
 */
export async function getKeyForModel(model: string): Promise<PoolKey | null> {
  const keys = await prisma.apiKeyPool.findMany({
    where: { isActive: true, model },
    orderBy: [{ priority: "desc" }, { usageToday: "asc" }],
  });

  for (const key of keys) {
    if (key.usageToday < key.dailyLimit) {
      try {
        const decrypted = decryptKey(key.apiKey);
        return {
          id: key.id,
          provider: key.provider,
          model: key.model,
          apiKey: decrypted,
          priority: key.priority,
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Increment usage counter for a key.
 */
export async function incrementKeyUsage(keyId: string): Promise<void> {
  await prisma.apiKeyPool.update({
    where: { id: keyId },
    data: {
      usageToday: { increment: 1 },
      lastUsedAt: new Date(),
    },
  });
}

/**
 * Record a failure for a key. Deactivate after 3 consecutive failures.
 */
export async function recordKeyFailure(keyId: string): Promise<void> {
  const key = await prisma.apiKeyPool.findUnique({ where: { id: keyId } });
  if (!key) return;

  const newFailures = key.failures + 1;
  await prisma.apiKeyPool.update({
    where: { id: keyId },
    data: {
      failures: newFailures,
      isActive: newFailures < 3, // deactivate after 3 failures
    },
  });
}

/**
 * Reset a key's failure count (on successful use).
 */
export async function resetKeyFailures(keyId: string): Promise<void> {
  await prisma.apiKeyPool.update({
    where: { id: keyId },
    data: { failures: 0 },
  });
}

/**
 * Reset all daily usage counters (run at midnight UTC).
 */
export async function resetDailyCounts(): Promise<void> {
  await prisma.apiKeyPool.updateMany({
    data: { usageToday: 0, lastResetAt: new Date() },
  });

  await prisma.userQuota.updateMany({
    data: { requestsToday: 0, lastResetAt: new Date() },
  });
}

/**
 * Get pool summary stats.
 */
export async function getPoolSummary() {
  const keys = await prisma.apiKeyPool.findMany({
    orderBy: { createdAt: "desc" },
  });

  const active = keys.filter(k => k.isActive);
  const totalUsage = active.reduce((sum, k) => sum + k.usageToday, 0);
  const totalCapacity = active.reduce((sum, k) => sum + k.dailyLimit, 0);

  return {
    totalKeys: keys.length,
    activeKeys: active.length,
    totalUsageToday: totalUsage,
    totalCapacity,
    utilizationPercent: totalCapacity > 0 ? Math.round((totalUsage / totalCapacity) * 100) : 0,
    keys: keys.map(k => ({
      id: k.id,
      provider: k.provider,
      model: k.model,
      usageToday: k.usageToday,
      dailyLimit: k.dailyLimit,
      priority: k.priority,
      isActive: k.isActive,
      failures: k.failures,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
    })),
  };
}
