"use client";

/** Skeleton for the Files panel */
export function FilesPanelSkeleton() {
  return (
    <div className="rp-files-skeleton" style={{ padding: 16 }}>
      {/* Search bar skeleton */}
      <div className="skeleton" style={{ height: 32, borderRadius: 6, marginBottom: 12 }} />
      {/* File tree skeleton */}
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", paddingLeft: i % 3 === 0 ? 0 : i % 3 === 1 ? 16 : 32 }}>
          <div className="skeleton" style={{ width: i % 3 === 0 ? 16 : 12, height: i % 3 === 0 ? 16 : 12, borderRadius: i % 3 === 0 ? 3 : 2, flexShrink: 0 }} />
          <div className="skeleton" style={{ width: `${40 + Math.random() * 40}%`, height: 12, borderRadius: 4, animationDelay: `${i * 50}ms` }} />
        </div>
      ))}
    </div>
  );
}

/** Skeleton for the Queue panel */
export function QueuePanelSkeleton() {
  return (
    <div className="rp-queue-skeleton" style={{ padding: 16 }}>
      <div className="skeleton" style={{ height: 14, width: 80, borderRadius: 4, marginBottom: 16 }} />
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid #f3f3f4" }}>
          <div className="skeleton" style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 12, width: "80%", borderRadius: 4, marginBottom: 4 }} />
            <div className="skeleton" style={{ height: 10, width: "50%", borderRadius: 4, animationDelay: `${i * 100}ms` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Skeleton for the Terminal panel */
export function TerminalPanelSkeleton() {
  return (
    <div className="rp-terminal-skeleton" style={{ padding: 16, fontFamily: "'JetBrains Mono', monospace" }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <div className="skeleton" style={{ width: 20, height: 12, borderRadius: 2, flexShrink: 0, animationDelay: `${i * 80}ms` }} />
          <div className="skeleton" style={{ width: `${30 + Math.random() * 60}%`, height: 12, borderRadius: 2, animationDelay: `${i * 80 + 40}ms` }} />
        </div>
      ))}
    </div>
  );
}

/** Skeleton for the Preview panel */
export function PreviewPanelSkeleton() {
  return (
    <div className="rp-preview-skeleton" style={{ padding: 16 }}>
      {/* Browser chrome skeleton */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#f3f3f4", borderRadius: "8px 8px 0 0", border: "1px solid #E4E4E7" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <div className="skeleton" style={{ width: 10, height: 10, borderRadius: "50%" }} />
          <div className="skeleton" style={{ width: 10, height: 10, borderRadius: "50%" }} />
          <div className="skeleton" style={{ width: 10, height: 10, borderRadius: "50%" }} />
        </div>
        <div className="skeleton" style={{ flex: 1, height: 20, borderRadius: 4 }} />
      </div>
      {/* Page content skeleton */}
      <div className="skeleton" style={{ height: 300, borderRadius: "0 0 8px 8px", border: "1px solid #E4E4E7", borderTop: "none" }} />
    </div>
  );
}

/** Skeleton for Changes/Diff panel */
export function ChangesPanelSkeleton() {
  return (
    <div className="rp-changes-skeleton" style={{ padding: 16 }}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div className="skeleton" style={{ width: 16, height: 16, borderRadius: 3, flexShrink: 0 }} />
            <div className="skeleton" style={{ width: `${50 + Math.random() * 30}%`, height: 12, borderRadius: 4 }} />
            <div className="skeleton" style={{ width: 40, height: 12, borderRadius: 4, marginLeft: "auto" }} />
          </div>
          <div className="skeleton" style={{ height: 60, borderRadius: 4, animationDelay: `${i * 100}ms` }} />
        </div>
      ))}
    </div>
  );
}
