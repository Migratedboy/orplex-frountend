"use client";
import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useToast } from "@/components/Toast";
import { IconCheck } from "@/components/Icons";

interface UserKey {
  id: string;
  provider: string;
  model: string;
  apiKeyMasked: string;
  isActive: boolean;
  usageToday: number;
  createdAt: string;
}

function SettingsApiKeyTab({ toast }: { toast: (msg: string, type?: "info" | "error" | "success") => void }) {
  const [keys, setKeys] = useState<UserKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState({ provider: "nvidia", apiKey: "", model: "minimax/minimax-m3:free" });
  const [addStatus, setAddStatus] = useState("");
  const [adding, setAdding] = useState(false);

  const fetchKeys = async () => {
    try {
      const res = await fetch("/api/settings/keys");
      if (res.ok) { const data = await res.json(); setKeys(data.keys); }
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { fetchKeys(); }, []);

  const addKey = async () => {
    setAdding(true);
    setAddStatus("Testing key...");
    try {
      const res = await fetch("/api/settings/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newKey),
      });
      const data = await res.json();
      if (res.ok) {
        setAddStatus(data.key.message);
        toast("API key added", "success");
        setShowAdd(false);
        setNewKey({ provider: "nvidia", apiKey: "", model: "minimax/minimax-m3:free" });
        fetchKeys();
      } else {
        setAddStatus(data.error || "Failed");
      }
    } catch { setAddStatus("Network error"); }
    setAdding(false);
  };

  const deleteKey = async (id: string) => {
    if (!confirm("Remove this API key?")) return;
    await fetch(`/api/settings/keys?id=${id}`, { method: "DELETE" });
    toast("Key removed", "success");
    fetchKeys();
  };

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h2 className="settings-section-title">API Keys</h2>
        <p className="settings-section-desc">Add your own API keys for unlimited requests. Without personal keys, you use the platform shared quota (50 requests/day).</p>
      </div>
      <div className="settings-card">
        {loading ? (
          <p className="settings-hint">Loading keys...</p>
        ) : (
          <>
            {keys.length > 0 && (
              <div className="settings-api-grid">
                {keys.map(key => (
                  <div key={key.id} className="settings-api-item">
                    <div className="settings-api-header">
                      <span className="settings-api-name">{key.provider === "nvidia" ? "NVIDIA NIM" : "OpenRouter"}</span>
                      <span className="settings-api-status settings-api-status-active">Active</span>
                    </div>
                    <p className="settings-api-desc">Model: {key.model}</p>
                    <div className="settings-api-key-display">
                      <span className="settings-api-key-masked">{key.apiKeyMasked}</span>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <button onClick={() => deleteKey(key.id)} className="settings-save-btn" style={{ background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca" }}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!showAdd ? (
              <button onClick={() => setShowAdd(true)} className="settings-save-btn" style={{ marginTop: 12 }}>
                + Add API Key
              </button>
            ) : (
              <div style={{ marginTop: 12, padding: 16, background: "#f9f9fa", borderRadius: 8, border: "1px solid #e4e4e7" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr", gap: 8, marginBottom: 8 }}>
                  <select value={newKey.provider} onChange={e => {
                    const p = e.target.value;
                    setNewKey({ ...newKey, provider: p, model: p === "nvidia" ? "minimax/minimax-m3:free" : "meta-llama/llama-3.1-8b-instruct" });
                  }} style={{ padding: 8, fontSize: 12, borderRadius: 4, border: "1px solid #e4e4e7" }}>
                    <option value="nvidia">NVIDIA NIM (Free)</option>
                    <option value="openrouter">OpenRouter (Pay-per-use)</option>
                  </select>
                  <input type="password" placeholder="Paste your API key here" value={newKey.apiKey} onChange={e => setNewKey({ ...newKey, apiKey: e.target.value })} style={{ padding: 8, fontSize: 12, borderRadius: 4, border: "1px solid #e4e4e7" }} />
                  <input placeholder="Model" value={newKey.model} onChange={e => setNewKey({ ...newKey, model: e.target.value })} style={{ padding: 8, fontSize: 12, borderRadius: 4, border: "1px solid #e4e4e7" }} />
                </div>
                {addStatus && <p style={{ fontSize: 11, color: addStatus.includes("success") || addStatus.includes("added") ? "green" : "#ef4444", marginBottom: 8 }}>{addStatus}</p>}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={addKey} disabled={adding || !newKey.apiKey} className="settings-save-btn">
                    {adding ? "Testing..." : "Add Key"}
                  </button>
                  <button onClick={() => { setShowAdd(false); setAddStatus(""); }} className="settings-save-btn" style={{ background: "#f3f4f6", color: "#374151" }}>
                    Cancel
                  </button>
                </div>
                <p className="settings-hint" style={{ marginTop: 8 }}>
                  {newKey.provider === "nvidia"
                    ? "Get a free key at build.nvidia.com — unlimited requests, no credit card needed."
                    : "Get a key at openrouter.ai — pay-per-use, starts at ~$0.1/M tokens."
                  }
                </p>
              </div>
            )}

            <div className="settings-api-note" style={{ marginTop: 16 }}>
              <p><strong>Without a personal key:</strong> You use the platform shared quota (50 requests/day).</p>
              <p style={{ marginTop: 4 }}><strong>With your own key:</strong> Unlimited requests, using your own API credits.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("profile");
  const { data: session, update } = useSession();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (session?.user?.name) setName(session.user.name); }, [session?.user?.name]);

  const saveProfile = async () => {
    setSaving(true);
    try {
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
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
    { id: "api", label: "API Keys" },
    { id: "about", label: "About" },
  ];

  return (
      <div className="page-content">
        <div className="settings-layout">
          <aside className="settings-sidebar">
            <div className="settings-sidebar-header">
              <span className="settings-sidebar-title">Settings</span>
            </div>
            {tabs.map((tab) => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
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
                  <p className="settings-section-desc">Customize the look and feel of Orplex Tech.</p>
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

            {activeTab === "api" && (
              <SettingsApiKeyTab toast={toast} />
            )}

            {activeTab === "about" && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">About Orplex Tech</h2>
                  <p className="settings-section-desc">Information about your installation.</p>
                </div>
                <div className="settings-card">
                  <div className="settings-about-grid">
                    <div className="settings-about-item">
                      <span className="settings-about-label">Version</span>
                      <span className="settings-about-value">1.0.0</span>
                    </div>
                    <div className="settings-about-item">
                      <span className="settings-about-label">Build</span>
                      <span className="settings-about-value">Production</span>
                    </div>
                    <div className="settings-about-item">
                      <span className="settings-about-label">Framework</span>
                      <span className="settings-about-value">Next.js 14 + TypeScript</span>
                    </div>
                    <div className="settings-about-item">
                      <span className="settings-about-label">AI Backend</span>
                      <span className="settings-about-value">OpenRouter / NVIDIA</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
  );
}
