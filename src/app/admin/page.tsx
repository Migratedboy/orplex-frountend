"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api-base";

interface Key {
  id: string;
  provider: string;
  model: string;
  usageToday: number;
  dailyLimit: number;
  priority: number;
  isActive: boolean;
  failures: number;
  lastUsedAt: string | null;
  createdAt: string;
}

interface PoolSummary {
  totalKeys: number;
  activeKeys: number;
  totalUsageToday: number;
  totalCapacity: number;
  utilizationPercent: number;
}

interface UsageStats {
  today: { totalRequests: number; byProvider: Record<string, number>; uniqueUsers: number; avgLatencyMs: number };
  thisWeek: { totalRequests: number };
  topUsers: { userId: string; requests: number }[];
}

interface BackupFile {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

interface BackupStatus {
  pgDump: { available: boolean; source: string };
  databaseConfigured: boolean;
  backupDir: string;
  lastBackup: BackupFile | null;
  backupCount: number;
  totalSizeBytes: number;
  retention: { maxStaleHours: number; maxTotalMB: number; warnings: { kind: string; message: string }[] };
}

export default function AdminPage() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [summary, setSummary] = useState<PoolSummary | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState({ provider: "nvidia", apiKey: "", model: "nvidia/nemotron-3-super-120b-a12b", dailyLimit: 1000, priority: 5 });
  const [addStatus, setAddStatus] = useState("");
  const [backups, setBackups] = useState<BackupStatus | null>(null);
  const [backupHint, setBackupHint] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState("");

