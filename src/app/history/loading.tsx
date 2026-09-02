import BrandSpinner from "@/components/loader/BrandSpinner";

export default function HistoryLoading() {
  return (
    <div className="page-content">
      <div className="page-container">
        <div className="route-loading">
          <BrandSpinner size={32} />
          <span>Loading history…</span>
        </div>
        <div className="skeleton-list">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 72 }} />
          ))}
        </div>
      </div>
    </div>
  );
}