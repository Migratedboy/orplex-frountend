import BrandSpinner from "@/components/loader/BrandSpinner";

export default function RootLoading() {
  return (
    <div className="page-content">
      <div className="page-container">
        <div className="route-loading">
          <BrandSpinner size={32} />
          <span>Loading…</span>
        </div>
      </div>
    </div>
  );
}