  const fetchData = async () => {
    try {
      const [keysRes, usageRes, backupsRes] = await Promise.all([
        apiFetch("/api/admin/keys"),
        apiFetch("/api/admin/usage"),
        apiFetch("/api/admin/backups"),
      ]);
      if (keysRes.ok) {
        const data = await keysRes.json();
        setKeys(data.keys);
        setSummary(data.summary);
      }
      if (usageRes.ok) {
        setUsage(await usageRes.json());
      }
      if (backupsRes.ok) {
        const data = await backupsRes.json();
        setBackups({
          pgDump: data.pgDump,
          databaseConfigured: data.databaseConfigured,
          backupDir: data.backupDir,
          lastBackup: data.lastBackup,
          backupCount: data.backupCount,
          totalSizeBytes: data.totalSizeBytes,
          retention: data.retention ?? { maxStaleHours: 25, maxTotalMB: 0, warnings: [] },
        });
        setBackupHint(data.setupHint ?? null);
      }
    } catch {
      setError("Failed to load admin data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const addKey = async () => {
    setAddStatus("Adding...");
    try {
      const res = await apiFetch("/api/admin/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newKey),
      });
      const data = await res.json();
      if (res.ok) {
        setAddStatus(data.key.message);
        setShowAdd(false);
        setNewKey({ provider: "nvidia", apiKey: "", model: "nvidia/nemotron-3-super-120b-a12b", dailyLimit: 1000, priority: 5 });
        fetchData();
      } else {
        setAddStatus(data.error || "Failed");
      }
    } catch {
      setAddStatus("Network error");
    }
  };

  const toggleKey = async (id: string, isActive: boolean) => {
    await apiFetch("/api/admin/keys", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, isActive: !isActive }),
    });
    fetchData();
  };

  const deleteKey = async (id: string) => {
    if (!confirm("Delete this key?")) return;
    await apiFetch(`/api/admin/keys?id=${id}`, { method: "DELETE" });
    fetchData();
  };

  const fmtMB = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

  const triggerBackup = async () => {
    setBackupBusy(true);
    setBackupMsg("Backing up...");
    try {
      const res = await apiFetch("/api/admin/backups", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        setBackupMsg(`✓ Created ${String(data.backup.path).split(/[\\/]/).pop()} (${fmtMB(data.backup.size)})`);
        setBackups(data.status);
        setBackupHint(null);
      } else {
        setBackupMsg(data.error || "Backup failed");
        if (data.setupHint) setBackupHint(data.setupHint);
      }
    } catch {
      setBackupMsg("Network error");
    }
    setBackupBusy(false);
  };

  if (loading) return <div className="admin-wrap route-loading">Loading admin dashboard...</div>;
  if (error) return <div className="admin-wrap admin-status-err">{error}</div>;

  return (
    <div className="admin-wrap">
      <div className="admin-header">
        <h1 className="admin-h1">Admin Dashboard</h1>
        <a href="/admin/system" className="admin-link">System status →</a>
      </div>

      {/* Summary Cards */}
      <div className="admin-cards">
        {[
          { label: "Requests Today", value: summary?.totalUsageToday || 0 },
          { label: "Active Keys", value: summary?.activeKeys || 0 },
          { label: "Capacity", value: `${summary?.utilizationPercent || 0}%` },
          { label: "Unique Users", value: usage?.today.uniqueUsers || 0 },
        ].map((card) => (
          <div key={card.label} className="admin-card">
            <div className="admin-card-label">{card.label}</div>
            <div className="admin-card-value">{card.value}</div>
          </div>
        ))}
      </div>

      {/* Key Pool */}
      <div className="admin-section">
        <div className="admin-row">
          <h2 className="admin-h2">Key Pool</h2>
          <button className="admin-btn" onClick={() => setShowAdd(!showAdd)}>
            + Add Key
          </button>
        </div>

        {/* Add Key Form */}
        {showAdd && (
          <div className="admin-panel">
            <div className="admin-grid-form">
              <select className="admin-select" value={newKey.provider} onChange={e => setNewKey({ ...newKey, provider: e.target.value })}>
                <option value="nvidia">NVIDIA</option>
                <option value="openrouter">OpenRouter</option>
              </select>
              <input className="admin-input" placeholder="API Key" value={newKey.apiKey} onChange={e => setNewKey({ ...newKey, apiKey: e.target.value })} />
              <input className="admin-input" placeholder="Model" value={newKey.model} onChange={e => setNewKey({ ...newKey, model: e.target.value })} />
              <button className="admin-btn" onClick={addKey}>Add</button>
            </div>
            {addStatus && <div className={`admin-card-label ${addStatus.includes("success") ? "admin-status-ok" : "admin-status-err"}`} style={{ fontSize: 11 }}>{addStatus}</div>}
          </div>
        )}

        {/* Keys Table */}
        <table className="admin-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Model</th>
              <th>Usage</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map(key => (
              <tr key={key.id}>
                <td>{key.provider}</td>
                <td>{key.model}</td>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div className="admin-bar">
                      <div style={{ width: `${key.dailyLimit > 0 ? Math.min(100, (key.usageToday / key.dailyLimit) * 100) : 0}%`, height: "100%", background: key.dailyLimit > 0 && key.usageToday / key.dailyLimit > 0.8 ? "#ef4444" : key.dailyLimit > 0 && key.usageToday / key.dailyLimit > 0.5 ? "#f59e0b" : "#22c55e", borderRadius: 3 }} />
                    </div>
                    <span>{key.usageToday}/{key.dailyLimit}</span>
                  </div>
                </td>
                <td>{key.priority}</td>
                <td>
                  <span style={{ color: key.isActive ? "green" : "red" }}>{key.isActive ? "Active" : "Inactive"}</span>
                  {key.failures > 0 && <span style={{ color: "orange", marginLeft: 4 }}>({key.failures} failures)</span>}
                </td>
                <td>
                  <button className="admin-btn--ghost" style={{ marginRight: 4 }} onClick={() => toggleKey(key.id, key.isActive)}>
                    {key.isActive ? "Disable" : "Enable"}
                  </button>
                  <button className="admin-btn--danger" onClick={() => deleteKey(key.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Database Backups */}
      <div className="admin-section">
        <div className="admin-row">
          <h2 className="admin-h2">Database Backups</h2>
          <button
            className="admin-btn"
            onClick={triggerBackup}
            disabled={backupBusy || (backups !== null && !backups.pgDump.available)}
          >
            {backupBusy ? "Backing up..." : "Back Up Now"}
          </button>
        </div>
        <div className="admin-panel" style={{ marginBottom: 0 }}>
          {backups ? (
            <>
              <div>
                pg_dump:{" "}
                <span style={{ color: backups.pgDump.available ? "green" : "red", fontWeight: 700 }}>
                  {backups.pgDump.available ? `available (${backups.pgDump.source})` : "not found"}
                </span>
                {!backups.databaseConfigured && <span className="admin-warning"> · DATABASE_URL not set</span>}
              </div>
              {backupHint && <div className="admin-warning" style={{ marginTop: 6 }}>{backupHint}</div>}
              <div style={{ marginTop: 8 }}>
                {backups.lastBackup ? (
                  <>
                    Last backup: {new Date(backups.lastBackup.createdAt).toLocaleString()} · {fmtMB(backups.lastBackup.sizeBytes)}
                  </>
                ) : (
                  "No backups yet"
                )}
                {backups.backupCount > 0 && (
                  <span>
                     · {backups.backupCount} file(s) · {fmtMB(backups.totalSizeBytes)} total
                  </span>
                )}
              </div>
              {backups.retention.warnings.map((w) => (
                <div key={w.kind} className="admin-warning" style={{ marginTop: 8, fontWeight: 600 }}>
                  ⚠ {w.message}
                </div>
              ))}
              {backupMsg && <div style={{ marginTop: 8, color: backupMsg.startsWith("✓") ? "green" : "red" }}>{backupMsg}</div>}
              <div className="admin-muted" style={{ marginTop: 8 }}>
                Retention: warn if newest &gt; {backups.retention.maxStaleHours}h
                {backups.retention.maxTotalMB > 0 ? ` · total > ${backups.retention.maxTotalMB} MB (ORPLEX_BACKUP_MAX_TOTAL_MB)` : " · size uncapped (ORPLEX_BACKUP_MAX_TOTAL_MB)"}
              </div>
              <div className="admin-muted" style={{ marginTop: 8 }}>
                Stored in {backups.backupDir} · restore with pg_restore · daily cron at server boot
              </div>
            </>
          ) : (
            "Loading backups..."
          )}
        </div>
      </div>

      {/* Usage by Provider */}
      {usage && (
        <div>
          <h2 className="admin-h2" style={{ marginBottom: 12 }}>Today&apos;s Usage</h2>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {Object.entries(usage.today.byProvider).map(([provider, count]) => (
              <div key={provider} className="admin-card" style={{ padding: 12, minWidth: 120 }}>
                <div className="admin-card-label">{provider}</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{count}</div>
              </div>
            ))}
          </div>
          <div className="admin-muted" style={{ marginTop: 12, fontSize: 12 }}>
            Avg latency: {usage.today.avgLatencyMs}ms | This week: {usage.thisWeek.totalRequests} requests
          </div>
        </div>
      )}
    </div>
  );
}
