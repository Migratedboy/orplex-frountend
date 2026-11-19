"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useSession, signIn, signOut as nextAuthSignOut } from "next-auth/react";
import { useTheme } from "@/components/ThemeProvider";
import { useToast } from "@/components/Toast";
import { useConversations } from "@/components/ConversationProvider";
import { apiFetch, getCachedAppVersion } from "@/lib/api-base";
import { checkForUpdates } from "@/lib/update/updateStore";
import { useShortcuts, SHORTCUT_DEFS, bindingFor, setOverride, comboFromEvent } from "@/lib/shortcuts";
import { SettingsApiKeyTab } from "@/components/settings/api-keys-tab";
import { SettingsDatabaseTab } from "@/components/settings/database-tab";
import { SettingsCostTab } from "@/components/settings/cost-tab";
import { ResetRecoveryTab } from "@/components/settings/reset-recovery-tab";
import { WarmModelsCard } from "@/components/settings/warm-models-card";
import { isArchived, unarchiveChat, archiveChat } from "@/lib/archived-chats";
import { Icon } from "@/components/ui/Icon";
import { useMarketplaceSkills } from "@/hooks/useMarketplaceSkills";
import { loadDisabledSkillIds, saveDisabledSkillIds, SKILL_SETTINGS_EVENT } from "@/lib/skill-settings";

const PAGES: { key: string; label: string }[] = [
  { key: "general", label: "General" },
  { key: "account", label: "Account" },
  { key: "appearance", label: "Appearance" },
  { key: "usage", label: "Usage" },
  { key: "providers", label: "Model Providers" },
  { key: "database", label: "Database" },
  { key: "skills", label: "Skills" },
  { key: "shortcuts", label: "Keyboard shortcuts" },
  { key: "archived", label: "Archived" },
  { key: "about", label: "About" },
  { key: "reset", label: "Reset & Recovery" },
];

const LEGACY: Record<string, string> = {
  profile: "account",
  api: "providers",
  cost: "providers",
  danger: "reset",
  keyboard: "shortcuts",
};

function pageKeyFromUrl(): string {
  const t = new URLSearchParams(window.location.search).get("tab");
  if (!t) return "general";
  const lower = t.toLowerCase();
  if (LEGACY[lower]) return LEGACY[lower];
  const found = PAGES.find((p) => p.key === lower || p.label.toLowerCase() === lower);
  return found ? found.key : "general";
}

