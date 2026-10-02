"use client";

import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api-base";

interface ExecutorStatus {
  running: boolean;
  startedAt: string | null;
  lastPollAt: string | null;
  inFlight: number;
  claimed: number;
  completed: number;
  failed: number;
}

interface SystemData {
  process: {
    uptimeSeconds: number;
    pid: number;
    nodeVersion: string;
    platform: string;
    memory: { rssBytes: number; heapUsedBytes: number };
  };
  env: { serverExecutorEnabled: boolean; maxConcurrentRuns: number; provider: string };
  executor: ExecutorStatus;
  backup: {
    pgDump: { available: boolean; source: string };
    databaseConfigured: boolean;
    lastBackup: { filename: string; sizeBytes: number; createdAt: string } | null;
    backupCount: number;
    totalSizeBytes: number;
    lastBackupAt: string | null;
    lastBackupError: string | null;
    retention?: { maxStaleHours: number; maxTotalMB: number; warnings: { kind: string; message: string }[] };
  };
  cron: { scheduled: boolean; lastResetAt: string | null; nextResetAt: string | null };
  workspaces: { fallbackCount: number; lastFallbackAt: string | null; lastFallbackReason: string | null };
  hardware: {
    pressure: string;
    lastCheckAt: string | null;
    usedRatio: number;
    rssBytes: number;
    freememBytes: number;
    totalBytes: number;
    paused: boolean;
    lastAction: string | null;
    thresholds: { elevated: number; high: number; critical: number };
  };
  janitor: {
    lastSweepAt: string | null;
    lastResult: { candidates: number; deleted: number; bytesFreed: number; skipped: string[] } | null;
    running: boolean;
  };
  pacer: { budgetPerMinute: number; available: number; queueDepth: number; totalWaitedMs: number; totalAcquired: number };
  autoCheckpoint?: {
    enabled: boolean;
    cooldownMs: number;
    cooldownDefault: number;
    maxPerRun: number;
    maxPerRunDefault: number;
    totalLast24h: number;
    autoLast24h: number;
    latestRunId: string | null;
    latestRunCount: number;
    ramPaused: boolean;
    pressure: string;
  };
  logs: { ts: string; component: string; level: string; message: string }[];
  logBuffered: number;
}

