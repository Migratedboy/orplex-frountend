"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { useToast } from "@/components/Toast";

export default function NewProjectModal({
  open,
  onClose,
  openFolder,
  onCloned,
}: {
  open: boolean;
  onClose: () => void;
  openFolder: () => void | Promise<void>;
  onCloned?: (path: string, name: string) => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"menu" | "clone">("menu");
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setName("");
    setMode("menu");
    setUrl("");
    setBranch("");
    setToken("");
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleOpenFolder = async () => {
    await openFolder();
    handleClose();
  };

  const handleClone = async () => {
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
      onCloned?.(data.path, data.name);
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Clone failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>New project</h3>
          <button className="modal-close" onClick={handleClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label>
            <span style={{ fontSize: 12, opacity: 0.7 }}>Project name (optional)</span>
            <input
              className="settings-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              autoFocus={mode === "menu"}
            />
          </label>

          {mode === "menu" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                className="modal-submit-btn"
                style={{ width: "100%" }}
                onClick={() => setMode("clone")}
              >
                Pull from GitHub
              </button>
              <button
                className="modal-cancel-btn"
                style={{ width: "100%" }}
                onClick={() => void handleOpenFolder()}
              >
                Open a folder
              </button>
            </div>
          )}

          {mode === "clone" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
                <span style={{ fontSize: 12, opacity: 0.7 }}>Personal access token (optional)</span>
                <input
                  className="settings-input"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="ghp_…"
                />
              </label>
              {error && <div style={{ color: "#e5484d", fontSize: 12 }}>{error}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button className="modal-cancel-btn" onClick={() => setMode("menu")} disabled={busy}>Back</button>
                <button className="modal-submit-btn" onClick={() => void handleClone()} disabled={busy} style={{ flex: 1 }}>
                  {busy ? "Cloning…" : "Clone"}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button className="modal-cancel-btn" onClick={handleClose}>Cancel</button>
          <button className="modal-submit-btn" onClick={handleClose}>Done</button>
        </div>
      </div>
    </div>
  );
}