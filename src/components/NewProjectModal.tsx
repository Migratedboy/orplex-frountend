"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { useToast } from "@/components/Toast";

const ACCENT = "#a04100";
const CARD_BG = "linear-gradient(180deg, #ffffff 0%, #faf7f3 100%)";

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

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "1.5px solid #e4e4e7",
    background: "#fff",
    fontSize: 14,
    color: "#1a1c1d",
    outline: "none",
    fontFamily: "inherit",
    transition: "border-color 0.15s, box-shadow 0.15s",
  };

  return (
    <div
      onClick={handleClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10,8,6,0.55)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 520,
          background: CARD_BG,
          borderRadius: 18,
          padding: 0,
          boxShadow: "0 24px 60px rgba(0,0,0,0.25), 0 2px 8px rgba(160,65,0,0.08)",
          border: "1px solid rgba(160,65,0,0.12)",
          overflow: "hidden",
          animation: "np-pop 0.18s ease-out",
        }}
      >
        <style>{`
          @keyframes np-pop { from { opacity:0; transform: translateY(8px) scale(0.98); } to { opacity:1; transform: none; } }
          .np-input:focus { border-color: ${ACCENT} !important; box-shadow: 0 0 0 3px rgba(160,65,0,0.15); }
          .np-option { transition: transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s; }
          .np-option:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(160,65,0,0.12); border-color: ${ACCENT}; }
        `}</style>

        {/* Header */}
        <div
          style={{
            padding: "20px 24px 16px",
            background: "linear-gradient(135deg, #a04100 0%, #c25a1a 100%)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: "rgba(255,255,255,0.18)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 18,
              }}
            >
              📁
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.3 }}>New project</div>
              <div style={{ fontSize: 12, opacity: 0.85 }}>Start from a name, a repo, or a folder</div>
            </div>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close"
            style={{
              background: "rgba(255,255,255,0.15)",
              border: "none",
              color: "#fff",
              width: 30,
              height: 30,
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "#5f5e5e", textTransform: "uppercase" }}>
              Project name
            </span>
            <input
              className="np-input"
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-awesome-project"
              autoFocus={mode === "menu"}
            />
          </label>

          {mode === "menu" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <button
                className="np-option"
                onClick={() => setMode("clone")}
                style={{
                  textAlign: "left",
                  padding: 16,
                  borderRadius: 14,
                  border: "1.5px solid #e4e4e7",
                  background: "#fff",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 24 }}>🐙</div>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#1a1c1d" }}>Pull from GitHub</div>
                <div style={{ fontSize: 12, color: "#5f5e5e", lineHeight: 1.4 }}>Clone a repository into a new project</div>
              </button>
              <button
                className="np-option"
                onClick={() => void handleOpenFolder()}
                style={{
                  textAlign: "left",
                  padding: 16,
                  borderRadius: 14,
                  border: "1.5px solid #e4e4e7",
                  background: "#fff",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 24 }}>📂</div>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#1a1c1d" }}>Open a folder</div>
                <div style={{ fontSize: 12, color: "#5f5e5e", lineHeight: 1.4 }}>Attach an existing folder on this device</div>
              </button>
            </div>
          )}

          {mode === "clone" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "#5f5e5e", textTransform: "uppercase" }}>Repository URL</span>
                <input
                  className="np-input"
                  style={inputStyle}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  autoFocus
                />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "#5f5e5e", textTransform: "uppercase" }}>Branch</span>
                  <input
                    className="np-input"
                    style={inputStyle}
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="main"
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "#5f5e5e", textTransform: "uppercase" }}>Token (optional)</span>
                  <input
                    className="np-input"
                    style={{ ...inputStyle, fontFamily: "monospace" }}
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="ghp_…"
                  />
                </label>
              </div>
              {error && (
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: "rgba(186,26,26,0.08)",
                    border: "1px solid rgba(186,26,26,0.25)",
                    color: "#ba1a1a",
                    fontSize: 13,
                  }}
                >
                  {error}
                </div>
              )}
              <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                <button
                  onClick={() => setMode("menu")}
                  disabled={busy}
                  style={{
                    padding: "10px 16px",
                    borderRadius: 10,
                    border: "1.5px solid #e4e4e7",
                    background: "#fff",
                    color: "#5f5e5e",
                    fontWeight: 600,
                    cursor: busy ? "not-allowed" : "pointer",
                    fontSize: 13,
                  }}
                >
                  ← Back
                </button>
                <button
                  onClick={() => void handleClone()}
                  disabled={busy}
                  style={{
                    flex: 1,
                    padding: "10px 16px",
                    borderRadius: 10,
                    border: "none",
                    background: busy ? "#c9a88a" : ACCENT,
                    color: "#fff",
                    fontWeight: 700,
                    cursor: busy ? "not-allowed" : "pointer",
                    fontSize: 13,
                    boxShadow: busy ? "none" : "0 4px 12px rgba(160,65,0,0.3)",
                  }}
                >
                  {busy ? "Cloning…" : "Clone repository"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 24px 20px",
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            borderTop: "1px solid rgba(0,0,0,0.06)",
            background: "rgba(255,255,255,0.5)",
          }}
        >
          <button
            onClick={handleClose}
            style={{
              padding: "10px 18px",
              borderRadius: 10,
              border: "1.5px solid #e4e4e7",
              background: "#fff",
              color: "#5f5e5e",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleClose}
            style={{
              padding: "10px 22px",
              borderRadius: 10,
              border: "none",
              background: ACCENT,
              color: "#fff",
              fontWeight: 700,
              cursor: "pointer",
              fontSize: 13,
              boxShadow: "0 4px 12px rgba(160,65,0,0.3)",
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}