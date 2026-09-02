"use client";

import { useState } from "react";
import { IconModule, IconAgent, IconArrowRight, IconTrash } from "@/components/Icons";

interface Package {
  name: string;
  version: string;
  update?: string;
  category: string;
  desc: string;
  active?: boolean;
}

const PACKAGES: Package[] = [
  { name: "@orplex/auth-engine", version: "v2.4.1", category: "Core", desc: "High-performance authentication routing and token validation middleware.", active: true },
  { name: "@orplex/data-pipeline", version: "v1.8.0", update: "v1.9.2", category: "Core", desc: "Stream processing library for real-time vector embedding extraction." },
  { name: "@orplex/nlp-agent", version: "v3.0.1", category: "Agent", desc: "Natural language processing module with pre-trained intents.", active: true },
];

function PackageIcon({ category }: { category: string }) {
  return category === "Agent" ? <IconAgent size={18} /> : <IconModule size={18} />;
}

export default function PackagesPage() {
  const [filter, setFilter] = useState("All");
  const filtered = filter === "All" ? PACKAGES : PACKAGES.filter((p) => p.category === filter);

  return (
      <div className="page-content">
        <div className="page-container">
          <div className="page-header">
            <div className="page-header-text">
              <h2 className="page-title">Packages Registry</h2>
              <p className="page-subtitle">Manage installed agent modules and code libraries.</p>
            </div>
            <button className="pkg-add-btn">
              <span className="pkg-add-btn-icon">+</span>
              Add Package
            </button>
          </div>

          <div className="pkg-stats-bar">
            <div className="pkg-stats">
              <div className="pkg-stat">
                <span className="pkg-stat-dot pkg-stat-active" />
                <span className="pkg-stat-label">{PACKAGES.filter((p) => p.active).length} Active</span>
              </div>
              <div className="pkg-stat">
                <span className="pkg-stat-dot pkg-stat-inactive" />
                <span className="pkg-stat-label">{PACKAGES.filter((p) => !p.active).length} Available</span>
              </div>
              <div className="pkg-stat">
                <span className="pkg-stat-dot pkg-stat-update" />
                <span className="pkg-stat-label">{PACKAGES.filter((p) => p.update).length} Updates</span>
              </div>
            </div>
            <div className="pkg-filters">
              {["All", "Core", "Agent"].map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={`pkg-filter-btn ${filter === f ? "active" : ""}`}>{f}</button>
              ))}
            </div>
          </div>

          <div className="pkg-grid">
            {filtered.map((pkg) => (
              <div key={pkg.name} className="pkg-card">
                <div className={`pkg-card-accent ${pkg.active ? "active" : ""}`} />
                <div className="pkg-card-content">
                  <div className="pkg-card-header">
                    <div className={`pkg-card-icon-wrap ${pkg.active ? "pkg-card-icon-active" : ""}`}>
                      <PackageIcon category={pkg.category} />
                    </div>
                    <span className={`pkg-card-badge ${pkg.active ? "badge-active" : pkg.update ? "badge-update" : "badge-available"}`}>
                      {pkg.active ? "Active" : pkg.update ? "Update Available" : "Available"}
                    </span>
                  </div>
                  <div className="pkg-card-body">
                    <h3 className="pkg-card-name">{pkg.name}</h3>
                    <div className="pkg-card-version">
                      <span>{pkg.version}</span>
                      {pkg.update && (
                        <>
                          <span className="pkg-card-arrow">&rarr;</span>
                          <span className="pkg-card-update">{pkg.update}</span>
                        </>
                      )}
                    </div>
                    <p className="pkg-card-desc">{pkg.desc}</p>
                  </div>
                  <div className="pkg-card-footer">
                    <button className="pkg-configure-btn">
                      Configure <IconArrowRight size={12} />
                    </button>
                    {!pkg.active && (
                      <button className="pkg-delete-btn">
                        <IconTrash size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )            )}
          </div>
        </div>
      </div>
  );
}
