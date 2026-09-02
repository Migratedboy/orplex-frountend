import BrandSpinner from "@/components/loader/BrandSpinner";

export default function PluginsLoading() {
  return (
    <div className="page-content">
      <div className="page-container">
        <div className="route-loading">
          <BrandSpinner size={32} />
          <span>Loading plugins...</span>
        </div>
        <div className="page-header">
          <div className="skeleton" style={{ height: "28px", width: "200px" }} />
        </div>
        <div className="skeleton" style={{ height: "64px", width: "100%", marginBottom: "24px" }} />
        <div className="pkg-grid">
          {[1, 2, 3].map(i => (
            <div key={i} className="settings-card" style={{ padding: "24px" }}>
              <div className="skeleton" style={{ height: "120px", width: "100%" }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
