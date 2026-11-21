"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { startMediatorSignIn } from "@/lib/signin-mediator";
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

  // GitHub picker state
  type Repo = {
    fullName: string;
    owner: string;
    name: string;
    private: boolean;
    defaultBranch: string;
    description: string | null;
    updatedAt: string;
    cloneUrl: string;
  };
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [needsScope, setNeedsScope] = useState(false);
  const [login, setLogin] = useState<string | null>(null);
  const [repoMsg, setRepoMsg] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  // GitHub App device flow: no redirect, no cookie dance. The user types a code
  // at github.com/login/device and this polls until GitHub hands over a token.
  const [device, setDevice] = useState<{
    flowId: string;
    userCode: string;
    verificationUri: string;
    interval: number;
  } | null>(null);
  const [deviceErr, setDeviceErr] = useState<string | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceCancelled, setDeviceCancelled] = useState(false);

  const openExternal = (url: string) => {
    const bridge = window.orplexDesktop?.openExternal;
    if (bridge) void bridge(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  /**
   * Start GitHub App sign-in. Falls back to the mediator OAuth flow only when
   * the app is not configured for device flow (GITHUB_APP_CLIENT_ID unset), so
   * an unconfigured install still has a working button.
   */
  const connectGitHub = async () => {
    setDeviceBusy(true);
    setDeviceErr(null);
    setDeviceCancelled(false);
    try {
      const res = await apiFetch("/api/repos/github/device", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.flowId && data?.userCode) {
        setDevice({
          flowId: data.flowId,
          userCode: data.userCode,
          verificationUri: data.verificationUri || "https://github.com/login/device",
          interval: Math.max(5, Number(data.interval) || 5),
        });
        openExternal(data.verificationUri || "https://github.com/login/device");
        return;
      }
      if (res.status === 501) {
        // Device flow not configured on this install — use the mediator door.
        startMediatorSignIn("github", "/");
        return;
      }
      setDeviceErr(data?.error || `GitHub responded ${res.status}`);
    } catch (e) {
      setDeviceErr(e instanceof Error ? e.message : "Could not start GitHub sign-in");
    } finally {
      setDeviceBusy(false);
    }
  };


  const loadRepos = useCallback(async () => {
    setRepos(null);
    setRepoMsg(null);
    try {
      const res = await apiFetch("/api/repos/github");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setConnected(false);
        setRepos([]);
        setRepoMsg(data?.error || "Could not load your repositories.");
        return;
      }
      setConnected(data?.connected !== false);
      setNeedsScope(data?.needsScope === true);
      setLogin(typeof data?.login === "string" ? data.login : null);
      setRepos(Array.isArray(data?.repos) ? (data.repos as Repo[]) : []);
      setRepoMsg(typeof data?.error === "string" ? data.error : null);
    } catch {
      setConnected(false);
      setRepos([]);
      setRepoMsg("Could not reach the app server.");
    }
  }, []);

  useEffect(() => {
    if (open && mode === "clone" && repos === null) void loadRepos();
  }, [open, mode, repos, loadRepos]);

  useEffect(() => {
    if (!device || deviceCancelled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await apiFetch(`/api/repos/github/device?flow=${encodeURIComponent(device.flowId)}`);
        const data = await res.json().catch(() => ({}));
        if (stopped) return;
        if (data?.status === "authorized") {
          setDevice(null);
          setRepoMsg(null);
          await loadRepos();
          return;
        }
        if (data?.status === "expired" || data?.status === "denied" || data?.status === "error") {
          setDevice(null);
          setDeviceErr(
            data?.status === "denied"
              ? "Authorisation was cancelled on GitHub."
              : data?.error || "The code expired. Try again."
          );
          return;
        }
      } catch {
        /* keep polling: a dropped request must not kill the flow */
      }
      if (!stopped) timer = setTimeout(poll, device.interval * 1000);
    };

    timer = setTimeout(poll, device.interval * 1000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [device, deviceCancelled, loadRepos]);

  const filteredRepos = useMemo(() => {
    const list = repos ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) =>
      (r.fullName + " " + (r.description ?? "")).toLowerCase().includes(q)
    );
  }, [repos, query]);

  const pickRepo = (repo: Repo) => {
    setSelected(repo.fullName);
    setUrl(repo.cloneUrl);
    setBranch(repo.defaultBranch);
    setError(null);
  };

  if (!open) return null;

  const reset = () => {
    setName("");
    setMode("menu");
    setUrl("");
    setBranch("");
    setToken("");
    setError(null);
    setSelected(null);
    setQuery("");
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

  const modal = (
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
        /* Above the floating composer, topbar, right panel (35), mcp (120) and
           palette (110) layers, below toasts (200). */
        zIndex: 150,
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
                <div style={{ fontSize: 12, color: "#5f5e5e", lineHeight: 1.4 }}>Pick one of your repositories, or paste a URL</div>
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
              {/* Your repositories — the whole point: the GitHub token from
                  sign-in already knows what you can clone. */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "#5f5e5e", textTransform: "uppercase" }}>
                    Your GitHub repositories
                  </span>
                  {login && (
                    <span style={{ fontSize: 11, color: "#8a8a8a" }}>@{login}</span>
                  )}
                </div>

                {repos === null && (
                  <div style={{ fontSize: 13, color: "#5f5e5e", padding: "10px 2px" }}>Loading your repositories…</div>
                )}

                {repos !== null && connected === false && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 12, border: "1.5px dashed #e4e4e7", background: "rgba(255,255,255,0.6)" }}>
                    <span style={{ fontSize: 13, color: "#5f5e5e", lineHeight: 1.45 }}>
                      Connect GitHub to list the repositories you can clone. You can still paste a URL below.
                    </span>
                    {device ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <span style={{ fontSize: 13, color: "#1a1c1d" }}>
                          Enter this code on GitHub, then leave this window open:
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <code style={{ fontSize: 20, letterSpacing: "0.28em", fontWeight: 700, padding: "6px 12px", borderRadius: 8, background: "#fff", border: "1.5px solid #e4e4e7" }}>
                            {device.userCode}
                          </code>
                          <button
                            onClick={() => openExternal(device.verificationUri)}
                            style={{ padding: "8px 14px", borderRadius: 10, border: "none", background: ACCENT, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}
                          >
                            Open github.com/login/device
                          </button>
                        </div>
                        <span style={{ fontSize: 12, color: "#8a6a4a" }}>
                          Waiting for authorisation… this screen updates by itself.
                        </span>
                        <button
                          onClick={() => { setDeviceCancelled(true); setDevice(null); }}
                          style={{ alignSelf: "flex-start", padding: "4px 10px", borderRadius: 8, border: "1.5px solid #e4e4e7", background: "#fff", fontWeight: 600, fontSize: 12, cursor: "pointer" }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => void connectGitHub()}
                        disabled={deviceBusy}
                        style={{ alignSelf: "flex-start", padding: "8px 14px", borderRadius: 10, border: "none", background: deviceBusy ? "#c9a88a" : ACCENT, color: "#fff", fontWeight: 700, fontSize: 13, cursor: deviceBusy ? "not-allowed" : "pointer" }}
                      >
                        {deviceBusy ? "Starting…" : "Connect GitHub"}
                      </button>
                    )}
                    {deviceErr && <div style={{ fontSize: 12, color: "#ba1a1a" }}>{deviceErr}</div>}
                  </div>
                )}

                {repos !== null && connected !== false && (
                  <>
                    {(repos.length > 0 || query) && (
                      <input
                        className="np-input"
                        style={inputStyle}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search repositories"
                        autoFocus
                      />
                    )}
                    {repos.length === 0 ? (
                      <div style={{ fontSize: 13, color: "#5f5e5e", padding: "6px 2px" }}>
                        No repositories found for this account. Paste a URL below.
                      </div>
                    ) : (
                      <div
                        role="listbox"
                        aria-label="Your GitHub repositories"
                        style={{ maxHeight: 208, overflowY: "auto", border: "1.5px solid #e4e4e7", borderRadius: 12, background: "#fff" }}
                      >
                        {filteredRepos.length === 0 && (
                          <div style={{ padding: 12, fontSize: 13, color: "#5f5e5e" }}>No repository matches “{query}”.</div>
                        )}
                        {filteredRepos.map((r) => {
                          const on = selected === r.fullName;
                          return (
                            <button
                              key={r.fullName}
                              role="option"
                              aria-selected={on}
                              onClick={() => pickRepo(r)}
                              onDoubleClick={() => { pickRepo(r); }}
                              style={{
                                display: "flex", width: "100%", textAlign: "left", gap: 10, alignItems: "flex-start",
                                padding: "10px 12px", border: "none", borderBottom: "1px solid #f0f0f1",
                                background: on ? "rgba(160,65,0,0.08)" : "transparent", cursor: "pointer",
                              }}
                            >
                              <span style={{ fontSize: 15, lineHeight: "18px" }}>{r.private ? "🔒" : "📘"}</span>
                              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                                <span style={{ fontSize: 13, fontWeight: on ? 700 : 600, color: "#1a1c1d", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {r.fullName}
                                </span>
                                <span style={{ fontSize: 11.5, color: "#5f5e5e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {r.description || r.defaultBranch}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {needsScope && !device && (
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: "#8a6a4a" }}>
                        <span>Private repositories need a reconnect.</span>
                        <button
                          onClick={() => void connectGitHub()}
                          disabled={deviceBusy}
                          style={{ padding: "4px 10px", borderRadius: 8, border: "1.5px solid #e4e4e7", background: "#fff", fontWeight: 600, fontSize: 12, cursor: deviceBusy ? "not-allowed" : "pointer" }}
                        >
                          {deviceBusy ? "…" : "Connect GitHub"}
                        </button>
                      </div>
                    )}
                    {device && (
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, color: "#8a6a4a" }}>
                        <span>Enter code</span>
                        <code style={{ fontSize: 15, letterSpacing: "0.22em", fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: "#fff", border: "1px solid #e4e4e7" }}>
                          {device.userCode}
                        </code>
                        <button
                          onClick={() => openExternal(device.verificationUri)}
                          style={{ padding: "4px 10px", borderRadius: 8, border: "1.5px solid #e4e4e7", background: "#fff", fontWeight: 600, fontSize: 12, cursor: "pointer" }}
                        >
                          Open GitHub
                        </button>
                      </div>
                    )}
                    {repoMsg && (
                      <div style={{ fontSize: 12, color: "#ba1a1a" }}>{repoMsg}</div>
                    )}
                  </>
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "2px 0" }}>
                <div style={{ flex: 1, height: 1, background: "rgba(0,0,0,0.08)" }} />
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "#8a8a8a", textTransform: "uppercase" }}>
                  Or clone by URL
                </span>
                <div style={{ flex: 1, height: 1, background: "rgba(0,0,0,0.08)" }} />
              </div>

              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "#5f5e5e", textTransform: "uppercase" }}>Repository URL</span>
                <input
                  className="np-input"
                  style={inputStyle}
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); setSelected(null); }}
                  placeholder="https://github.com/owner/repo"
                  autoFocus={connected === false}
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

  // Portal out of the sidebar: .sb is position:sticky, which creates its own
  // stacking context, so a fixed overlay rendered inside it got painted under
  // the chat column (prompt bar, welcome chips, hero title). Rendering at the
  // document root keeps the modal above every app layer.
  return typeof document === "undefined" ? modal : createPortal(modal, document.body);
}