"use client";

/** Animated skeleton placeholder for message loading states */
export function MessageSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="messages-container">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="msg-skeleton" style={{ animationDelay: `${i * 150}ms` }}>
          <div className="msg-skeleton-avatar skeleton" />
          <div className="msg-skeleton-body">
            <div className="msg-skeleton-line skeleton" />
            <div className="msg-skeleton-line skeleton" />
            <div className="msg-skeleton-line skeleton" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Generic skeleton line for inline use */
export function SkeletonLine({ width = "100%", height = 14 }: { width?: string | number; height?: number }) {
  return (
    <div
      className="skeleton"
      style={{ width, height, borderRadius: 4 }}
    />
  );
}

/** Skeleton for panel content (files, queue, etc.) */
export function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-list" style={{ padding: 16 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div className="skeleton" style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0 }} />
          <div className="skeleton" style={{ flex: 1, height: 12, borderRadius: 4, animationDelay: `${i * 100}ms` }} />
        </div>
      ))}
    </div>
  );
}