export default function SettingsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const [active, setActive] = useState<string>(() => (typeof window !== "undefined" ? pageKeyFromUrl() : "general"));
  const [query, setQuery] = useState("");

  useEffect(() => {
    const read = () => setActive(pageKeyFromUrl());
    const onEvt = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === "string") {
        const mapped = LEGACY[detail.toLowerCase()] ?? detail.toLowerCase();
        const found = PAGES.find((p) => p.key === mapped || p.label.toLowerCase() === mapped);
        if (found) setActive(found.key);
      } else read();
    };
    read();
    window.addEventListener("popstate", read);
    window.addEventListener("orplex:settings-tab", onEvt);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener("orplex:settings-tab", onEvt);
    };
  }, []);

  const switchPage = (key: string) => {
    setActive(key);
    router.replace(`/settings?tab=${key}`, { scroll: false });
    window.dispatchEvent(new CustomEvent("orplex:settings-tab", { detail: key }));
  };

  const filtered = useMemo(
    () => PAGES.filter((p) => p.label.toLowerCase().includes(query.trim().toLowerCase())),
    [query]
  );

  const renderPage = () => {
    switch (active) {
      case "general": return <GeneralPage />;
      case "account": return <AccountPage />;
      case "appearance": return <AppearancePage />;
      case "usage": return <UsagePage />;
      case "providers": return <ProvidersPage />;
      case "database": return <DatabasePage />;
      case "skills": return <SkillsPage />;
      case "shortcuts": return <ShortcutsPage />;
      case "archived": return <ArchivedPage />;
      case "about": return <AboutPage />;
      case "reset": return <ResetPage />;
      default: return <GeneralPage />;
    }
  };

  return (
    <div className="ox-settings-in">
      <nav className="ox-s-nav">
        <h2>Settings</h2>
        <label className="ox-s-search">
          <Icon name="search" size={15} />
          <input placeholder="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        </label>
        <div>
          {filtered.map((p) => (
            <button
              key={p.key}
              className={`ox-s-item${active === p.key ? " on" : ""}`}
              onClick={() => switchPage(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </nav>
      <div className="ox-s-main">{renderPage()}</div>
    </div>
  );
}

// ---------- shared small components ----------
function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button className="ox-sw" role="switch" aria-checked={on} onClick={onClick} />;
}
function Row({ label, help, on, onToggle }: { label: string; help?: string; on: boolean; onToggle: () => void }) {
  return (
    <div className="ox-set-row">
      <span className="ox-lbl">
        {label}
        {help && <span title={help} style={{ display: "inline-flex", color: "var(--muted)" }}><Icon name="help" size={15} /></span>}
      </span>
      <Switch on={on} onClick={onToggle} />
    </div>
  );
}

// ---------- General ----------
function GeneralPage() {
  const { toast } = useToast();
  const [version, setVersion] = useState<string>("");
  const [arch, setArch] = useState("never");
  const [advanced, setAdvanced] = useState(true);
  const [sounds, setSounds] = useState(true);
  const [autoRenew, setAutoRenew] = useState(true);
  const [agentsMd, setAgentsMd] = useState(true);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    getCachedAppVersion().then((v) => setVersion(v ?? "dev"));
    try {
      const s = JSON.parse(localStorage.getItem("orplex-settings") ?? "{}");
      if (typeof s.advancedMode === "boolean") setAdvanced(s.advancedMode);
      if (typeof s.sounds === "boolean") setSounds(s.sounds);
      if (typeof s.autoRenew === "boolean") setAutoRenew(s.autoRenew);
      if (typeof s.autoArchive === "string") setArch(s.autoArchive);
      if (typeof s.agentsMd === "boolean") setAgentsMd(s.agentsMd);
    } catch {}
  }, []);

  const persist = (patch: Record<string, unknown>) => {
    try {
      const cur = JSON.parse(localStorage.getItem("orplex-settings") ?? "{}");
      localStorage.setItem("orplex-settings", JSON.stringify({ ...cur, ...patch }));
    } catch {}
    window.dispatchEvent(new CustomEvent("orplex:setting", { detail: { ...patch } }));
  };

  const toggle = (key: string, val: boolean, set: (v: boolean) => void) => {
    set(val);
    persist({ [key]: val });
  };

  const checkUpdates = async () => {
    setChecking(true);
    setMsg("");
    try {
      const res = await checkForUpdates(true);
      if (res?.state === "available") setMsg("Update available.");
      else if (res?.state === "error" && res.error) setMsg(res.error);
      else if (res?.state === "idle") setMsg("You're up to date.");
      else setMsg("Check finished.");
    } catch {
      setMsg("Update check failed.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="ox-s-wrap">
      <h1 className="ox-s-title">General</h1>
      <div className="ox-card">
        <h3 className="ox-solo">Composer</h3>
        <Row label="Advanced Mode" help="Show extra controls in the message composer." on={advanced} onToggle={() => toggle("advancedMode", !advanced, setAdvanced)} />
      </div>
      <div className="ox-card">
        <h3 className="ox-solo">Notifications</h3>
        <Row label="Notification sounds" help="Play a sound when the agent finishes or needs you." on={sounds} onToggle={() => toggle("sounds", !sounds, setSounds)} />
      </div>
      <div className="ox-card">
        <h3 className="ox-solo">Sessions</h3>
        <Row label="Auto-renew sessions" help="Start a new session automatically when the current one ends." on={autoRenew} onToggle={() => toggle("autoRenew", !autoRenew, setAutoRenew)} />
      </div>
      <div className="ox-card">
        <h3 className="ox-solo">Feedback</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="ox-btn soft" onClick={() => window.dispatchEvent(new CustomEvent("orplex:bug-report"))}>Report issue or feature</button>
        </div>
      </div>
      <div className="ox-card">
        <div className="ox-set-row">
          <span className="ox-lbl" style={{ fontWeight: 600 }}>
            Auto-archive chats
            <span title="Move old chats to Archived after this long." style={{ display: "inline-flex", color: "var(--muted)" }}><Icon name="help" size={15} /></span>
          </span>
          <select className="ox-sel" value={arch} onChange={(e) => { setArch(e.target.value); persist({ autoArchive: e.target.value }); }}>
            <option value="never">Never</option>
            <option value="1">After 1 day</option>
            <option value="7">After 7 days</option>
            <option value="30">After 30 days</option>
          </select>
        </div>
      </div>
      <div className="ox-card">
        <h3 className="ox-solo">Agent instructions</h3>
        <Row label="Include AGENTS.md" help="Send your project's AGENTS.md to the agent with every request." on={agentsMd} onToggle={() => toggle("agentsMd", !agentsMd, setAgentsMd)} />
      </div>
      <div className="ox-card">
        <h3 className="ox-solo">Version</h3>
        <div className="ox-set-row">
          <span className="ox-lbl" style={{ fontWeight: 600 }}>Orplex Code {version || "…"}</span>
          <button className="ox-btn soft" onClick={checkUpdates} disabled={checking}>{checking ? "Checking…" : "Check for updates"}</button>
        </div>
        {msg && <div className="ox-note">{msg}</div>}
      </div>
    </div>
  );
}

// ---------- Account ----------
function AccountPage() {
  const { data: session, update } = useSession();
  const { toast } = useToast();
  const router = useRouter();
  const [name, setName] = useState(session?.user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [accErr, setAccErr] = useState("");
  const [editField, setEditField] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [linkedProviders, setLinkedProviders] = useState<string[]>([]);
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => { if (session?.user?.name) setName(session.user.name); }, [session?.user?.name]);

  const loadProviders = useCallback(async () => {
    try {
      const res = await apiFetch("/api/account/providers");
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success) setLinkedProviders(data.providers || []);
    } catch {}
  }, []);
  useEffect(() => { void loadProviders(); }, [loadProviders]);

  const connectProvider = (provider: "github" | "google") => {
    void signIn(provider, { callbackUrl: "/settings" });
  };

  const disconnectProvider = async (provider: string) => {
    setProviderBusy(provider);
    try {
      const res = await apiFetch(`/api/account/providers/${provider}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) { toast(data?.error || "Disconnect failed", "error"); return; }
      toast(`${provider} disconnected`, "success");
      await loadProviders();
    } catch {
      toast("Disconnect failed", "error");
    } finally {
      setProviderBusy(null);
    }
  };

  const deleteAccount = async () => {
    if (deleteConfirm !== email) return;
    setDeleteBusy(true);
    try {
      const res = await apiFetch("/api/account", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: deleteConfirm }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) { toast(data?.error || "Deletion failed", "error"); return; }
      toast("Account deleted", "success");
      setDeleteOpen(false);
      await nextAuthSignOut({ redirect: false });
      router.push("/auth/signin");
    } catch {
      toast("Deletion failed", "error");
    } finally {
      setDeleteBusy(false);
    }
  };

  const saveProfile = async () => {
    if (editField === "name" && (!editVal.trim() || editVal.length > 40)) { setAccErr("Display name must be 1–40 characters."); return; }
    if (editField === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(editVal)) { setAccErr("Enter a valid email address."); return; }
    setSaving(true);
    try {
      if (editField === "name") {
        await apiFetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: editVal }) });
        await update();
        setName(editVal);
        toast("Profile saved", "success");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      toast("Failed to save profile", "error");
    } finally {
      setSaving(false);
      setEditField(null);
      setAccErr("");
    }
  };

  const startEdit = (field: string, val: string) => {
    setEditField(field);
    setEditVal(val);
    setAccErr("");
  };

  const email = session?.user?.email ?? "";

  const signOut = async () => {
    try {
      await apiFetch("/api/session/clear", { method: "POST" });
    } catch {}
    try {
      const { signOut: so } = await import("next-auth/react");
      await so({ redirect: false });
    } catch {}
    router.push("/auth/signin");
  };

  return (
    <div className="ox-s-wrap">
      <h1 className="ox-s-title">Account</h1>
      <div className="ox-card">
        <div className="ox-acc-row">
          <span className="k">Display name</span>
          <span className="v">
            {editField === "name" ? (
              <>
                <input value={editVal} onChange={(e) => setEditVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveProfile(); if (e.key === "Escape") { setEditField(null); setAccErr(""); } }} autoFocus />
                <button className="ox-btn sm" onClick={saveProfile} disabled={saving}>{saving ? "…" : "Save"}</button>
                <button className="ox-btn soft sm" onClick={() => { setEditField(null); setAccErr(""); }}>Cancel</button>
              </>
            ) : (
              <>
                <span>{name || "User"}</span>
                <button className="ox-btn soft icon" onClick={() => startEdit("name", name)} aria-label="Edit display name"><Icon name="edit" size={17} /></button>
              </>
            )}
          </span>
        </div>
        <div className="ox-acc-row">
          <span className="k">Email</span>
          <span className="v">
            {editField === "email" ? (
              <>
                <input type="email" value={editVal} onChange={(e) => setEditVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveProfile(); if (e.key === "Escape") { setEditField(null); setAccErr(""); } }} autoFocus />
                <button className="ox-btn sm" onClick={saveProfile} disabled={saving}>{saving ? "…" : "Save"}</button>
                <button className="ox-btn soft sm" onClick={() => { setEditField(null); setAccErr(""); }}>Cancel</button>
              </>
            ) : (
              <>
                <span>{email}</span>
                <button className="ox-btn soft icon" onClick={() => startEdit("email", email)} aria-label="Edit email"><Icon name="edit" size={17} /></button>
              </>
            )}
          </span>
        </div>
        {accErr && <div className="ox-note" style={{ color: "#e5484d" }}>{accErr}</div>}
      </div>
      <div className="ox-card flat">
        <h3 className="ox-solo">Sign-in methods</h3>
        {(["github", "google"] as const).map((p) => {
          const linked = linkedProviders.includes(p);
          const label = p === "github" ? "GitHub" : "Google";
          return (
            <div key={p} className="ox-acc-row">
              <span className="k">{label}</span>
              <span className="v">
                {linked ? (
                  <button className="ox-btn soft sm" disabled={providerBusy === p} onClick={() => void disconnectProvider(p)}>
                    {providerBusy === p ? "…" : "Disconnect"}
                  </button>
                ) : (
                  <button className="ox-btn soft sm" onClick={() => connectProvider(p)}>Connect</button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className="ox-card">
        <h3 className="ox-solo">Delete account</h3>
        <div className="ox-set-row">
          <span className="ox-acc-del-txt">Cancel any subscriptions before deleting your account. This is irreversible.</span>
          <span className="ox-acc-del-actions">
            <button className="ox-btn danger" onClick={() => { setDeleteConfirm(""); setDeleteOpen(true); }}>Delete account</button>
          </span>
        </div>
      </div>
      {deleteOpen && (
        <div className="modal-overlay" onClick={() => !deleteBusy && setDeleteOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h3>Delete account</h3>
              <button className="modal-close" onClick={() => !deleteBusy && setDeleteOpen(false)} aria-label="Close">✕</button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={{ fontSize: 13 }}>Type your email <strong>{email}</strong> to confirm deletion.</p>
              <input
                className="settings-input"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder={email}
                autoFocus
              />
            </div>
            <div className="modal-footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="modal-cancel-btn" onClick={() => setDeleteOpen(false)} disabled={deleteBusy}>Cancel</button>
              <button className="modal-submit-btn" style={{ background: "#e5484d" }} onClick={() => void deleteAccount()} disabled={deleteBusy || deleteConfirm !== email}>
                {deleteBusy ? "Deleting…" : "Delete forever"}
              </button>
            </div>
          </div>
        </div>
      )}
      <button className="ox-btn soft" onClick={signOut}>Sign out</button>
    </div>
  );
}

// ---------- Appearance ----------
function AppearancePage() {
  const { pref, setPref } = useTheme();
  const pv = (a: string, b: string, c: string) => (
    <div className="ox-pv">
      <i style={{ width: "22%", background: a }} />
      <i style={{ flex: 1, background: b }} />
      <i style={{ width: "28%", background: c }} />
    </div>
  );
  const opts: [string, string, string, React.ReactNode][] = [
    ["light", "Light", "Bright surfaces", pv("#f6f6f8", "#ffffff", "#eeeef1")],
    ["dark", "Dark", "Easy on the eyes", pv("#212122", "#1b1b1c", "#272728")],
    ["system", "System", "Match your device",
      <div className="ox-pv" key="sys">
        <div style={{ flex: 1, display: "flex" }}>{pv("#f6f6f8", "#ffffff", "#eeeef1")}</div>
        <div style={{ flex: 1, display: "flex" }}>{pv("#212122", "#1b1b1c", "#272728")}</div>
      </div>],
  ];
  return (
    <div className="ox-s-wrap">
      <h1 className="ox-s-title">Appearance</h1>
      <div className="ox-card">
        <h3>Theme</h3>
        <div className="ox-themes">
          {opts.map(([k, n, d, v]) => (
            <button key={k} className={`ox-theme${pref === k ? " on" : ""}`} data-theme={k} onClick={() => setPref(k as "light" | "dark" | "system")}>
              {v}
              <b>{n}</b>
              <small>{d}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Usage ----------
function UsagePage() {
  const [used, setUsed] = useState(0);
  const [limit, setLimit] = useState(50);
  const [runs, setRuns] = useState<Array<{ createdAt: string; totalTokens: number; promptTokens: number | null; completionTokens: number | null }>>([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch("/api/user/quota");
        const j = await r.json();
        setUsed((j.limit ?? 50) - (j.remaining ?? 50));
        setLimit(j.limit ?? 50);
      } catch {}
      try {
        const r = await apiFetch("/api/agent/spend");
        const j = await r.json();
        if (Array.isArray(j.history)) setRuns(j.history);
      } catch {}
    })();
  }, []);

  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  // active days from spend runs
  const activeDays = useMemo(() => {
    const set = new Set<string>();
    runs.forEach((r) => {
      try {
        const d = new Date(r.createdAt);
        set.add(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"));
      } catch {}
    });
    return set;
  }, [runs]);

  const last7 = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity
const cutoff = Date.now() - 7 * 86400000;
    let messages = 0, input = 0, output = 0, cacheRead = 0;
    runs.forEach((r) => {
      const t = new Date(r.createdAt).getTime();
      if (t >= cutoff) {
        messages += 1;
        input += r.promptTokens ?? 0;
        output += r.completionTokens ?? 0;
      }
    });
    return { messages, input, output, cacheRead };
  }, [runs]);

  const fmtTok = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n);

  // heatmap cells: 52 weeks
  const heatCells = useMemo(() => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const lastWeek = new Date(today);
    lastWeek.setDate(today.getDate() - today.getDay());
    const start = new Date(lastWeek);
    start.setDate(start.getDate() - 51 * 7);
    const cells: { k: string; future: boolean; active: boolean }[] = [];
    for (let i = 0; i < 52 * 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      cells.push({ k, future: d > today, active: activeDays.has(k) });
    }
    return cells;
  }, [activeDays]);

  const streaks = useMemo(() => {
    let cur = 0;
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    if (!activeDays.has(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"))) d.setDate(d.getDate() - 1);
    while (true) {
      const k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      if (!activeDays.has(k)) break;
      cur++;
      d.setDate(d.getDate() - 1);
    }
    let best = 0, run = 0, prev: number | null = null;
    [...activeDays].sort().forEach((k) => {
      const now = new Date(k + "T12:00:00").getTime();
      run = prev && Math.round((now - prev) / 86400000) === 1 ? run + 1 : 1;
      best = Math.max(best, run);
      prev = now;
    });
    return { cur, best };
  }, [activeDays]);

  return (
    <div className="ox-s-wrap">
      <h1 className="ox-s-title">Usage</h1>
      <div className="ox-card ox-meter">
        <h3>Hours</h3>
        <div className="ox-top"><span>Daily</span><span>{pct}% used</span></div>
        <div className="ox-bar"><i style={{ width: pct + "%" }} /></div>
      </div>
      <div className="ox-card">
        <h3>Activity</h3>
        <div className="ox-stats">
          <div className="ox-stat"><small>Current streak</small><b>{streaks.cur} days</b></div>
          <div className="ox-stat"><small>Longest streak</small><b>{streaks.best} days</b></div>
          <div className="ox-stat"><small>Active days</small><b>{activeDays.size}</b></div>
        </div>
        <div className="ox-heat">
          {heatCells.map((c) => (
            <i key={c.k} className={c.active ? "a" : ""} style={c.future ? { visibility: "hidden" } : undefined} title={c.k} />
          ))}
        </div>
      </div>
      <div className="ox-card">
        <h3>Last 7 days</h3>
        <div className="ox-stats two">
          <div className="ox-stat"><small>Messages</small><b>{last7.messages.toLocaleString()}</b></div>
          <div className="ox-stat"><small>Total tokens</small><b>{fmtTok(last7.input + last7.output)}</b></div>
        </div>
        <div className="ox-lines">
          <div className="ox-ln"><span>Input tokens</span><span>{fmtTok(last7.input)}</span></div>
          <div className="ox-ln"><span>Output tokens</span><span>{fmtTok(last7.output)}</span></div>
        </div>
      </div>
    </div>
  );
}

// ---------- Model Providers ----------
function ProvidersPage() {
  const { toast } = useToast();
  return (
    <div className="ox-s-wrap">
      <h1 className="ox-s-title">Model Providers</h1>
      <div className="ox-card">
        <div className="ox-db-row">
          <div><b>Warm models</b><p>Every verified model is live — nothing to warm.</p></div>
          <WarmModelsCard toast={toast} />
        </div>
      </div>
      <SettingsApiKeyTab toast={toast} />
    </div>
  );
}

// ---------- Database ----------
function DatabasePage() {
  const { toast } = useToast();
  return (
    <div className="ox-s-wrap">
      <h1 className="ox-s-title">Database</h1>
      <SettingsDatabaseTab />
    </div>
  );
}

// ---------- Skills ----------
function SkillsPage() {
  const [disabled, setDisabled] = useState<Set<string>>(() => loadDisabledSkillIds());
  const [q, setQ] = useState("");
  useEffect(() => {
    const handler = () => setDisabled(loadDisabledSkillIds());
    window.addEventListener(SKILL_SETTINGS_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(SKILL_SETTINGS_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  const { categories: skillCategories, loading: skillsLoading, source: skillsSource, error: skillsError } = useMarketplaceSkills();

  const allSkills = useMemo(
    () => skillCategories.flatMap((c) => c.skills.map((s) => ({ ...s, categoryName: c.name }))),
    [skillCategories]
  );
  const filtered = useMemo(
    () => allSkills.filter((s) => !q.trim() || (s.name + " " + (s.description ?? "") + " " + s.category + " " + s.categoryName).toLowerCase().includes(q.toLowerCase())),
    [allSkills, q]
  );
  const toggle = useCallback((id: string) => {
    const next = new Set(disabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    saveDisabledSkillIds(next);
    setDisabled(next);
  }, [disabled]);

  return (
    <div className="ox-s-wrap">
      <h1 className="ox-s-title">Skills</h1>
      <div className="ox-card ox-sk-card">
        <input className="ox-sk-search" placeholder="Search skills" value={q} onChange={(e) => setQ(e.target.value)} />
        <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 8 }}>
          {filtered.length} of {allSkills.length} skills · {allSkills.length - disabled.size} enabled
        </div>
        <div>
          {filtered.length === 0 && <div className="ox-sk-empty">No skills match.</div>}
          {filtered.map((s) => {
            const enabled = !disabled.has(s.id);
            return (
              <div className="ox-sk" key={s.id}>
                <span className="ox-sk-ic">{s.icon}</span>
                <div className="ox-sk-body">
                  <b>{s.name}</b>
                  <p>{s.description}</p>
                </div>
                <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={enabled} onChange={() => toggle(s.id)} />
                </label>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- Keyboard shortcuts ----------
function ShortcutsPage() {
  const [overrides, setOverridesState] = useState<Record<string, string>>(() => (typeof window !== "undefined" ? (JSON.parse(localStorage.getItem("orplex.shortcutOverrides") ?? "{}")) : {}));
  const [capture, setCapture] = useState<string | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");

  const reload = () => setOverridesState(JSON.parse(localStorage.getItem("orplex.shortcutOverrides") ?? "{}"));

  const binding = useCallback((id: string) => overrides[id] ?? SHORTCUT_DEFS.find((d) => d.id === id)?.keys ?? "", [overrides]);

  const groups = useMemo(() => [...new Set(SHORTCUT_DEFS.map((d) => d.group))], []);

  const filteredDefs = useMemo(() => {
    const query = q.trim().toLowerCase();
    return SHORTCUT_DEFS.filter((d) => !query || (d.label + " " + d.group + " " + binding(d.id)).toLowerCase().includes(query));
  }, [q, binding]);

  useEffect(() => {
    if (!capture) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") { setCapture(null); return; }
      const combo = comboFromEvent(e);
      if (!combo) return;
      const hasMod = combo.includes("Ctrl") || combo.includes("Alt");
      const isF = /^F\d/.test(combo.split("+").pop() ?? "");
      let err = "";
      if (!hasMod && !isF) err = "Use Ctrl or Alt together with a key.";
      else {
        const other = SHORTCUT_DEFS.find((d) => d.id !== capture && binding(d.id) === combo);
        if (other) err = combo + " is already used by “" + other.label + "”.";
      }
      if (err) { setErrs({ [capture]: err }); return; }
      const def = SHORTCUT_DEFS.find((d) => d.id === capture);
      if (def && combo === def.keys) setOverride(capture, "");
      else setOverride(capture, combo);
      setCapture(null);
      setErrs({});
      reload();
      window.dispatchEvent(new CustomEvent("orplex:shortcut-changed", { detail: { id: capture, keys: combo } }));
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture]);

  const clear = (id: string) => { setOverride(id, ""); reload(); };
  const resetOne = (id: string) => { setOverride(id, ""); reload(); };
  const resetAll = () => {
    Object.keys(overrides).forEach((k) => setOverride(k, ""));
    try { localStorage.removeItem("orplex.shortcutOverrides"); } catch {}
    reload();
  };

  return (
    <div className="ox-s-wrap ox-ks">
      <h1 className="ox-s-title">Keyboard shortcuts</h1>
      <p className="ox-ks-sub">Click a shortcut to change it.</p>
      <div className="ox-ks-bar">
        <label className="ox-s-search" style={{ flex: 1, margin: 0 }}>
          <Icon name="search" size={15} />
          <input placeholder="Search shortcuts" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        </label>
        <button className="ox-btn soft" onClick={resetAll}>Reset all</button>
      </div>
      {groups.map((g) => {
        const rows = filteredDefs.filter((d) => d.group === g);
        if (rows.length === 0) return null;
        return (
          <div key={g}>
            <div className="ox-ks-g">{g}</div>
            {rows.map((d) => {
              const keys = binding(d.id).split("+").filter(Boolean);
              const modified = overrides[d.id] !== undefined;
              return (
                <div key={d.id}>
                  <div className="ox-ks-row">
                    <span>{d.label}</span>
                    <span className="ox-ks-r">
                      {modified && keys.length > 0 && (
                        <button className="ox-ks-ic" onClick={() => clear(d.id)} aria-label="Remove shortcut" title="Remove shortcut"><Icon name="x" size={14} /></button>
                      )}
                      {modified && (
                        <button className="ox-ks-ic bg" onClick={() => resetOne(d.id)} aria-label="Reset to default" title="Reset to default"><Icon name="undo" size={14} /></button>
                      )}
                      {capture === d.id ? (
                        <span className="ox-ks-cap">Press new shortcut…<small>Esc to cancel</small></span>
                      ) : (
                        <button className="ox-ks-keys" onClick={() => setCapture(d.id)} aria-label={`Change shortcut for ${d.label}`}>
                          {keys.length ? keys.map((k, i) => <span className="ox-kc" key={i}>{k}</span>) : <span className="ox-ks-none">Unassigned</span>}
                        </button>
                      )}
                    </span>
                  </div>
                  {errs[d.id] && <div className="ox-ks-err" role="alert">{errs[d.id]}</div>}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Archived ----------
function ArchivedPage() {
  const { conversations, deleteConversation, refresh } = useConversations();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener("orplex:archived-changed", on);
    return () => window.removeEventListener("orplex:archived-changed", on);
  }, []);
  const archived = conversations.filter((c) => isArchived(c.id));
  return (
    <div className="ox-s-wrap">
      <h1 className="ox-s-title">Archived</h1>
      {archived.length === 0 ? (
        <div className="ox-card"><p style={{ color: "var(--muted)" }}>No archived chats.</p></div>
      ) : (
        <div className="ox-card">
          {archived.map((c) => (
            <div className="ox-arch-row" key={c.id}>
              <span className="ox-nm">{c.title}</span>
              <small>{new Date(c.updatedAt).toLocaleDateString()}</small>
              <button className="ox-btn soft sm" onClick={() => { unarchiveChat(c.id); setTick((t) => t + 1); }}>Restore</button>
              <button className="ox-btn danger sm" onClick={async () => { if (!confirm("Delete this chat permanently?")) return; await deleteConversation(c.id); unarchiveChat(c.id); refresh(); }}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- About ----------
function AboutPage() {
  const [version, setVersion] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => { getCachedAppVersion().then((v) => setVersion(v ?? "dev")); }, []);
  const check = async () => {
    setChecking(true); setMsg("");
    try {
      const res = await checkForUpdates(true);
      if (res?.state === "available") setMsg("Update available.");
      else if (res?.state === "error" && res.error) setMsg(res.error);
      else if (res?.state === "idle") setMsg("You're up to date.");
      else setMsg("Check finished.");
    } catch { setMsg("Update check failed."); }
    finally { setChecking(false); }
  };
  return (
    <div className="ox-s-wrap">
      <h1 className="ox-s-title">About</h1>
      <div className="ox-card">
        <div className="ox-set-row"><span className="ox-lbl" style={{ fontWeight: 600 }}>Version</span><span>{version || "…"}</span></div>
        <div className="ox-set-row"><span className="ox-lbl" style={{ fontWeight: 600 }}>Build</span><span>Production</span></div>
        <div className="ox-set-row"><span className="ox-lbl" style={{ fontWeight: 600 }}>Framework</span><span>Next.js + TypeScript</span></div>
        <div className="ox-set-row"><span className="ox-lbl" style={{ fontWeight: 600 }}>AI Backend</span><span>Multi-provider (OpenRouter, NVIDIA, Claude, Gemini)</span></div>
        <div style={{ marginTop: 12 }}>
          <button className="ox-btn soft" onClick={check} disabled={checking}>{checking ? "Checking…" : "Check for updates"}</button>
          {msg && <div className="ox-note">{msg}</div>}
        </div>
      </div>
    </div>
  );
}

// ---------- Reset & Recovery ----------
function ResetPage() {
  const { toast } = useToast();
  return (
    <div className="ox-s-wrap">
      <h1 className="ox-s-title">Reset &amp; Recovery</h1>
      <div className="ox-card">
        <ResetRecoveryTab toast={toast} />
      </div>
    </div>
  );
}
