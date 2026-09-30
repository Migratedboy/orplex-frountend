import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getProviderHealth } from "@/lib/circuit-breaker";
import { getPoolSummary } from "@/lib/key-pool";
import { getBackupStatus, getBackupRuntime, getVendorStatus } from "@/lib/backup";

export async function GET() {
  try {
    await requireAdmin();
    const health = await getProviderHealth();
    const summary = await getPoolSummary();
    const [backupStatus, vendorStatus] = await Promise.all([getBackupStatus(), getVendorStatus()]);
    const backupRuntime = getBackupRuntime();

    // Group keys by provider for health view
    const byProvider: Record<string, any> = {};
    for (const key of summary.keys) {
      if (!byProvider[key.provider]) {
        byProvider[key.provider] = {
          name: key.provider,
          status: "healthy",
          activeKeys: 0,
          totalUsageToday: 0,
        };
      }
      if (key.isActive) byProvider[key.provider].activeKeys++;
      byProvider[key.provider].totalUsageToday += key.usageToday;
    }

    // Merge circuit breaker status
    for (const h of health) {
      if (byProvider[h.name]) {
        byProvider[h.name].status = h.status;
        byProvider[h.name].failures = h.failures;
      }
    }

    return NextResponse.json({
      providers: Object.values(byProvider),
      circuitBreakers: health,
      // Whole-ops picture: pg_dump availability (incl. what the postinstall
      // vendor script last did — it runs outside this process, so its status
      // arrives via .localpg/pg-dump-status.json) + daily backup cron state.
      dbBackups: {
        healthy: backupStatus.pgDump.available && backupStatus.databaseConfigured,
        databaseConfigured: backupStatus.databaseConfigured,
        pgDump: backupStatus.pgDump,
        cron: {
          running: backupRuntime.cronRunning,
          lastTickAt: backupRuntime.lastCronTickAt,
          lastBackupAt: backupRuntime.lastBackupAt,
          lastBackupOutcome: backupRuntime.lastBackupOutcome,
          lastBackupMessage: backupRuntime.lastBackupMessage,
          lastBackupError: backupRuntime.lastBackupError,
        },
        lastBackup: backupStatus.lastBackup,
        backupCount: backupStatus.backupCount,
        totalSizeBytes: backupStatus.totalSizeBytes,
        retention: backupStatus.retention,
        vendorScript: vendorStatus,
      },
    });
  } catch (err: any) {
    const status = err.message === "Unauthorized" ? 401 : err.message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
