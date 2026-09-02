import BrandSpinner from "@/components/loader/BrandSpinner";

export default function SettingsLoading() {
  return (
    <div className="page-content">
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <div className="settings-sidebar-header">
            <span className="settings-sidebar-title">Settings</span>
          </div>
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="skeleton" style={{ height: "32px", width: "100%", marginBottom: "4px" }} />
          ))}
        </aside>
        <div className="settings-main">
          <div className="route-loading">
            <BrandSpinner size={32} />
            <span>Loading settings…</span>
          </div>
          <div className="settings-card">
            <div className="skeleton" style={{ height: "200px", width: "100%" }} />
          </div>
        </div>
      </div>
    </div>
  );
}
