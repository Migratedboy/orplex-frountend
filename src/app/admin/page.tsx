"use client";

import { useState, useEffect } from "react";

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
        fetch("/api/admin/keys"),
        fetch("/api/admin/usage"),
        fetch("/api/admin/backups"),
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
      const res = await fetch("/api/admin/keys", {
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
    await fetch("/api/admin/keys", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, isActive: !isActive }),
    });
    fetchData();
  };

  const deleteKey = async (id: string) => {
    if (!confirm("Delete this key?")) return;
    await fetch(`/api/admin/keys?id=${id}`, { method: "DELETE" });
    fetchData();
  };

  const fmtMB = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

  const triggerBackup = async () => {
    setBackupBusy(true);
    setBackupMsg("Backing up...");
    try {
      const res = await fetch("/api/admin/backups", { method: "POST" });
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

  if (loading) return <div style={{ padding: 40, fontFamily: "monospace" }}>Loading admin dashboard...</div>;
  if (error) return <div style={{ padding: 40, color: "red" }}>{error}</div>;

  return (
    <div style={{ padding: 24, fontFamily: "'JetBrains Mono', monospace", maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Admin Dashboard</h1>
        <a href="/admin/system" style={{ fontSize: 12, color: "#a04100" }}>System status →</a>
      </div>

      {/* Summary Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
        {[
          { label: "Requests Today", value: summary?.totalUsageToday || 0 },
          { label: "Active Keys", value: summary?.activeKeys || 0 },
          { label: "Capacity", value: `${summary?.utilizationPercent || 0}%` },
          { label: "Unique Users", value: usage?.today.uniqueUsers || 0 },
        ].map((card) => (
          <div key={card.label} style={{ background: "#f9f9fa", border: "1px solid #e4e4e7", borderRadius: 8, padding: 16 }}>
            <div style={{ fontSize: 10, color: "#999", textTransform: "uppercase" }}>{card.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{card.value}</div>
          </div>
        ))}
      </div>

      {/* Key Pool */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, margin: 0 }}>Key Pool</h2>
          <button onClick={() => setShowAdd(!showAdd)} style={{ background: "#a04100", color: "#fff", border: "none", borderRadius: 4, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>
            + Add Key
          </button>
        </div>

        {/* Add Key Form */}
        {showAdd && (
          <div style={{ background: "#f9f9fa", border: "1px solid #e4e4e7", borderRadius: 8, padding: 16, marginBottom: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
              <select value={newKey.provider} onChange={e => setNewKey({ ...newKey, provider: e.target.value })} style={{ padding: 6, fontSize: 12, borderRadius: 4, border: "1px solid #e4e4e7" }}>
                <option value="nvidia">NVIDIA</option>
                <option value="openrouter">OpenRouter</option>
              </select>
              <input placeholder="API Key" value={newKey.apiKey} onChange={e => setNewKey({ ...newKey, apiKey: e.target.value })} style={{ padding: 6, fontSize: 12, borderRadius: 4, border: "1px solid #e4e4e7" }} />
              <input placeholder="Model" value={newKey.model} onChange={e => setNewKey({ ...newKey, model: e.target.value })} style={{ padding: 6, fontSize: 12, borderRadius: 4, border: "1px solid #e4e4e7" }} />
              <button onClick={addKey} style={{ background: "#a04100", color: "#fff", border: "none", borderRadius: 4, padding: 6, cursor: "pointer", fontSize: 12 }}>Add</button>
            </div>
            {addStatus && <div style={{ fontSize: 11, color: addStatus.includes("success") ? "green" : "red" }}>{addStatus}</div>}
          </div>
        )}

        {/* Keys Table */}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #e4e4e7", textAlign: "left" }}>
              <th style={{ padding: "8px 4px" }}>Provider</th>
              <th style={{ padding: "8px 4px" }}>Model</th>
              <th style={{ padding: "8px 4px" }}>Usage</th>
              <th style={{ padding: "8px 4px" }}>Priority</th>
              <th style={{ padding: "8px 4px" }}>Status</th>
              <th style={{ padding: "8px 4px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map(key => (
              <tr key={key.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: "8px 4px" }}>{key.provider}</td>
                <td style={{ padding: "8px 4px" }}>{key.model}</td>
                <td style={{ padding: "8px 4px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 60, height: 6, background: "#e4e4e7", borderRadius: 3 }}>
                      <div style={{ width: `${Math.min(100, (key.usageToday / key.dailyLimit) * 100)}%`, height: "100%", background: key.usageToday / key.dailyLimit > 0.8 ? "#ef4444" : key.usageToday / key.dailyLimit > 0.5 ? "#f59e0b" : "#22c55e", borderRadius: 3 }} />
                    </div>
                    <span>{key.usageToday}/{key.dailyLimit}</span>
                  </div>
                </td>
                <td style={{ padding: "8px 4px" }}>{key.priority}</td>
                <td style={{ padding: "8px 4px" }}>
                  <span style={{ color: key.isActive ? "green" : "red" }}>{key.isActive ? "Active" : "Inactive"}</span>
                  {key.failures > 0 && <span style={{ color: "orange", marginLeft: 4 }}>({key.failures} failures)</span>}
                </td>
                <td style={{ padding: "8px 4px" }}>
                  <button onClick={() => toggleKey(key.id, key.isActive)} style={{ background: "none", border: "1px solid #e4e4e7", borderRadius: 3, padding: "2px 8px", cursor: "pointer", fontSize: 11, marginRight: 4 }}>
                    {key.isActive ? "Disable" : "Enable"}
                  </button>
                  <button onClick={() => deleteKey(key.id)} style={{ background: "none", border: "1px solid #fecaca", color: "#ef4444", borderRadius: 3, padding: "2px 8px", cursor: "pointer", fontSize: 11 }}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Database Backups */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, margin: 0 }}>Database Backups</h2>
          <button
            onClick={triggerBackup}
            disabled={backupBusy || (backups !== null && !backups.pgDump.available)}
            style={{ background: "#a04100", color: "#fff", border: "none", borderRadius: 4, padding: "6px 12px", cursor: backupBusy ? "wait" : "pointer", fontSize: 12, opacity: backupBusy || (backups !== null && !backups.pgDump.available) ? 0.6 : 1 }}
          >
            {backupBusy ? "Backing up..." : "Back Up Now"}
          </button>
        </div>
        <div style={{ background: "#f9f9fa", border: "1px solid #e4e4e7", borderRadius: 8, padding: 16, fontSize: 12 }}>
          {backups ? (
            <>
              <div>
                pg_dump:{" "}
                <span style={{ color: backups.pgDump.available ? "green" : "red", fontWeight: 700 }}>
                  {backups.pgDump.available ? `available (${backups.pgDump.source})` : "not found"}
                </span>
                {!backups.databaseConfigured && <span style={{ color: "#b45309" }}> · DATABASE_URL not set</span>}
              </div>
              {backupHint && <div style={{ color: "#b45309", marginTop: 6 }}>{backupHint}</div>}
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
                <div key={w.kind} style={{ marginTop: 8, color: "#b45309", fontWeight: 600 }}>
                  ⚠ {w.message}
                </div>
              ))}
              {backupMsg && <div style={{ marginTop: 8, color: backupMsg.startsWith("✓") ? "green" : "red" }}>{backupMsg}</div>}
              <div style={{ marginTop: 8, fontSize: 11, color: "#666" }}>
                Retention: warn if newest &gt; {backups.retention.maxStaleHours}h
                {backups.retention.maxTotalMB > 0 ? ` · total > ${backups.retention.maxTotalMB} MB (ORPLEX_BACKUP_MAX_TOTAL_MB)` : " · size uncapped (ORPLEX_BACKUP_MAX_TOTAL_MB)"}
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: "#666" }}>
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
          <h2 style={{ fontSize: 14, marginBottom: 12 }}>Today&apos;s Usage</h2>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {Object.entries(usage.today.byProvider).map(([provider, count]) => (
              <div key={provider} style={{ background: "#f9f9fa", border: "1px solid #e4e4e7", borderRadius: 8, padding: 12, minWidth: 120 }}>
                <div style={{ fontSize: 10, color: "#999", textTransform: "uppercase" }}>{provider}</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{count}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: "#666" }}>
            Avg latency: {usage.today.avgLatencyMs}ms | This week: {usage.thisWeek.totalRequests} requests
          </div>
        </div>
      )}
    </div>
  );
}
