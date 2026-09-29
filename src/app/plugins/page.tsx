"use client";
import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api-base";

interface BundleInfo {
  name: string;
  version: string | null;
  description: string | null;
  dir: string;
  skillCount: number;
  hasHooks: boolean;
  hasMcp: boolean;
  warnings: string[];
}

interface LibraryEntry {
  slug: string;
  name: string;
  category: string;
  version: string;
  description: string;
  skillCount: number;
  hasHooks: boolean;
  hasMcp: boolean;
  installed: boolean;
  /** null = not installed; true/false = hook enforcement on/off. */
  enabled: boolean | null;
}

const ICONS: Record<string, string> = { quality: "Q", intelligence: "I", security: "S", devops: "D", domain: "M" };
const CATEGORY_ORDER = ["quality", "security", "devops", "domain", "intelligence"];

export default function PluginsPage() {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [bundles, setBundles] = useState<BundleInfo[]>([]);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [bundleBusy, setBundleBusy] = useState("");
  const [bundleMsg, setBundleMsg] = useState("");
  const [libBusy, setLibBusy] = useState("");
  const [libMsg, setLibMsg] = useState<{ slug: string; text: string; ok: boolean } | null>(null);

  const loadBundles = useCallback(() => {
    apiFetch("/api/agent/plugins")
      .then((r) => r.json())
      .then((d) => setBundles(d.plugins || []))
      .catch(() => setBundles([]));
  }, []);

  const loadLibrary = useCallback(() => {
    apiFetch("/api/agent/plugin-library")
      .then((r) => r.json())
      .then((d) => {
        setLibrary(d.library || []);
        setWorkspaceOpen(d.workspaceOpen !== false);
      })
      .catch(() => setLibrary([]));
  }, []);

  useEffect(() => {
    loadBundles();
    loadLibrary();
  }, [loadBundles, loadLibrary]);

  const installBundle = async (dir: string | null) => {
    setBundleBusy(dir || "all");
    setBundleMsg("");
    try {
      const res = await apiFetch("/api/agent/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dir ? { pluginDir: dir } : {}),
      });
      const data = await res.json();
      if (!res.ok) {
        setBundleMsg(data.error || "Install failed");
      } else {
        const parts = (data.installed || []).map(
          (r: { name: string; installedSkills: string[]; mergedHooks: number; mergedMcp: number }) =>
            `${r.name}: ${r.installedSkills.length} skill(s), ${r.mergedHooks} hook(s), ${r.mergedMcp} mcp server(s)`
        );
        setBundleMsg(`Installed — ${parts.join(" · ")}`);
        loadBundles();
      }
    } catch {
      setBundleMsg("Install failed");
    } finally {
      setBundleBusy("");
    }
  };

  const toggleBundle = async (slug: string, enabled: boolean) => {
    setLibBusy(slug);
    setLibMsg(null);
    try {
      const res = await apiFetch("/api/agent/plugin-library", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, enabled }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLibMsg({ slug, text: data.error || "Toggle failed", ok: false });
      } else {
        setLibMsg({
          slug,
          text: enabled ? "Hook rules active" : "Hook rules paused (skill files kept)",
          ok: true,
        });
        loadLibrary();
      }
    } catch {
      setLibMsg({ slug, text: "Toggle failed", ok: false });
    } finally {
      setLibBusy("");
    }
  };

  const installLibraryBundle = async (slug: string) => {
    setLibBusy(slug);
    setLibMsg(null);
    try {
      const res = await apiFetch("/api/agent/plugin-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLibMsg({ slug, text: data.error || "Install failed", ok: false });
      } else {
        const r = data.installed || {};
        setLibMsg({
          slug,
          text: `Installed — ${r.installedSkills?.length || 0} skill(s), ${r.mergedHooks || 0} hook(s) into .orplex/`,
          ok: true,
        });
        loadLibrary();
      }
    } catch {
      setLibMsg({ slug, text: "Install failed", ok: false });
    } finally {
      setLibBusy("");
    }
  };

  const q = search.trim().toLowerCase();
  const filtered = library.filter(
    (p) =>
      (filter === "all" || p.category === filter) &&
      (!q || p.name.includes(q) || p.description.toLowerCase().includes(q))
  );
  const categories = CATEGORY_ORDER.filter((c) => library.some((p) => p.category === c));
  const installedCount = library.filter((p) => p.installed).length;

  return (
    <div className="page-content" style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Plugins</h1>
        <p className="plugins-subtle" style={{ fontSize: 14 }}>
          {workspaceOpen
            ? `${installedCount} of ${library.length} built-ins installed · ${bundles.length} workspace bundle(s) found`
            : "Open a workspace folder to install plugins into it."}
        </p>
      </div>

      <div style={{ marginBottom: 28 }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Built-in library</div>
          <div className="plugins-subtle" style={{ fontSize: 12, marginTop: 2 }}>
            Skills + guardrail hooks, installed into <code>.orplex/</code> in the open workspace. Existing files are never overwritten.
          </div>
        </div>
        {!workspaceOpen ? (
          <div className="empty-state" style={{ padding: "32px 0" }}>
            <p className="empty-state-title">No workspace open</p>
            <p className="empty-state-text">Open a folder in the app, then come back — plugins install into that workspace.</p>
          </div>
        ) : (
          <>
            <div className="plugins-chips-row">
              <input
                className="plugin-search"
                placeholder="Search 40 built-ins…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button onClick={() => setFilter("all")} className="plugin-chip" data-selected={filter === "all" ? "true" : "false"}>
                All ({library.length})
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setFilter(cat)}
                  className="plugin-chip plugin-chip-cat"
                  data-cat={cat}
                  data-selected={filter === cat ? "true" : "false"}
                >
                  {cat} ({library.filter((p) => p.category === cat).length})
                </button>
              ))}
            </div>
            <div className="plugin-list">
              {filtered.map((entry) => (
                <div key={entry.slug} className="plugin-card">
                  <div className="plugin-icon" data-cat={entry.category}>{ICONS[entry.category] || "?"}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="plugin-name">
                      {entry.name}
                      <span className="plugin-meta">v{entry.version}</span>
                      <span className="plugin-cat-tag" data-cat={entry.category}>{entry.category}</span>
                    </div>
                    <div className="plugins-subtle" style={{ fontSize: 12, marginTop: 2 }}>{entry.description}</div>
                    <div className="plugin-meta" style={{ marginTop: 3 }}>
                      {entry.skillCount} skill{entry.skillCount === 1 ? "" : "s"}
                      {entry.hasHooks ? " · hooks" : ""}
                      {entry.hasMcp ? " · mcp" : ""}
                      {libMsg?.slug === entry.slug ? (
                        <span className="plugin-flash" data-ok={libMsg.ok ? "true" : "false"}>{libMsg.text}</span>
                      ) : null}
                    </div>
                  </div>
                  {entry.installed ? (
                    <div className="plugin-installed-group">
                      <span className="plugin-installed" title="First skill of this bundle exists in .orplex/skills/ — reinstall is safe (existing files win)">✓ Installed</span>
                      {entry.hasHooks && (
                        <button
                          onClick={() => toggleBundle(entry.slug, entry.enabled === false)}
                          disabled={libBusy !== ""}
                          className={`plugin-toggle ${entry.enabled === false ? "off" : ""}`}
                          data-state={entry.enabled === false ? "off" : "on"}
                          title={
                            entry.enabled === false
                              ? "Hook rules paused — click to re-enable deny/notify enforcement"
                              : "Hook rules active — click to pause enforcement (skill files stay)"
                          }
                        >
                          {entry.enabled === false ? "hooks off" : "hooks on"}
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => installLibraryBundle(entry.slug)}
                      disabled={libBusy !== ""}
                      className="plugin-install-btn"
                    >
                      {libBusy === entry.slug ? "Installing…" : "Install"}
                    </button>
                  )}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="plugins-subtle" style={{ fontSize: 13, padding: "12px 0" }}>No built-ins in this category yet.</div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="plugins-workspace-box">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Workspace bundles</div>
            <div className="plugins-subtle" style={{ fontSize: 12, marginTop: 2 }}>
              Drop a folder with <code>orplex-plugin.json</code> (+ skills/, hooks.json, mcp.json) into the workspace, then install. Existing files are never overwritten.
            </div>
          </div>
          {bundles.length > 0 && (
            <button
              onClick={() => installBundle(null)}
              disabled={bundleBusy !== ""}
              className="plugin-primary-btn"
            >
              {bundleBusy === "all" ? "Install all…" : `Install all (${bundles.length})`}
            </button>
          )}
        </div>
        {bundleMsg && <div className="plugins-ok-msg">{bundleMsg}</div>}
        {bundles.length === 0 ? (
          <div className="plugins-subtle" style={{ marginTop: 10, fontSize: 12 }}>No bundles found in this workspace.</div>
        ) : (
          <div className="plugin-list" style={{ marginTop: 12 }}>
            {bundles.map((b) => (
              <div key={b.dir} className="plugin-card" data-compact="true">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="plugin-name">
                    {b.name}
                    {b.version ? <span className="plugin-meta">v{b.version}</span> : null}
                  </div>
                  <div className="plugins-subtle" style={{ fontSize: 12, marginTop: 2 }}>
                    {b.description || "No description"} · {b.skillCount} skill{b.skillCount === 1 ? "" : "s"}
                    {b.hasHooks ? " · hooks" : ""}{b.hasMcp ? " · mcp" : ""}
                    {b.warnings.length > 0 && <span className="plugin-warning"> · {b.warnings.join(" · ")}</span>}
                  </div>
                </div>
                <button
                  onClick={() => installBundle(b.dir)}
                  disabled={bundleBusy !== ""}
                  className="plugin-install-btn"
                >
                  {bundleBusy === b.dir ? "Installing…" : "Install"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
