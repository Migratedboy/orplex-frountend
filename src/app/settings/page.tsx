"use client";

/* eslint-disable @next/next/no-img-element -- Every image here is either a remote avatar from an arbitrary OAuth host or user content. next/image would need a remotePatterns entry per provider and static dimensions we do not have. */
import { useState, useEffect } from "react";
import { apiFetch, getCachedAppVersion } from "@/lib/api-base";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { useUpdateStore, checkForUpdates } from "@/lib/update/updateStore";
import { IconCheck } from "@/components/Icons";
import { SettingsApiKeyTab } from "@/components/settings/api-keys-tab";
import { SettingsCostTab } from "@/components/settings/cost-tab";
import { ResetRecoveryTab } from "@/components/settings/reset-recovery-tab";

// === About tab: live version + update check ================================
// Version comes from the packaged app (Electron bridge), not a hardcoded
// string. "Check for updates" kicks the main-process check — results surface
// in the UpdateToast card (mounted in AppLayout), not here.
function AppVersion() {
  const [version, setVersion] = useState<string>("…");
  useEffect(() => {
    let live = true;
    getCachedAppVersion().then((v) => {
      if (live) setVersion(v || "dev");
    }).catch(() => {
      if (live) setVersion("dev");
    });
    return () => { live = false; };
  }, []);
  return <>{version}</>;
}

