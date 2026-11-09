// Settings → Database tab: export / import the whole local database as one
// portable JSON bundle (moved machines? keep your chats, runs, memory).
"use client";

import { useRef, useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { useToast } from "@/components/Toast";

export function SettingsDatabaseTab() {
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const doExport = async () => {
    setExporting(true);
    setLastExport(null);
    try {
      const res = await apiFetch("/api/db/export");
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const blob = await res.blob();
      const name =
        res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ||
        `orplex-db-export-${Date.now()}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setLastExport(name);
      toast("Database exported", "success");
    } catch (e) {
      toast(`Export failed: ${String((e as Error)?.message || e).slice(0, 120)}`, "error");
    } finally {
      setExporting(false);
    }
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    setLastImport(null);
    try {
      const body = await file.text();
      const res = await apiFetch("/api/db/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        total?: number;
        skipped?: string[];
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const skippedMsg =
        data.skipped && data.skipped.length > 0 ? ` (skipped ${data.skipped.length}: ${data.skipped.join(", ")})` : "";
      setLastImport(`${data.total ?? 0} rows restored${skippedMsg}`);
      toast(`Imported ${data.total ?? 0} rows`, "success");
      // The engine resets its in-memory collections on import — a reload
      // re-reads the migrated rows from disk.
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      toast(`Import failed: ${String((e as Error)?.message || e).slice(0, 120)}`, "error");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h2 className="settings-section-title">Database</h2>
        <p className="settings-section-desc">
          Your chats, runs, keys and learning live on this device. Export them as one portable file
          and import on any other machine.
        </p>
      </div>
      <div className="settings-card">
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">Export local database</span>
            <span className="settings-toggle-desc">
              One JSON file with every model — SHA-256 checksummed, portable anywhere.
            </span>
          </div>
          <button onClick={doExport} disabled={exporting} className="settings-save-btn">
            {exporting ? "Exporting…" : "Export .json"}
          </button>
        </div>
        {lastExport && (
          <p className="settings-hint">
            Saved {lastExport}. Store it like a password — it contains your encrypted API keys and full history.
          </p>
        )}
        <div className="settings-divider" />
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">Import database</span>
            <span className="settings-toggle-desc">
              Restores an exported file. Corrupt or forged models are skipped with reasons.
            </span>
          </div>
          <button onClick={() => fileRef.current?.click()} disabled={importing} className="settings-save-btn">
            {importing ? "Importing…" : "Choose file"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => void onPickFile(e.target.files?.[0])}
            aria-hidden="true"
          />
        </div>
        {lastImport && <p className="settings-hint">Last import: {lastImport}</p>}
        <p className="settings-hint">
          Import replaces rows by model checksum — re-running the same file is a no-op for intact data.
        </p>
      </div>
    </div>
  );
}
