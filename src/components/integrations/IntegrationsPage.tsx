"use client";

/**
 * IntegrationsPage.tsx — the full-page Integrations view (MCP connectors:
 * connected list, popular grid, search). It is rendered by AppShell inside the
 * `.ox-integrations` slot on any /integrations route, NOT by the route itself:
 * the shell hides `.ox-body` while that slot is open (design: integrations
 * replaces the whole app body), so a page mounted inside the body would be
 * invisible and the app would go blank.
 */
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { Icon } from "@/components/ui/Icon";

interface Connection { id?: string; serverId?: string; name?: string; where?: string; toolCount?: number; tools?: number; url?: string; on?: boolean; status?: string }
interface CatalogEntry { id: string; name: string; description?: string; category?: string; auth?: string; popular?: boolean }

export default function IntegrationsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");

  const load = async () => {
    try {
      const r = await apiFetch("/api/mcp/connections");
      const j = await r.json();
      if (Array.isArray(j.connections)) setConnections(j.connections);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't load connections.");
    }
    try {
      const r = await apiFetch("/api/mcp/catalog");
      const j = await r.json();
      if (Array.isArray(j.servers)) setCatalog(j.servers);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't load catalog.");
    }
  };

  useEffect(() => { load(); }, []);

  const have = new Set(connections.map((c) => c.serverId || c.id || "").filter(Boolean));

  const filteredCatalog = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return catalog.filter((c) => !ql || (c.name + " " + (c.description ?? "") + " " + (c.category ?? "")).toLowerCase().includes(ql));
  }, [catalog, q]);

  const connect = async (name: string) => {
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    setNote("Connecting…");
    try {
      const r = await apiFetch(`/api/mcp/connections/${encodeURIComponent(id)}/connect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const j = await r.json();
      if (j.status === "awaiting_browser" && j.authUrl) {
        window.open(j.authUrl, "_blank", "noopener");
        setNote("Opened browser for authorization.");
      } else if (j.status === "connected" || j.success) {
        setNote("Connected.");
        load();
      } else {
        setNote(j.error || "Couldn't connect.");
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't connect.");
    }
  };

  const remove = async (id: string) => {
    try {
      await apiFetch(`/api/mcp/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't remove.");
    }
  };

  const toggle = async (id: string, on: boolean) => {
    try {
      await apiFetch(`/api/mcp/connections/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !on }) });
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't toggle.");
    }
  };

  const hue = (n: string) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

  return (
    <div className="ox-int-in">
      <div className="ox-int-wrap">
        <div className="ox-int-head">
          <h1>Integrations</h1>
          <div className="ox-int-tools">
            <label className="ox-int-search">
              <Icon name="search" size={15} />
              <input placeholder="Explore more integrations" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
          </div>
        </div>
        {note && <div className="ox-int-note">{note}</div>}
        {connections.length === 0 ? (
          <div className="ox-int-empty">No integrations connected yet.</div>
        ) : (
          connections.map((c) => {
            const id = c.serverId || c.id || "";
            return (
              <div className="ox-int-row" key={id}>
                <Icon name="laptop" size={18} />
                <span>
                  <span className="nm">{c.name || id}</span>
                  <small>{c.where ?? "This computer"} · {c.toolCount ?? c.tools ?? 0} tools · {c.url ?? ""}</small>
                </span>
                <span className="sp" />
                <button className={`ox-btn soft sm${c.on === false ? " off" : ""}`} onClick={() => toggle(id, c.on !== false)}>
                  {c.on === false ? "Off" : "On"}
                </button>
                <button className="ox-btn soft icon sm" onClick={() => remove(id)} aria-label={`Remove ${c.name || id}`}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            );
          })
        )}
        <div className="ox-int-h">Popular</div>
        <div className="ox-int-grid">
          {filteredCatalog.map((c) => {
            const id = c.id;
            const added = have.has(id);
            return (
              <button key={id} className={`ox-int-tile${added ? " added" : ""}`} disabled={added} onClick={() => connect(c.name)} data-name={c.name.toLowerCase()}>
                <span className="ox-int-ic" style={{ background: `hsl(${hue(c.name)},42%,42%)` }}>{c.name[0]}</span>
                <span className="nm">{c.name}</span>
                <Icon name={added ? "check" : "plus"} size={16} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