function fmtMB(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "—";
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

const DOT: Record<string, string> = { ok: "#22c55e", warn: "#f59e0b", bad: "#ef4444", idle: "#a1a1aa" };

function Dot({ tone }: { tone: keyof typeof DOT | string }) {
  return <span style={{ color: DOT[tone] || DOT.idle, fontSize: 14, marginRight: 6 }}>●</span>;
}

function Row({ label, tone, value }: { label: string; tone?: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 0" }}>
      {tone && <Dot tone={tone} />}
      <span className="admin-muted">{label}:</span>
      <span style={{ fontWeight: tone === "bad" ? 700 : 400 }}>{value}</span>
    </div>
  );
}

export default function SystemPage() {
  const [data, setData] = useState<SystemData | null>(null);
  const [error, setError] = useState("");
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  // Hooks stay ABOVE the early returns below — conditional hooks are illegal.
  const [sweepMsg, setSweepMsg] = useState("");
  const [sweepBusy, setSweepBusy] = useState(false);

  const fetchSystem = useCallback(async () => {
    try {
      const res = await apiFetch("/api/admin/system");
      const json = await res.json();
      if (res.ok && json.success) {
        setData(json);
        setError("");
        setLastRefresh(new Date());
      } else {
        setError(json.error || `HTTP ${res.status}`);
      }
    } catch {
      setError("Network error");
    }
  }, []);

  useEffect(() => {
    fetchSystem();
    const iv = setInterval(fetchSystem, 10_000);
    return () => clearInterval(iv);
  }, [fetchSystem]);

  if (error && !data) return <div style={{ padding: 40, fontFamily: "'JetBrains Mono', monospace", color: "red" }}>{error}</div>;
  if (!data) return <div style={{ padding: 40, fontFamily: "'JetBrains Mono', monospace" }}>Loading system status...</div>;

  const { process, executor, backup, cron, workspaces, hardware, janitor, pacer, env, logs, autoCheckpoint } = data;
  const executorTone = executor.running ? (hardware.paused ? "warn" : "ok") : "bad";
  const backupTone = !backup.pgDump.available ? "warn" : backup.lastBackupError ? "bad" : backup.lastBackup ? "ok" : "idle";
  const cronTone = cron.scheduled ? "ok" : "warn";
  const workspaceTone = workspaces.fallbackCount > 0 ? "bad" : "ok";
  const hardwareTone = hardware.pressure === "critical" ? "bad" : hardware.pressure === "high" ? "warn" : "ok";

  const runSweep = async (mode: "full" | "critical") => {
    setSweepBusy(true);
    setSweepMsg("Sweeping...");
    try {
      const res = await apiFetch("/api/admin/janitor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
      const d = await res.json();
      setSweepMsg(d.success ? `✓ ${d.result.deleted}/${d.result.candidates} removed · ${(d.result.bytesFreed / 1024 / 1024).toFixed(1)} MB freed` : `✗ ${d.error}`);
      fetchSystem();
    } catch {
      setSweepMsg("Network error");
    }
    setSweepBusy(false);
  };

  return (
    <div style={{ padding: 24, fontFamily: "'JetBrains Mono', monospace", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>System</h1>
        <span className="admin-muted" style={{ fontSize: 11 }}>
          auto-refresh 10s{lastRefresh ? ` · updated ${lastRefresh.toLocaleTimeString()}` : ""}
          {error ? ` · ${error}` : ""}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        {/* Process */}
        <div className="admin-panel">
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Process</h2>
          <Row label="Node" value={process.nodeVersion} />
          <Row label="Platform" value={process.platform} />
          <Row label="PID" value={String(process.pid)} />
          <Row label="Uptime" value={fmtUptime(process.uptimeSeconds)} />
          <Row label="Memory (RSS)" value={fmtMB(process.memory.rssBytes)} />
          <Row label="Heap used" value={fmtMB(process.memory.heapUsedBytes)} />
          <Row label="Provider" value={env.provider} />
          <Row label="Run concurrency" value={String(env.maxConcurrentRuns)} />
        </div>

        {/* Executor */}
        <div className="admin-panel">
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
            <Dot tone={executorTone} />
            Run Executor
          </h2>
          <Row tone={executorTone} label="Status" value={executor.running ? (env.serverExecutorEnabled ? "running" : "running (env flag off — legacy boot)") : "not running"} />
          <Row label="Started" value={fmtAgo(executor.startedAt)} />
          <Row label="Last poll" value={executor.running ? fmtAgo(executor.lastPollAt) : "—"} />
          <Row label="In flight" value={`${executor.inFlight} / ${env.maxConcurrentRuns}`} />
          <Row label="Claimed / completed / failed" value={`${executor.claimed} / ${executor.completed} / ${executor.failed}`} />
          <div className="admin-muted" style={{ marginTop: 8 }}>
            Leases queued runs and executes them in isolated git worktrees (ORPLEX_SERVER_EXECUTOR=1).
          </div>
        </div>

        {/* Backups */}
        <div className="admin-panel">
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
            <Dot tone={backupTone} />
            Database Backups
          </h2>
          <Row
            tone={backupTone}
            label="pg_dump"
            value={backup.pgDump.available ? `available (${backup.pgDump.source})` : "not found — run npm run db:pgdump"}
          />
          <Row label="Last successful" value={backup.lastBackup ? `${fmtAgo(backup.lastBackupAt)} · ${fmtMB(backup.lastBackup.sizeBytes)}` : "never"} />
          {backup.lastBackupError && <Row tone="bad" label="Last error" value={backup.lastBackupError} />}
          <Row label="Files" value={`${backup.backupCount} · ${fmtMB(backup.totalSizeBytes)} total`} />
          {backup.retention?.warnings.map((w) => (
            <Row key={w.kind} tone="warn" label="Retention" value={w.message} />
          ))}
          <div className="admin-muted" style={{ marginTop: 8 }}>
            Daily cron at boot + manual trigger on the <a href="/admin" style={{ color: "#a04100" }}>dashboard</a>. Restore: pg_restore.
          </div>
        </div>

        {/* Cron */}
        <div className="admin-panel">
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
            <Dot tone={cronTone} />
            Daily Reset Cron
          </h2>
          <Row tone={cronTone} label="Status" value={cron.scheduled ? "scheduled" : "not scheduled"} />
          <Row label="Next reset" value={cron.nextResetAt ? new Date(cron.nextResetAt).toLocaleString() : "—"} />
          <Row label="Last completed" value={cron.lastResetAt ? fmtAgo(cron.lastResetAt) : "— (resets at first midnight UTC after boot)"} />
          <div className="admin-muted" style={{ marginTop: 8 }}>
            Resets per-key usage counters at midnight UTC (advisory-locked across instances).
          </div>
        </div>
        {/* Workspaces (parallel-workspaces isolation) */}
        <div className="admin-panel">
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
            <Dot tone={workspaceTone} />
            Parallel Workspaces
          </h2>
          <Row
            tone={workspaceTone}
            label="Worktree fallbacks"
            value={workspaces.fallbackCount > 0 ? `${workspaces.fallbackCount} (degraded to copy)` : "none"}
          />
          {workspaces.lastFallbackAt && (
            <Row tone="bad" label="Last fallback" value={`${fmtAgo(workspaces.lastFallbackAt)} — ${workspaces.lastFallbackReason ?? "unknown"}`} />
          )}
          <div className="admin-muted" style={{ marginTop: 8 }}>
            Agent workspaces normally use git worktrees. A fallback means that failed and a full directory copy was used instead — merge semantics and disk cost differ.
          </div>
        </div>

        {/* Memory & hardware pressure (8GB machine guardrails) */}
        <div className="admin-panel">
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
            <Dot tone={hardwareTone} />
            Memory Pressure
          </h2>
          <Row tone={hardwareTone} label="Pressure" value={`${hardware.pressure} (${Math.round(hardware.usedRatio * 100)}% used)`} />
          <Row label="System free" value={hardware.freememBytes ? `${fmtMB(hardware.freememBytes)} of ${fmtMB(hardware.totalBytes)}` : "—"} />
          <Row label="Server RSS" value={fmtMB(hardware.rssBytes)} />
          <Row
            tone={hardware.paused ? "warn" : undefined}
            label="Run claiming"
            value={hardware.paused ? `paused — ${hardware.lastAction ?? "pressure"}` : "normal"}
          />
          <div className="admin-muted" style={{ marginTop: 8 }}>
            Watchdog ladder: amber ≥{Math.round(hardware.thresholds.elevated * 100)}% · pause + no browser lanes ≥{Math.round(hardware.thresholds.high * 100)}% · critical actions (janitor, lane kill) ≥{Math.round(hardware.thresholds.critical * 100)}% sustained.
          </div>
        </div>

        {/* Memory janitor */}
        <div className="admin-panel">
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
            <Dot tone={janitor.running ? "warn" : "ok"} />
            Memory Janitor
          </h2>
          <Row label="Last sweep" value={janitor.lastSweepAt ? fmtAgo(janitor.lastSweepAt) : "never"} />
          <Row
            label="Last result"
            value={janitor.lastResult ? `${janitor.lastResult.deleted}/${janitor.lastResult.candidates} removed · ${(janitor.lastResult.bytesFreed / 1024 / 1024).toFixed(1)} MB${janitor.lastResult.skipped.length ? ` · ${janitor.lastResult.skipped.length} skipped` : ""}` : "—"}
          />
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button
              onClick={() => runSweep("full")}
              disabled={sweepBusy}
              style={{ background: "#a04100", color: "#fff", border: "none", borderRadius: 4, padding: "5px 10px", cursor: sweepBusy ? "wait" : "pointer", fontSize: 11 }}
            >
              Clean up now
            </button>
            <button
              onClick={() => runSweep("critical")}
              disabled={sweepBusy}
              style={{ background: "#555", color: "#fff", border: "none", borderRadius: 4, padding: "5px 10px", cursor: sweepBusy ? "wait" : "pointer", fontSize: 11 }}
            >
              Cache-only sweep
            </button>
          </div>
          {sweepMsg && <div style={{ marginTop: 8, color: sweepMsg.startsWith("✓") ? "green" : "red" }}>{sweepMsg}</div>}
          <div className="admin-muted" style={{ marginTop: 8 }}>
            Whitelist-only: .next cache, node_modules/.cache, docs build, oversized logs, &gt;24h-orphaned worktrees. NEVER touches backups/, .env, .git, src/, .localpg, or the database.
          </div>
        </div>

        {/* TPM pacer / run lane (parallel-run enabler) */}
        <div className="admin-panel">
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
            <Dot tone={pacer.queueDepth > 0 ? "warn" : "ok"} />
            TPM Pacer
          </h2>
          <Row label="Budget" value={`${pacer.budgetPerMinute.toLocaleString()} tokens/min`} />
          <Row
            tone={pacer.available < pacer.budgetPerMinute / 4 ? "warn" : undefined}
            label="Bucket"
            value={`${pacer.available.toLocaleString()} available (burst ${Math.round(pacer.budgetPerMinute / 2).toLocaleString()})`}
          />
          <Row tone={pacer.queueDepth > 0 ? "warn" : undefined} label="Queue" value={`${pacer.queueDepth} waiting`} />
          <Row label="Acquired total" value={pacer.totalAcquired.toLocaleString()} />
          <Row label="Total waited" value={`${(pacer.totalWaitedMs / 1000).toFixed(1)}s`} />
          <div className="admin-muted" style={{ marginTop: 8 }}>
            One account-wide token bucket shared by every run — parallel runs split the {pacer.budgetPerMinute.toLocaleString()}/min free-tier budget deterministically instead of 429-cascading. ORPLEX_TPM_BUDGET overrides.
          </div>
        </div>

        {/* Auto-checkpoint health (rewind granularity + queue headroom) */}
        {autoCheckpoint && (
          <div className="admin-panel">
            <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
              <Dot
                tone={
                  !autoCheckpoint.enabled
                    ? "idle"
                    : autoCheckpoint.ramPaused
                    ? "warn"
                    : autoCheckpoint.latestRunCount >= autoCheckpoint.maxPerRun
                    ? "warn"
                    : "ok"
                }
              />
              Auto Checkpoints
            </h2>
            <Row
              label="Checkpoints this run"
              value={`${autoCheckpoint.latestRunCount} taken${autoCheckpoint.latestRunId ? ` (run ${autoCheckpoint.latestRunId.slice(-6)})` : ""}`}
            />
            <Row
              tone={
                autoCheckpoint.latestRunCount >= autoCheckpoint.maxPerRun
                  ? "bad"
                  : autoCheckpoint.maxPerRun - autoCheckpoint.latestRunCount <= 3
                  ? "warn"
                  : undefined
              }
              label="Cap headroom"
              value={
                autoCheckpoint.latestRunCount >= autoCheckpoint.maxPerRun
                  ? `0 of ${autoCheckpoint.maxPerRun} — cap latched for this run`
                  : `${autoCheckpoint.maxPerRun - autoCheckpoint.latestRunCount} of ${autoCheckpoint.maxPerRun} remaining`
              }
            />
            <Row
              label="Cooldown"
              value={`${(autoCheckpoint.cooldownMs / 1000).toFixed(0)}s per file · skipped while the diff is under 50KB${autoCheckpoint.cooldownMs !== autoCheckpoint.cooldownDefault ? " (custom interval)" : " (default)"}`}
            />
            <Row
              tone={autoCheckpoint.ramPaused ? "warn" : undefined}
              label="RAM pause"
              value={
                !autoCheckpoint.enabled
                  ? "n/a — gate off"
                  : autoCheckpoint.ramPaused
                  ? `paused — watchdog pressure ${autoCheckpoint.pressure}`
                  : `active (pressure ${autoCheckpoint.pressure})`
              }
            />
            <Row label="Last 24h" value={`${autoCheckpoint.totalLast24h} total · ${autoCheckpoint.autoLast24h} auto`} />
            <div className="admin-muted" style={{ marginTop: 8 }}>
              Pre-write checkpoints land before every agent file write and are restorable from the run timeline rewind button. Small edits (under 50KB since the last checkpoint) skip the cooldown — git tree-commits make tiny diffs nearly free — while large rewrites wait out the interval. The gate pauses automatically under RAM pressure; ORPLEX_AUTO_CHECKPOINTS=0 and ORPLEX_AUTO_CHECKPOINT_MAX_PER_RUN / _COOLDOWN_MS / _DELTA_BYTES tune or disable it.
            </div>
          </div>
        )}
      </div>

      {/* Runtime log */}
      <div style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>
          Runtime Log <span className="admin-muted" style={{ fontSize: 11 }}>({data.logs.length} shown · {data.logBuffered} buffered in this process)</span>
        </h2>
        <div style={{ background: "#18181b", color: "#d4d4d8", borderRadius: 8, padding: 12, fontSize: 11, maxHeight: 360, overflowY: "auto" }}>
          {logs.length === 0 ? (
            <div style={{ color: "#71717a" }}>No runtime events yet in this process — entries appear as the executor claims/completes runs and backups run.</div>
          ) : (
            logs.map((l, i) => (
              <div key={`${l.ts}-${i}`} style={{ display: "flex", gap: 8, padding: "2px 0", color: l.level === "error" ? "#f87171" : l.level === "warn" ? "#fbbf24" : undefined }}>
                <span style={{ color: "#71717a", flexShrink: 0 }}>{new Date(l.ts).toLocaleTimeString()}</span>
                <span style={{ color: "#a78bfa", flexShrink: 0, width: 64 }}>{l.component}</span>
                <span style={{ overflowWrap: "anywhere" }}>{l.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
