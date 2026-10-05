"use client";

// ConnectorsPanel.tsx — the MCP server browser opened from the prompt bar
// (plug button next to the workspace switcher, or "+" → MCP servers).
//
// Browse/search a verified catalog of 100+ MCP servers (Supabase, Firebase,
// Vercel, Figma, GitHub, …), connect one by filling its env fields (secrets
// are encrypted server-side), test the connection with a real tools/list
// probe, and manage what's connected. Connected servers' tools are handed to
// the agent on every run — no per-task setup needed.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { IconMcp, IconSearch, IconTrash } from "./Icons";
import {
  loadRemotes,
  removeRemote,
  remoteIdFor,
  upsertRemote,
  type McpRemoteServer,
} from "@/lib/mcp/registry";
import { withConnection } from "@/lib/mcp/client";

interface StdioEnv {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  help?: string;
}

interface CatalogServer {
  id: string;
  name: string;
  description: string;
  category: string;
  auth: "oauth" | "token" | "none";
  remote: { url: string; transport: "streamable-http" | "sse" } | null;
  stdio: { command: string; args: string[]; env: StdioEnv[] } | null;
  oauth: { scopes?: string[]; clientId?: string } | null;
  docsUrl: string | null;
  popular: boolean;
}

interface ConnectedServer {
  id: string;
  serverId: string;
  label: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  secretsSet: string[];
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  docsUrl: string | null;
}

interface TestResult {
  ok: boolean;
  toolCount?: number;
  tools?: Array<{ name: string; description: string }>;
  error?: string;
  latencyMs?: number;
}

/** One SDK-lane connector row (GET /api/mcp/connections) — no tokens, ever. */
interface SdkConnection {
  serverId: string;
  name: string;
  url: string;
  transport: string;
  status: "connected" | "connected_no_tools" | "needs_reauth" | "disconnected";
  scope: string | null;
  autoApproveReadOnly: boolean;
  failureReason: string | null;
  toolCount: number;
}

function sdkBadge(status: SdkConnection["status"], toolCount: number): { cls: string; text: string } {
  switch (status) {
    case "connected":
      return { cls: "mcp-badge--ok", text: toolCount ? `${toolCount} tools` : "connected" };
    case "connected_no_tools":
      return { cls: "", text: "no tools" };
    case "needs_reauth":
      return { cls: "mcp-badge--fail", text: "needs reauth" };
    default:
      return { cls: "mcp-badge--off", text: "disconnected" };
  }
}

interface Category {
  key: string;
  label: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  database: "Databases",
  devtools: "Dev tools",
  cloud: "Cloud",
  design: "Design",
  productivity: "Productivity",
  data: "Data",
  search: "Search",
  ai: "AI",
  payments: "Payments",
  comms: "Comms",
  web: "Web",
  files: "Files",
  shell: "Shell",
};

