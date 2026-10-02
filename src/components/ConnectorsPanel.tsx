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

interface EnvSpec {
  key: string;
  description: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
}

interface CatalogServer {
  id: string;
  name: string;
  description: string;
  category: string;
  command: string;
  args: string[];
  envSpec: EnvSpec[];
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

  const connectedIds = useMemo(() => new Set(connected.map((c) => c.serverId)), [connected]);

  const loadConnected = useCallback(async () => {
    try {
      const r = await apiFetch("/api/mcp/servers");
      const j = await r.json();
      if (j?.success) setConnected(j.servers ?? []);
    } catch {}
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
      setRemotes(loadRemotes());
    }
  }, [open, loadConnected]);

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
    for (const spec of server.envSpec) {
      if (!spec.secret && existing?.env[spec.key]) initial[spec.key] = existing.env[spec.key];
    }
    setEnvValues(initial);
    setConnectTarget(server);
    setSaveError(null);
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
            <span className="mcp-count">{connected.length} connected</span>
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
                    <div className="mcp-env-note">OAuth sign-in runs in the desktop app's main process — it is unavailable in a plain browser tab.</div>
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
            <div className="mcp-detail-cmd">
              <code>{connectTarget.command} {connectTarget.args.join(" ")}</code>
            </div>

            {connectTarget.envSpec.length > 0 && (
              <div className="mcp-env-form">
                <div className="mcp-section-label">Credentials & settings</div>
                {connectTarget.envSpec.map((spec) => (
                  <label key={spec.key} className="mcp-env-field">
                    <span className="mcp-env-key">
                      {spec.key}
                      {spec.required && <em className="mcp-env-req">required</em>}
                      {spec.secret && <em className="mcp-env-secret">secret</em>}
                    </span>
                    <input
                      type={spec.secret ? "password" : "text"}
                      value={envValues[spec.key] ?? ""}
                      placeholder={spec.placeholder ?? spec.description}
                      onChange={(e) => setEnvValues((v) => ({ ...v, [spec.key]: e.target.value }))}
                      autoComplete="off"
                    />
                    <span className="mcp-env-help">{spec.description}</span>
                  </label>
                ))}
                <p className="mcp-env-note">Secrets are encrypted (AES-256-GCM) before storage and never returned to the browser.</p>
              </div>
            )}

            {saveError && <div className="mcp-test mcp-test--fail">✕ {saveError}</div>}

            <div className="mcp-detail-actions">
              <button className="mcp-btn" onClick={() => { setView("browse"); setConnectTarget(null); }}>Cancel</button>
              <button className="mcp-btn mcp-btn--primary" disabled={saving} onClick={saveConnect}>
                {saving ? "Saving…" : connectedIds.has(connectTarget.id) ? "Save changes" : "Connect server"}
              </button>
            </div>
            <p className="mcp-detail-note">
              Once connected, this server's tools are available to the agent in every run — it will use them automatically when a task needs them.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
