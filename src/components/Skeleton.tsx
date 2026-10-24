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

/**
 * Boot skeleton for the chat page. The page is assembled entirely from
 * ssr:false dynamic imports, so a cold start used to paint an empty black
 * main pane until every chunk resolved. This fills the same geometry as
 * DragDropZone (messages area + bottom composer) while they load.
 */
export function ChatAreaSkeleton() {
  return (
    <div className="chat-skel" aria-hidden="true">
      <div className="messages-scroll">
        <MessageSkeleton count={4} />
      </div>
      <div className="chat-input-bar">
        <div className="composer-skel">
          <div className="skeleton composer-skel-btn" />
          <div className="skeleton composer-skel-field" />
          <div className="skeleton composer-skel-btn" />
        </div>
        <div className="skeleton composer-skel-hint" />
      </div>
    </div>
  );
}

/** Boot skeleton for the first-run welcome screen (no conversation open). */
export function WelcomeSkeleton() {
  return (
    <div className="chat-skel welcome-skel" aria-hidden="true">
      <div className="skeleton welcome-skel-mark" />
      <div className="skeleton welcome-skel-title" />
      <div className="skeleton welcome-skel-pill" />
    </div>
  );
}
