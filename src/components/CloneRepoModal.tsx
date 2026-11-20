"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { useToast } from "@/components/Toast";

export default function CloneRepoModal({
  open,
  onClose,
  onCloned,
}: {
  open: boolean;
  onClose: () => void;
  onCloned: (path: string, name: string) => void;
}) {
  const { toast } = useToast();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async () => {
    if (!url.trim()) { setError("Repository URL is required"); return; }
    setBusy(true); setError(null);
    try {
      const res = await apiFetch("/api/repos/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), branch: branch.trim() || undefined, token: token.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        setError(data?.error || `Clone failed (HTTP ${res.status})`);
        return;
      }
      toast(`Cloned ${data.name}`, "success");
      onCloned(data.path, data.name);
      setUrl(""); setBranch(""); setToken("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Clone failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3>Clone GitHub repository</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label>
            <span style={{ fontSize: 12, opacity: 0.7 }}>Repository URL</span>
            <input
              className="settings-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              autoFocus
            />
          </label>
          <label>
            <span style={{ fontSize: 12, opacity: 0.7 }}>Branch (optional)</span>
            <input
              className="settings-input"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
            />
          </label>
          <label>
            <span style={{ fontSize: 12, opacity: 0.7 }}>Personal access token (optional, for private repos)</span>
            <input
              className="settings-input"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_…"
            />
          </label>
          {error && <div style={{ color: "#e5484d", fontSize: 12 }}>{error}</div>}
          <div style={{ fontSize: 11, opacity: 0.6 }}>
            If you linked GitHub in Settings, your OAuth token is used automatically for private repos.
          </div>
        </div>
        <div className="modal-footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button className="modal-cancel-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="modal-submit-btn" onClick={() => void submit()} disabled={busy}>
            {busy ? "Cloning…" : "Clone"}
          </button>
        </div>
      </div>
    </div>
  );
}