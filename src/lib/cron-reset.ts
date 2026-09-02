import { resetDailyCounts } from "./key-pool";
import { prisma } from "./prisma";

let cronStarted = false;

/**
 * Try to acquire a distributed lock using PostgreSQL advisory lock.
 * Returns true if this instance acquired the lock, false if another instance holds it.
 * This prevents multiple server instances from running the same cron job.
 */
async function tryAdvisoryLock(lockId: number): Promise<boolean> {
  try {
    const result = await prisma.$queryRaw<[{ locked: boolean }]>`
      SELECT pg_try_advisory_lock(${lockId}) AS locked
    `;
    return result[0]?.locked === true;
  } catch {
    // If DB is unavailable, fall back to in-memory lock (single instance mode)
    return true;
  }
}

/**
 * Start the daily reset cron.
 * Runs at midnight UTC to reset all usage counters.
 * Uses PostgreSQL advisory lock to prevent double-runs in multi-instance deployments.
 */
export function startDailyResetCron(): void {
  if (cronStarted) return;
  cronStarted = true;

  // Calculate ms until next midnight UTC
  function getMsUntilMidnight(): number {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    return midnight.getTime() - now.getTime();
  }

  function scheduleNext() {
    const delay = getMsUntilMidnight();
    setTimeout(async () => {
      try {
        // Only one instance in a multi-instance deployment runs the reset
        const acquired = await tryAdvisoryLock(7777);
        if (!acquired) {
          console.log("[cron] Another instance holds the lock — skipping daily reset.");
        } else {
          console.log("[cron] Resetting daily usage counters...");
          await resetDailyCounts();
          console.log("[cron] Daily reset complete.");
        }
      } catch (err) {
        console.error("[cron] Daily reset failed:", err);
      }
      scheduleNext(); // Schedule next midnight
    }, delay);
  }

  scheduleNext();
  console.log(`[cron] Daily reset scheduled in ${Math.round(getMsUntilMidnight() / 3600000)}h`);
}