export default function ConnectorsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [catalog, setCatalog] = useState<CatalogServer[]>([]);
  const [categories, setCategories] = useState<Category[]>([{ key: "all", label: "All" }]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState<ConnectedServer[]>([]);
  const [connectTarget, setConnectTarget] = useState<CatalogServer | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ serverId: string; result: TestResult } | null>(null);
  const [view, setView] = useState<"browse" | "detail">("browse");
  const panelRef = useRef<HTMLDivElement>(null);

  // === Remote OAuth servers (not in the backend catalog) ==================
  // The catalog's credential fields are PAT env vars — remote servers
  // (Linear, Notion, Cloudflare, …) authenticate with an interactive OAuth
  // 2.1 browser flow instead. Connection runs in the Electron main process
  // (discovery → DCR → browser sign-in → loopback callback → token swap).
  const [remotes, setRemotes] = useState<McpRemoteServer[]>([]);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteLabel, setRemoteLabel] = useState("");
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteRefreshing, setRemoteRefreshing] = useState<string | null>(null);

  // === SDK-lane connectors (spec Phase 7) ==================================
  // Server-side OAuth rows (McpConnection): status badges, the C6
  // auto-approve-read-only toggle, and the browser sign-in flow driven by
  // the Electron loopback relay (oauthPrepare/oauthOpen/onOAuthCallback).
  const [sdk, setSdk] = useState<SdkConnection[]>([]);
  const [sdkBusy, setSdkBusy] = useState<string | null>(null);
  const [sdkToggle, setSdkToggle] = useState<string | null>(null);
  const [sdkError, setSdkError] = useState<string | null>(null);
  const oauthOffRef = useRef<(() => void) | null>(null);

  const connectedIds = useMemo(
    () => new Set([...connected.map((c) => c.serverId), ...sdk.map((c) => c.serverId)]),
    [connected, sdk]
  );

  const loadConnected = useCallback(async () => {
    try {
      const r = await apiFetch("/api/mcp/servers");
      const j = await r.json();
      if (j?.success) setConnected(j.servers ?? []);
    } catch {}
  }, []);

  const loadSdk = useCallback(async (): Promise<SdkConnection[]> => {
    try {
      const r = await apiFetch("/api/mcp/connections");
      const j = await r.json();
      if (j?.success) {
        const rows: SdkConnection[] = j.connections ?? [];
        setSdk(rows);
        return rows;
      }
    } catch {}
    return [];
  }, []);

  // Debounced catalog search.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await apiFetch(`/api/mcp/catalog?q=${encodeURIComponent(query)}&category=${encodeURIComponent(category)}`);
        const j = await r.json();
        if (j?.success) {
          setCatalog(j.servers ?? []);
          setCategories(j.categories ?? [{ key: "all", label: "All" }]);
          setTotal(j.total ?? 0);
        }
      } catch {}
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [query, category, open]);

  useEffect(() => {
    if (open) {
      void loadConnected();
      void loadSdk();
      setRemotes(loadRemotes());
    }
  }, [open, loadConnected, loadSdk]);

  // Unsubscribe the loopback callback relay if the panel closes mid-sign-in.
  useEffect(() => () => { oauthOffRef.current?.(); }, []);

  // Esc closes (after connect form closes first).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (view === "detail") {
        setView("browse");
        setConnectTarget(null);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, view]);

  const openConnect = (server: CatalogServer) => {
    const existing = connected.find((c) => c.serverId === server.id);
    const initial: Record<string, string> = {};
    // Pre-fill plain (non-secret) values from an existing connection; secrets
    // stay blank and the backend keeps the stored value when left empty.
    for (const spec of server.stdio?.env ?? []) {
      if (!spec.secret && existing?.env[spec.name]) initial[spec.name] = existing.env[spec.name];
    }
    setEnvValues(initial);
    setConnectTarget(server);
    setSaveError(null);
    setSdkError(null);
    setView("detail");
  };

  const saveConnect = async () => {
    if (!connectTarget) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await apiFetch("/api/mcp/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: connectTarget.id, env: envValues }),
      });
      const j = await r.json();
      if (j?.success) {
        setConnectTarget(null);
        setView("browse");
        await loadConnected();
      } else {
        setSaveError(j?.error ?? `HTTP ${r.status}`);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (serverId: string, enabled: boolean) => {
    await apiFetch("/api/mcp/servers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, enabled }),
    }).catch(() => null);
    await loadConnected();
  };

  const disconnect = async (serverId: string) => {
    await apiFetch(`/api/mcp/servers?serverId=${encodeURIComponent(serverId)}`, { method: "DELETE" }).catch(() => null);
    if (testResult?.serverId === serverId) setTestResult(null);
    await loadConnected();
  };

  // === SDK-lane OAuth flow (spec Phase 7) ==================================
  // prepare (main binds the loopback BEFORE connect) → connect → open the
  // auth URL in the system browser → the loopback listener relays ?code&
  // state to POST /api/mcp/oauth/complete. A poll covers the hosted-callback
  // path (plain browser tab, no Electron bridge).

  const completeOauth = async (
    serverId: string,
    payload: { code?: string; state?: string; iss?: string; error?: string; error_description?: string }
  ): Promise<boolean> => {
    try {
      const r = await apiFetch("/api/mcp/oauth/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j?.success && j.status === "connected") {
        setSdkError(null);
        await loadSdk();
        return true;
      }
      setSdkError(j?.error ?? `Sign-in failed (HTTP ${r.status})`);
      return false;
    } catch (err) {
      setSdkError(err instanceof Error ? err.message : "Sign-in failed");
      return false;
    }
  };

  const startOauth = async (serverId: string) => {
    setSdkBusy(serverId);
    setSdkError(null);
    try {
      const bridge = window.orplexDesktop?.mcp;
      let redirectUri: string | undefined;
      if (bridge?.oauthPrepare) {
        const prep = await bridge.oauthPrepare();
        if (!prep.ok) {
          setSdkError(prep.error ?? "Could not start the local sign-in listener.");
          return;
        }
        redirectUri = prep.redirectUri;
      }
      const r = await apiFetch(`/api/mcp/connections/${encodeURIComponent(serverId)}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(redirectUri ? { redirectUri } : {}),
      });
      const j = await r.json();
      if (!j?.success) {
        setSdkError(j?.error ?? `HTTP ${r.status}`);
        return;
      }
      if (j.status === "connected") {
        await loadSdk();
        return;
      }
      if (j.status !== "awaiting_browser" || typeof j.authUrl !== "string") {
        setSdkError(j?.error ?? "Unexpected response from the connect endpoint.");
        return;
      }
      if (bridge?.onOAuthCallback) {
        const off = bridge.onOAuthCallback((payload) => {
          void completeOauth(serverId, payload).finally(() => {
            oauthOffRef.current?.();
            oauthOffRef.current = null;
          });
        });
        oauthOffRef.current = off;
      }
      if (bridge?.oauthOpen) await bridge.oauthOpen(j.authUrl);
      else window.open(j.authUrl, "_blank", "noopener,noreferrer");
      // Hosted-callback fallback: watch until the row lands connected.
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const rows = await loadSdk();
        const row = rows.find((c) => c.serverId === serverId);
        if (row && (row.status === "connected" || row.status === "connected_no_tools")) return;
      }
      setSdkError("Sign-in didn't finish in time — try again.");
    } catch (err) {
      setSdkError(err instanceof Error ? err.message : String(err));
    } finally {
      oauthOffRef.current?.();
      oauthOffRef.current = null;
      setSdkBusy(null);
    }
  };

  const toggleAutoApprove = async (serverId: string, value: boolean) => {
    setSdkToggle(serverId);
    setSdk((rows) => rows.map((c) => (c.serverId === serverId ? { ...c, autoApproveReadOnly: value } : c)));
    try {
      const r = await apiFetch(`/api/mcp/connections/${encodeURIComponent(serverId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoApproveReadOnly: value }),
      });
      const j = await r.json();
      if (!j?.success) setSdkError(j?.error ?? `HTTP ${r.status}`);
    } catch (err) {
      setSdkError(err instanceof Error ? err.message : "Could not save the setting");
    } finally {
      setSdkToggle(null);
      await loadSdk();
    }
  };

  const disconnectSdk = async (serverId: string) => {
    await apiFetch(`/api/mcp/connections/${encodeURIComponent(serverId)}`, { method: "DELETE" }).catch(() => null);
    await loadSdk();
  };

  const connectRemote = async () => {
    const url = remoteUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      setRemoteError("Enter the MCP server URL (https://…)");
      return;
    }
    setRemoteBusy(true);
    setRemoteError(null);
    try {
      const bridge = window.orplexDesktop?.mcp;
      if (!bridge) {
        setRemoteError("OAuth needs the desktop app — the browser sign-in and token exchange run in its main process.");
        return;
      }
      const oauth = await bridge.oauthAuthorize({ serverUrl: url, label: remoteLabel.trim() });
      if (!oauth.ok || !oauth.accessToken) {
        setRemoteError(oauth.error ?? "OAuth sign-in failed");
        return;
      }
      const base: McpRemoteServer = {
        id: remoteIdFor(url),
        label: remoteLabel.trim() || new URL(url).host,
        url,
        auth: "oauth",
        tokens: {
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          tokenType: oauth.tokenType ?? "Bearer",
          clientId: oauth.clientId ?? "",
          clientSecret: oauth.clientSecret,
          tokenEndpoint: oauth.tokenEndpoint,
          obtainedAt: Date.now(),
          expiresAt: oauth.expiresIn ? Date.now() + oauth.expiresIn * 1000 : undefined,
        },
      };
      let tools: McpRemoteServer["tools"] = [];
      let lastError: string | undefined;
      try {
        await withConnection(base, async (conn) => {
          tools = await conn.listTools();
        });
      } catch (err) {
        // Authenticated, but tool discovery failed — keep the server listed.
        lastError = `Connected, but tools/list failed: ${(err as Error).message}`;
      }
      upsertRemote({ ...base, tools, lastConnectedAt: Date.now(), lastError });
      setRemotes(loadRemotes());
      setRemoteUrl("");
      setRemoteLabel("");
    } catch (err) {
      setRemoteError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteBusy(false);
    }
  };

  const refreshRemoteTools = async (id: string) => {
    const srv = remotes.find((r) => r.id === id);
    if (!srv) return;
    setRemoteRefreshing(id);
    try {
      let tools: McpRemoteServer["tools"] = [];
      let lastError: string | undefined;
      await withConnection(srv, async (conn) => {
        tools = await conn.listTools();
      }).catch((err) => {
        lastError = (err as Error).message;
      });
      upsertRemote({
        ...srv,
        tools,
        lastError,
        lastConnectedAt: tools.length ? Date.now() : srv.lastConnectedAt,
      });
      setRemotes(loadRemotes());
    } finally {
      setRemoteRefreshing(null);
    }
  };

  const disconnectRemote = (id: string) => {
    removeRemote(id);
    setRemotes(loadRemotes());
  };

  const testConnection = async (serverId: string) => {
    setTesting(serverId);
    setTestResult(null);
    try {
      const r = await apiFetch("/api/mcp/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      });
      const j = await r.json();
      setTestResult({ serverId, result: { ok: !!j?.ok, toolCount: j?.toolCount, tools: j?.tools, error: j?.error, latencyMs: j?.latencyMs } });
    } catch (err) {
      setTestResult({ serverId, result: { ok: false, error: err instanceof Error ? err.message : "Network error" } });
    } finally {
      setTesting(null);
      await loadConnected();
    }
  };

  if (!open) return null;

  return (
    <div className="mcp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mcp-panel" ref={panelRef} role="dialog" aria-label="MCP connectors">
        <header className="mcp-header">
          <div className="mcp-title">
            <IconMcp size={20} />
            <h2>MCP connectors</h2>
            <span className="mcp-count">{connected.length + sdk.length} connected</span>
          </div>
          <button className="mcp-close" onClick={onClose} aria-label="Close connectors">✕</button>
        </header>

        {view === "browse" ? (
          <>
            <div className="mcp-toolbar">
              <div className="mcp-search">
                <IconSearch size={14} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${total}+ servers — supabase, figma, vercel…`}
                  aria-label="Search MCP servers"
                  autoFocus
                />
              </div>
              <div className="mcp-cats" role="tablist">
                {categories.map((c) => (
                  <button
                    key={c.key}
                    role="tab"
                    aria-selected={category === c.key}
                    className={`mcp-cat ${category === c.key ? "mcp-cat--on" : ""}`}
                    onClick={() => setCategory(c.key)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mcp-list">
              {/* SDK-lane connectors (spec Phase 7): status, tool counts, C6 toggle. */}
              {sdk.length > 0 && <div className="mcp-section-label">OAuth connectors</div>}
              {sdk.map((c) => {
                const badge = sdkBadge(c.status, c.toolCount);
                return (
                  <div key={`sdk-${c.serverId}`} className="mcp-row mcp-row--connected">
                    <IconMcp size={18} />
                    <div className="mcp-row-main">
                      <div className="mcp-row-name">
                        {c.name}
                        <span className={`mcp-badge ${badge.cls}`}>{badge.text}</span>
                        {c.autoApproveReadOnly && <span className="mcp-badge mcp-badge--pop">auto-approve reads</span>}
                      </div>
                      <div className="mcp-row-desc">
                        {c.url}
                        {c.status === "needs_reauth" && c.failureReason ? ` — ${c.failureReason}` : ""}
                        {c.scope ? ` · scopes: ${c.scope}` : ""}
                      </div>
                    </div>
                    <div className="mcp-row-actions">
                      {(c.status === "needs_reauth" || c.status === "disconnected") && (
                        <button className="mcp-btn mcp-btn--primary" disabled={sdkBusy === c.serverId} onClick={() => startOauth(c.serverId)}>
                          {sdkBusy === c.serverId ? "Waiting for sign-in…" : c.status === "needs_reauth" ? "Re-authorize" : "Reconnect"}
                        </button>
                      )}
                      <label className="mcp-autoapprove" title="Approve read-only tools without asking each time">
                        <input
                          type="checkbox"
                          checked={c.autoApproveReadOnly}
                          disabled={sdkToggle === c.serverId}
                          onChange={(e) => toggleAutoApprove(c.serverId, e.target.checked)}
                        />
                        Auto-approve reads
                      </label>
                      <button className="mcp-btn mcp-btn--danger" aria-label={`Disconnect ${c.name}`} onClick={() => disconnectSdk(c.serverId)}>
                        <IconTrash size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
              {sdkError && <div className="mcp-test mcp-test--fail">✕ {sdkError}</div>}

              {/* Remote OAuth servers — the catalog's PAT fields don't fit these. */}
              <div className="mcp-section-label">Remote servers (OAuth)</div>
              {remotes.map((r) => (
                <div key={r.id} className="mcp-row mcp-row--connected">
                  <IconMcp size={18} />
                  <div className="mcp-row-main">
                    <div className="mcp-row-name">
                      {r.label}
                      <span className={`mcp-badge ${r.lastError ? "mcp-badge--fail" : r.tools?.length ? "mcp-badge--ok" : ""}`}>
                        {r.lastError ? "error" : r.tools?.length ? `${r.tools.length} tools` : "no tools"}
                      </span>
                    </div>
                    <div className="mcp-row-desc">{r.url}{r.lastError ? ` — ${r.lastError}` : ""}</div>
                  </div>
                  <div className="mcp-row-actions">
                    <button className="mcp-btn" disabled={remoteRefreshing === r.id} onClick={() => refreshRemoteTools(r.id)}>
                      {remoteRefreshing === r.id ? "Refreshing…" : "Refresh"}
                    </button>
                    <button className="mcp-btn mcp-btn--danger" aria-label={`Remove ${r.label}`} onClick={() => disconnectRemote(r.id)}>
                      <IconTrash size={13} />
                    </button>
                  </div>
                </div>
              ))}
              <div className="mcp-row mcp-row--addremote">
                <div className="mcp-row-main">
                  <div className="mcp-remote-form">
                    <input
                      value={remoteLabel}
                      onChange={(e) => setRemoteLabel(e.target.value)}
                      placeholder="Name — e.g. Linear"
                      aria-label="Remote MCP server name"
                    />
                    <input
                      value={remoteUrl}
                      onChange={(e) => setRemoteUrl(e.target.value)}
                      placeholder="https://mcp.example.com/mcp"
                      aria-label="Remote MCP server URL"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button className="mcp-btn mcp-btn--primary" disabled={remoteBusy || !remoteUrl.trim()} onClick={connectRemote}>
                      {remoteBusy ? "Waiting for sign-in…" : "Connect with browser"}
                    </button>
                  </div>
                  {remoteError && <div className="mcp-test mcp-test--fail">✕ {remoteError}</div>}
                  {!window.orplexDesktop?.mcp && (
                    <div className="mcp-env-note">OAuth sign-in runs in the desktop app&apos;s main process — it is unavailable in a plain browser tab.</div>
                  )}
                </div>
              </div>

              {connected.length > 0 && !query && category === "all" && (
                <div className="mcp-section-label">Your connectors</div>
              )}
              {connected.length > 0 && !query && category === "all" && connected.map((c) => (
                <div key={`c-${c.id}`} className="mcp-row mcp-row--connected">
                  <IconMcp size={18} />
                  <div className="mcp-row-main">
                    <div className="mcp-row-name">
                      {c.label}
                      {c.enabled ? (
                        <span className={`mcp-badge ${c.lastTestOk === true ? "mcp-badge--ok" : c.lastTestOk === false ? "mcp-badge--fail" : ""}`}>
                          {c.lastTestOk === true ? "healthy" : c.lastTestOk === false ? "failing" : "untested"}
                        </span>
                      ) : (
                        <span className="mcp-badge mcp-badge--off">disabled</span>
                      )}
                    </div>
                    <div className="mcp-row-desc">
                      {c.env && Object.keys(c.env).length > 0
                        ? Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join(" · ")
                        : c.description}
                    </div>
                  </div>
                  <div className="mcp-row-actions">
                    {c.enabled && (
                      <button className="mcp-btn" disabled={testing === c.serverId} onClick={() => testConnection(c.serverId)}>
                        {testing === c.serverId ? "Testing…" : "Test"}
                      </button>
                    )}
                    <button className="mcp-btn" onClick={() => toggleEnabled(c.serverId, !c.enabled)}>
                      {c.enabled ? "Disable" : "Enable"}
                    </button>
                    <button className="mcp-btn mcp-btn--danger" aria-label={`Disconnect ${c.label}`} onClick={() => disconnect(c.serverId)}>
                      <IconTrash size={13} />
                    </button>
                  </div>
                  {testResult?.serverId === c.serverId && (
                    <div className={`mcp-test ${testResult.result.ok ? "mcp-test--ok" : "mcp-test--fail"}`}>
                      {testResult.result.ok
                        ? `✓ ${testResult.result.toolCount} tools in ${testResult.result.latencyMs}ms${testResult.result.tools?.length ? ` — ${testResult.result.tools.slice(0, 4).map((t) => t.name).join(", ")}${testResult.result.tools.length > 4 ? "…" : ""}` : ""}`
                        : `✕ ${testResult.result.error ?? "connection failed"}`}
                    </div>
                  )}
                </div>
              ))}

              {connected.length > 0 && !query && category === "all" && (
                <div className="mcp-section-label">Catalog — {total} servers</div>
              )}

              {loading && catalog.length === 0 && <div className="mcp-empty">Loading catalog…</div>}
              {!loading && catalog.length === 0 && <div className="mcp-empty">No servers match “{query}”.</div>}
              {catalog.map((s) => (
                <div key={s.id} className={`mcp-row ${connectedIds.has(s.id) ? "mcp-row--incatalog" : ""}`}>
                  <IconMcp size={18} />
                  <div className="mcp-row-main">
                    <div className="mcp-row-name">
                      {s.name}
                      <span className="mcp-cat-chip">{CATEGORY_LABELS[s.category] ?? s.category}</span>
                      {s.popular && <span className="mcp-badge mcp-badge--pop">popular</span>}
                      {connectedIds.has(s.id) && <span className="mcp-badge mcp-badge--ok">connected</span>}
                    </div>
                    <div className="mcp-row-desc">{s.description}</div>
                  </div>
                  <div className="mcp-row-actions">
                    <button className="mcp-btn mcp-btn--primary" onClick={() => openConnect(s)}>
                      {connectedIds.has(s.id) ? "Configure" : "Connect"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : connectTarget ? (
          <div className="mcp-detail">
            <button className="mcp-back" onClick={() => { setView("browse"); setConnectTarget(null); }}>← All connectors</button>
            <h3 className="mcp-detail-name">
              <IconMcp size={20} /> {connectTarget.name}
            </h3>
            <p className="mcp-detail-desc">{connectTarget.description}</p>
            {connectTarget.docsUrl && (
              <a className="mcp-detail-docs" href={connectTarget.docsUrl} target="_blank" rel="noreferrer">
                Documentation ↗
              </a>
            )}
            {connectTarget.remote && (
              <div className="mcp-detail-cmd">
                <code>{connectTarget.remote.url}</code>
              </div>
            )}
            {connectTarget.stdio && (
              <div className="mcp-detail-cmd">
                <code>{connectTarget.stdio.command} {connectTarget.stdio.args.join(" ")}</code>
              </div>
            )}

            {connectTarget.remote && connectTarget.auth === "oauth" && (
              <div className="mcp-detail-oauth">
                <div className="mcp-section-label">Sign in</div>
                <p className="mcp-env-note">
                  {connectTarget.oauth?.scopes?.length ? <>Grants: <code>{connectTarget.oauth.scopes.join(" ")}</code>. </> : null}
                  The browser opens for sign-in; tokens are stored encrypted on this device and never
                  returned to the page.
                </p>
                <div className="mcp-detail-actions">
                  <button className="mcp-btn mcp-btn--primary" disabled={sdkBusy === connectTarget.id} onClick={() => startOauth(connectTarget.id)}>
                    {sdkBusy === connectTarget.id
                      ? "Waiting for sign-in…"
                      : sdk.some((c) => c.serverId === connectTarget.id && c.status === "needs_reauth")
                        ? "Re-authorize with browser"
                        : "Sign in with browser"}
                  </button>
                </div>
              </div>
            )}

            {(connectTarget.stdio?.env.length ?? 0) > 0 && (
              <div className="mcp-env-form">
                <div className="mcp-section-label">Credentials & settings</div>
                {connectTarget.stdio!.env.map((spec) => (
                  <label key={spec.name} className="mcp-env-field">
                    <span className="mcp-env-key">
                      {spec.name}
                      {spec.required && <em className="mcp-env-req">required</em>}
                      {spec.secret && <em className="mcp-env-secret">secret</em>}
                    </span>
                    <input
                      type={spec.secret ? "password" : "text"}
                      value={envValues[spec.name] ?? ""}
                      placeholder={spec.help ?? spec.label}
                      onChange={(e) => setEnvValues((v) => ({ ...v, [spec.name]: e.target.value }))}
                      autoComplete="off"
                    />
                    <span className="mcp-env-help">{spec.label}</span>
                  </label>
                ))}
                <p className="mcp-env-note">Secrets are encrypted (AES-256-GCM) before storage and never returned to the browser.</p>
              </div>
            )}

            {saveError && <div className="mcp-test mcp-test--fail">✕ {saveError}</div>}
            {sdkError && <div className="mcp-test mcp-test--fail">✕ {sdkError}</div>}

            <div className="mcp-detail-actions">
              <button className="mcp-btn" onClick={() => { setView("browse"); setConnectTarget(null); }}>Cancel</button>
              {!(connectTarget.remote && connectTarget.auth === "oauth") && (
                <button className="mcp-btn mcp-btn--primary" disabled={saving} onClick={saveConnect}>
                  {saving ? "Saving…" : connectedIds.has(connectTarget.id) ? "Save changes" : "Connect server"}
                </button>
              )}
            </div>
            <p className="mcp-detail-note">
              Once connected, this server&apos;s tools are available to the agent in every run — it will use them automatically when a task needs them.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
