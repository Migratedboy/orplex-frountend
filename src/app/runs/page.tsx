"use client";

import dynamic from "next/dynamic";

// RunBoard polls client-side, so disable SSR
const RunBoard = dynamic(() => import("@/components/RunBoard"), {
  ssr: false,
  loading: () => (
    <div className="page-content">
      <div className="page-container">
        <div className="skeleton-list">
          {[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 96 }} />)}
        </div>
      </div>
    </div>
  ),
});

export default function RunsPage() {
  return <RunBoard />;
}
