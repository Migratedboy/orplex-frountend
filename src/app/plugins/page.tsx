"use client";
import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api-base";

interface Plugin { name: string; category: string; description: string; enabled: boolean; }

// Real workspace bundle (skills + hooks + MCP as one installable unit)
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

const COLORS: Record<string, string> = { core: "#f97316", quality: "#22c55e", intelligence: "#3b82f6", security: "#ef4444", devops: "#a855f7", domain: "#06b6d4" };
const ICONS: Record<string, string> = { core: "C", quality: "Q", intelligence: "I", security: "S", devops: "D", domain: "M" };

const DEFAULT_PLUGINS: Plugin[] = [
  { name: "logger", category: "core", description: "Logs all tool calls and tracks usage statistics", enabled: true },
  { name: "memory-sync", category: "core", description: "Persists learning memory across sessions", enabled: true },
  { name: "cost-tracker", category: "core", description: "Tracks API costs by tier", enabled: true },
  { name: "model-router-config", category: "core", description: "Configurable tier routing", enabled: false },
  { name: "task-queue", category: "core", description: "Queues tasks when rate-limited", enabled: false },
  { name: "export-manager", category: "core", description: "Enhanced .zip export with gitignore", enabled: false },
  { name: "testgen", category: "quality", description: "Auto-generates test file stubs", enabled: true },
  { name: "linter", category: "quality", description: "Checks code quality on file writes", enabled: true },
  { name: "type-checker", category: "quality", description: "Reports TypeScript type issues", enabled: true },
  { name: "doc-gen", category: "quality", description: "Auto-generates JSDoc documentation", enabled: false },
  { name: "code-review", category: "quality", description: "Reviews code quality on every file write", enabled: false },
  { name: "prompt-enhancer", category: "intelligence", description: "Enriches vague prompts with best practices", enabled: false },
  { name: "response-cache", category: "intelligence", description: "Caches identical prompts", enabled: false },
  { name: "pattern-learner", category: "intelligence", description: "Records successful tool sequences", enabled: false },
  { name: "complexity-estimator", category: "intelligence", description: "Pre-computes task complexity", enabled: false },
  { name: "secret-scanner", category: "security", description: "Blocks hardcoded API keys and passwords", enabled: true },
  { name: "path-traversal", category: "security", description: "Prevents writes outside workspace", enabled: false },
  { name: "input-sanitizer", category: "security", description: "Sanitizes shell command arguments", enabled: true },
  { name: "git-auto-commit", category: "devops", description: "Auto-commits file changes", enabled: false },
  { name: "build-watcher", category: "devops", description: "Runs build after file changes", enabled: false },
  { name: "dep-updater", category: "devops", description: "Checks for outdated dependencies", enabled: false },
  { name: "docker-scaffold", category: "devops", description: "Auto-generates Dockerfile", enabled: false },
  { name: "ui-components", category: "domain", description: "Generates Tailwind/shadcn components", enabled: false },
  { name: "api-scaffold", category: "domain", description: "Generates REST/GraphQL API routes", enabled: false },
  { name: "db-migration", category: "domain", description: "Generates Prisma migrations", enabled: false },
];

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<Plugin[]>(DEFAULT_PLUGINS);
  const [filter, setFilter] = useState("all");
  const [bundles, setBundles] = useState<BundleInfo[]>([]);
  const [bundleBusy, setBundleBusy] = useState("");
  const [bundleMsg, setBundleMsg] = useState("");

  const loadBundles = useCallback(() => {
    apiFetch("/api/agent/plugins")
      .then((r) => r.json())
      .then((d) => setBundles(d.plugins || []))
      .catch(() => setBundles([]));
  }, []);

  useEffect(() => {
    loadBundles();
  }, [loadBundles]);

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

  const toggle = (name: string) => {
    setPlugins(prev => prev.map(p => p.name === name ? { ...p, enabled: !p.enabled } : p));
  };

  const filtered = filter === "all" ? plugins : plugins.filter(p => p.category === filter);
  const categories = [...new Set(plugins.map(p => p.category))];
  const enabledCount = plugins.filter(p => p.enabled).length;

  return (
    <div className="page-content" style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "#1a1a1a", marginBottom: 4 }}>Plugins</h1>
        <p style={{ color: "#666", fontSize: 14 }}>{enabledCount} of {plugins.length} plugins enabled</p>
      </div>

      {/* Workspace bundles — real skills+hooks+MCP installable units */}
      <div style={{ marginBottom: 28, padding: 16, borderRadius: 10, border: "1px dashed #d4d4d8", background: "#fafafa" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#1a1a1a" }}>Workspace bundles</div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
              Drop a folder with <code style={{ fontSize: 11 }}>orplex-plugin.json</code> (+ skills/, hooks.json, mcp.json) into the workspace, then install. Existing files are never overwritten.
            </div>
          </div>
          {bundles.length > 0 && (
            <button
              onClick={() => installBundle(null)}
              disabled={bundleBusy !== ""}
              style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#f97316", color: "#fff", fontWeight: 600, fontSize: 13, cursor: bundleBusy ? "default" : "pointer", opacity: bundleBusy ? 0.6 : 1 }}
            >
              {bundleBusy === "all" ? "Installing…" : `Install all (${bundles.length})`}
            </button>
          )}
        </div>
        {bundleMsg && <div style={{ marginTop: 8, fontSize: 12, color: "#2f7d4f", fontWeight: 600 }}>{bundleMsg}</div>}
        {bundles.length === 0 ? (
          <div style={{ marginTop: 10, fontSize: 12, color: "#a0a0a0" }}>No bundles found in this workspace.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
            {bundles.map((b) => (
              <div key={b.dir} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 8, border: "1px solid #e5e5e5", background: "#fff" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: "#1a1a1a" }}>
                    {b.name}
                    {b.version ? <span style={{ fontSize: 11, color: "#888", marginLeft: 6 }}>v{b.version}</span> : null}
                  </div>
                  <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                    {b.description || "No description"} · {b.skillCount} skill{b.skillCount === 1 ? "" : "s"}
                    {b.hasHooks ? " · hooks" : ""}{b.hasMcp ? " · mcp" : ""}
                  </div>
                  {b.warnings.length > 0 && (
                    <div style={{ fontSize: 11, color: "#b3362c", marginTop: 2 }}>{b.warnings.join(" · ")}</div>
                  )}
                </div>
                <button
                  onClick={() => installBundle(b.dir)}
                  disabled={bundleBusy !== ""}
                  style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #e5e5e5", background: "#fff", fontSize: 12, fontWeight: 600, cursor: bundleBusy ? "default" : "pointer", color: "#1a1a1a" }}
                >
                  {bundleBusy === b.dir ? "Installing…" : "Install"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        <button onClick={() => setFilter("all")} style={{ padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: 500, cursor: "pointer", border: "none", background: filter === "all" ? "#1a1a1a" : "#f0f0f0", color: filter === "all" ? "#fff" : "#666" }}>All ({plugins.length})</button>
        {categories.map(cat => (
          <button key={cat} onClick={() => setFilter(cat)} style={{ padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: 500, cursor: "pointer", border: "none", background: filter === cat ? (COLORS[cat] || "#666") : "#f0f0f0", color: filter === cat ? "#fff" : "#666", textTransform: "capitalize" }}>{cat} ({plugins.filter(p => p.category === cat).length})</button>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map(plugin => (
          <div key={plugin.name} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", borderRadius: 10, border: "1px solid #e5e5e5", background: "#fff" }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: (COLORS[plugin.category] || "#666") + "15", color: COLORS[plugin.category] || "#666", fontWeight: 700, fontSize: 14, flexShrink: 0 }}>{ICONS[plugin.category] || "?"}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: "#1a1a1a" }}>{plugin.name}</div>
              <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{plugin.description}</div>
            </div>
            <button onClick={() => toggle(plugin.name)} style={{ width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer", position: "relative", background: plugin.enabled ? "#f97316" : "#d1d5db", transition: "background 0.2s", flexShrink: 0 }}>
              <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: plugin.enabled ? 23 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}