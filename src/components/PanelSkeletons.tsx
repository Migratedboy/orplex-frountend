"use client";

import { useEffect, useState } from "react";

/** Post-hydration random width (percent) for skeleton shimmer bars. */
function useRandomWidth(min: number, span: number): string | null {
  const [width, setWidth] = useState<string | null>(null);
  useEffect(() => {
    setWidth(`${Math.round(min + Math.random() * span)}%`);
  }, [min, span]);
  return width;
}

/** Skeleton for the Files panel */
export function FilesPanelSkeleton() {
  return (
    <div className="rp-files-skeleton" style={{ padding: 16 }}>
      {/* Search bar skeleton */}
      <div className="skeleton" style={{ height: 32, borderRadius: 6, marginBottom: 12 }} />
      {/* File tree skeleton */}
      {Array.from({ length: 8 }).map((_, i) => (
        <SkeletonRow key={i} indent={i % 3 === 0 ? 0 : i % 3 === 1 ? 16 : 32} icon={i % 3 === 0} min={40} span={40} delay={i * 50} />
      ))}
    </div>
  );
}

function SkeletonRow({ indent, icon, min, span, delay }: { indent: number; icon: boolean; min: number; span: number; delay: number }) {
  const width = useRandomWidth(min, span);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", paddingLeft: indent }}>
      <div className="skeleton" style={{ width: icon ? 16 : 12, height: icon ? 16 : 12, borderRadius: icon ? 3 : 2, flexShrink: 0 }} />
      <div className="skeleton" style={{ width: width ?? "40%", height: 12, borderRadius: 4, animationDelay: `${delay}ms` }} />
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
        <TerminalRow key={i} delay={i * 80} />
      ))}
    </div>
  );
}

function TerminalRow({ delay }: { delay: number }) {
  const width = useRandomWidth(30, 60);
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
      <div className="skeleton" style={{ width: 20, height: 12, borderRadius: 2, flexShrink: 0, animationDelay: `${delay}ms` }} />
      <div className="skeleton" style={{ width: width ?? "30%", height: 12, borderRadius: 2, animationDelay: `${delay + 40}ms` }} />
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
        <ChangesRow key={i} delay={i * 100} />
      ))}
    </div>
  );
}

function ChangesRow({ delay }: { delay: number }) {
  const width = useRandomWidth(50, 30);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div className="skeleton" style={{ width: 16, height: 16, borderRadius: 3, flexShrink: 0 }} />
        <div className="skeleton" style={{ width: width ?? "50%", height: 12, borderRadius: 4 }} />
        <div className="skeleton" style={{ width: 40, height: 12, borderRadius: 4, marginLeft: "auto" }} />
      </div>
      <div className="skeleton" style={{ height: 60, borderRadius: 4, animationDelay: `${delay}ms` }} />
    </div>
  );
}