function UpdateCheckRow() {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const store = useUpdateStore();

  // Mirror store phase into the status line.
  useEffect(() => {
    if (store.phase === "downloading" && store.version) {
      setMessage(`Downloading Orplex v${store.version}…`);
    } else if (store.phase === "ready" && store.version) {
      setMessage(`Update v${store.version} ready to install.`);
    } else if (store.phase === "error" && store.error) {
      setMessage(store.error);
    }
  }, [store.phase, store.version, store.error]);

  const isDesktop = typeof window !== "undefined" && !!(window as unknown as { orplexDesktop?: unknown }).orplexDesktop;
  if (!isDesktop) return null;

  const check = async () => {
    setChecking(true);
    setMessage(null);
    try {
      const res = await checkForUpdates(true);
      if (res?.state === "available" && res.version) {
        setMessage(`Update v${res.version} found — downloading in the background.`);
      } else if (res?.state === "error" && res.error) {
        setMessage(res.error);
      } else if (res?.state === "idle") {
        setMessage("You're up to date.");
      } else {
        setMessage("Check finished.");
      }
    } catch {
      setMessage("Update check failed.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="settings-actions" style={{ marginTop: 12, flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
      <button onClick={check} disabled={checking} className="settings-save-btn">
        {checking ? "Checking..." : "Check for updates"}
      </button>
      {message ? <p className="settings-hint" style={{ margin: 0 }}>{message}</p> : null}
    </div>
  );
}






export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("profile");
  // Deep links (/settings?tab=api) and sidebar-driven switches arrive without
  // remounting this page (query-only pushes don't re-run mount effects), so
  // sync the tab from the URL + the orplex:settings-tab nav event.
  useEffect(() => {
    const readUrlTab = () => {
      const t = new URLSearchParams(window.location.search).get("tab");
      if (t) setActiveTab(t);
    };
    const onSettingsTab = (e: Event) => setActiveTab((e as CustomEvent<string>).detail);
    readUrlTab();
    window.addEventListener("popstate", readUrlTab);
    window.addEventListener("orplex:settings-tab", onSettingsTab);
    return () => {
      window.removeEventListener("popstate", readUrlTab);
      window.removeEventListener("orplex:settings-tab", onSettingsTab);
    };
  }, []);
  const router = useRouter();
  const { data: session, update } = useSession();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (session?.user?.name) setName(session.user.name); }, [session?.user?.name]);

  const saveProfile = async () => {
    setSaving(true);
    try {
      await apiFetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      await update();
      setSaved(true);
      toast("Profile saved", "success");
      setTimeout(() => setSaved(false), 2000);
    } catch { toast("Failed to save profile", "error"); }
    setSaving(false);
  };

  const tabs = [
    { id: "profile", label: "Profile" },
    { id: "appearance", label: "Appearance" },
    { id: "cost", label: "Provider & Cost" },
    { id: "api", label: "API Keys" },
    { id: "about", label: "About" },
    { id: "danger", label: "Reset & Recovery" },
  ];

  // Tab switches update the URL (so ?tab= stays shareable/back-nav friendly)
  // and tell the sidebar, which tracks the active tab via the
  // orplex:settings-tab event — usePathname can't see query params.
  const switchTab = (id: string) => {
    setActiveTab(id);
    router.replace(`/settings?tab=${id}`, { scroll: false });
    window.dispatchEvent(new CustomEvent("orplex:settings-tab", { detail: id }));
  };

  return (
      <div className="page-content">
        <div className="settings-layout">
          <aside className="settings-sidebar">
            <div className="settings-sidebar-header">
              <span className="settings-sidebar-title">Settings</span>
            </div>
            {tabs.map((tab) => (
              <button key={tab.id} onClick={() => switchTab(tab.id)}
                className={`settings-tab ${activeTab === tab.id ? "active" : ""}`}>
                {tab.label}
              </button>
            ))}
          </aside>
          <div className="settings-main">
            {activeTab === "profile" && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">Profile</h2>
                  <p className="settings-section-desc">Manage your personal information and display name.</p>
                </div>
                <div className="settings-card">
                  <div className="settings-profile">
                    <div className="settings-avatar-section">
                      <div className="settings-avatar-large">
                        {session?.user?.image ? (
                          <img src={session.user.image} alt="Avatar" />
                        ) : (
                          <span>{(session?.user?.name || "U")[0].toUpperCase()}</span>
                        )}
                      </div>
                      <div className="settings-avatar-info">
                        <p className="settings-avatar-name">{session?.user?.name || "User"}</p>
                        <p className="settings-avatar-email">{session?.user?.email || ""}</p>
                      </div>
                    </div>
                    <div className="settings-divider" />
                    <div className="settings-fields">
                      <div className="settings-field">
                        <label className="settings-label">Display Name</label>
                        <input className="settings-input" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter your name" />
                      </div>
                      <div className="settings-field">
                        <label className="settings-label">Email Address</label>
                        <input className="settings-input settings-input-disabled" disabled type="email" value={session?.user?.email || ""} />
                        <p className="settings-hint">Managed by your OAuth provider</p>
                      </div>
                    </div>
                    <div className="settings-actions">
                      <button onClick={saveProfile} disabled={saving || name === session?.user?.name} className="settings-save-btn">
                        {saved ? <><IconCheck size={14} /> Saved</> : saving ? "Saving..." : "Save Changes"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "appearance" && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">Appearance</h2>
                  <p className="settings-section-desc">Customize the look and feel of Orplex Code.</p>
                </div>
                <div className="settings-card">
                  <div className="settings-toggle-row">
                    <div className="settings-toggle-info">
                      <span className="settings-toggle-label">Dark Mode</span>
                      <span className="settings-toggle-desc">Switch between light and dark themes</span>
                    </div>
                    <span className="settings-toggle-hint">Use the toggle in the top bar</span>
                  </div>
                  <div className="settings-divider" />
                  <div className="settings-toggle-row">
                    <div className="settings-toggle-info">
                      <span className="settings-toggle-label">Compact Messages</span>
                      <span className="settings-toggle-desc">Reduce spacing in chat messages</span>
                    </div>
                    <span className="settings-toggle-badge">Coming Soon</span>
                  </div>
                  <div className="settings-divider" />
                  <div className="settings-toggle-row">
                    <div className="settings-toggle-info">
                      <span className="settings-toggle-label">Font Size</span>
                      <span className="settings-toggle-desc">Adjust text size throughout the app</span>
                    </div>
                    <span className="settings-toggle-badge">Coming Soon</span>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "cost" && (
              <SettingsCostTab />
            )}

            {activeTab === "api" && (
              <SettingsApiKeyTab toast={toast} />
            )}

            {activeTab === "about" && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">About Orplex Code</h2>
                  <p className="settings-section-desc">Information about your installation.</p>
                </div>
                <div className="settings-card">
                  <div className="settings-about-grid">
                    <div className="settings-about-item">
                      <span className="settings-about-label">Version</span>
                      <span className="settings-about-value"><AppVersion /></span>
                    </div>
                    <div className="settings-about-item">
                      <span className="settings-about-label">Build</span>
                      <span className="settings-about-value">Production</span>
                    </div>
                    <div className="settings-about-item">
                      <span className="settings-about-label">Framework</span>
                      <span className="settings-about-value">Next.js + TypeScript</span>
                    </div>
                    <div className="settings-about-item">
                      <span className="settings-about-label">AI Backend</span>
                      <span className="settings-about-value">Multi-provider (OpenRouter, NVIDIA, Claude, Gemini)</span>
                    </div>
                  </div>
                  <UpdateCheckRow />
                </div>
              </div>
            )}

            {activeTab === "danger" && <ResetRecoveryTab toast={toast} />}
          </div>
        </div>
      </div>
  );
}
