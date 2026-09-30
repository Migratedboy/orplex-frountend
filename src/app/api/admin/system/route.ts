import { NextResponse } from "next/server";
import os from "os";
import { requireAdmin } from "@/lib/admin-auth";
import { getExecutorStatus } from "@/lib/server-executor/executor";
import { maxConcurrentRuns } from "@/lib/server-executor/executor-config";
import { runtimeState } from "@/lib/runtime-state";
import { getBackupStatus } from "@/lib/backup";
import { getRuntimeLogs, runtimeLogCount } from "@/lib/runtime-log";
import { getHardwareStatus } from "@/lib/hardware";
import { getJanitorStatus } from "@/lib/janitor";
import { getPacerState } from "@/lib/tpm-pacer";
import { prisma } from "@/lib/prisma";
import {
  AUTO_CP_COOLDOWN_MS_DEFAULT,
  AUTO_CP_MAX_PER_RUN_DEFAULT,
  autoCpCooldownMs,
  autoCpMaxPerRun,
  autoCheckpointsEnabled,
} from "@/lib/auto-checkpoint";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/system — one snapshot for the admin System page.
 *
 * Everything here is read from the live process (executor state machine,
 * backup runtime, cron schedule, event ring buffer) or from `os`. No secrets,
 * no env values — booleans, timestamps, and counters only.
 */
export async function GET() {
  try {
    await requireAdmin();
    const [backup, logs] = await Promise.all([getBackupStatus(), Promise.resolve(getRuntimeLogs(80))]);

    // Auto-checkpoint health: auto vs manual split over the last 24h plus
    // the per-run queue depth for the most recent run. Best-effort — the
    // card degrades to zeros if the DB hiccups.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [total24, auto24, recentRun] = await Promise.all([
      prisma.runCheckpoint.count({ where: { createdAt: { gte: dayAgo } } }).catch(() => 0),
      prisma.runCheckpoint.count({ where: { createdAt: { gte: dayAgo }, label: { startsWith: "auto:" } } }).catch(() => 0),
      prisma.runCheckpoint.findFirst({ orderBy: { createdAt: "desc" }, select: { runId: true } }).catch(() => null),
    ]);
    const latestRunCount = recentRun
      ? await prisma.runCheckpoint.count({ where: { runId: recentRun.runId } }).catch(() => 0)
      : 0;
    // The gate's live RAM-pause state comes straight from the watchdog —
    // the SAME signal that pauses run claiming and browser lanes.
    const hw = getHardwareStatus();
    const ramPaused = autoCheckpointsEnabled() && (hw.pressure === "high" || hw.pressure === "critical");

    return NextResponse.json({
      success: true,
      process: {
        uptimeSeconds: Math.floor(process.uptime()),
        pid: process.pid,
        nodeVersion: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        memory: {
          rssBytes: process.memoryUsage().rss,
          heapUsedBytes: process.memoryUsage().heapUsed,
        },
      },
      // Read cron/backup-runtime straight from the shared singleton: the
      // getters on those modules would resolve to THIS bundle's copy in dev.
      executor: getExecutorStatus(),
      // Known-safe mode flags (booleans/enums only — never raw env values).
      env: {
        serverExecutorEnabled:
          process.env.ORPLEX_SERVER_EXECUTOR === "1" || process.env.ORPLEX_SERVER_EXECUTOR === "true",
        maxConcurrentRuns: maxConcurrentRuns(process.env.ORPLEX_MAX_CONCURRENT_RUNS),
        provider: process.env.AI_PROVIDER || "nvidia",
      },
      backup: {
        ...backup,
        lastBackupAt: runtimeState.backup.lastBackupAt,
        lastBackupError: runtimeState.backup.lastBackupError,
      },
      cron: { ...runtimeState.cron },
      workspaces: { ...runtimeState.workspaces },
      hardware: { ...getHardwareStatus(), rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed },
      janitor: getJanitorStatus(),
      pacer: getPacerState(),
      autoCheckpoint: {
        enabled: autoCheckpointsEnabled(),
        cooldownMs: autoCpCooldownMs(),
        cooldownDefault: AUTO_CP_COOLDOWN_MS_DEFAULT,
        maxPerRun: autoCpMaxPerRun(),
        maxPerRunDefault: AUTO_CP_MAX_PER_RUN_DEFAULT,
        totalLast24h: total24,
        autoLast24h: auto24,
        latestRunId: recentRun?.runId ?? null,
        latestRunCount,
        ramPaused,
        pressure: hw.pressure,
      },
      logs,
      logBuffered: runtimeLogCount(),
    });
  } catch (err) {
    const status = err instanceof Error && err.message === "Unauthorized" ? 401 : err instanceof Error && err.message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "Failed" }, { status });
  }
}
