"use client";

import dynamic from "next/dynamic";

const AgentManager = dynamic(() => import("@/components/AgentManager"), {
  ssr: false,
  loading: () => (
    <div className="page-content">
      <div className="page-container">
        <div className="skeleton-list">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 160 }} />
          ))}
        </div>
      </div>
    </div>
  ),
});

export default function ManagerPage() {
  return (
    <div className="page-content">
      <div className="page-container">
        <AgentManager />
      </div>
    </div>
  );
}
