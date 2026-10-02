"use client";

import { useBootProgress } from "@/hooks/useBootProgress";

const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Lightweight premium CSS & SVG geometric loader shown while the app boots.
 * Pure 2D animation ensures instant page loads and zero WebGL CPU overhead.
 */
export default function GeometricLoader() {
  const { progress, phase } = useBootProgress(1200); // Quick boot phase progress

  // Leading-edge glow dot: travels along the ring as progress fills.
  const angle = (progress / 100) * Math.PI * 2;
  const dotX = 60 + RING_R * Math.sin(angle);
  const dotY = 60 - RING_R * Math.cos(angle);

  return (
    <div className="gloader" role="status" aria-label="Loading Orplex">
      <div className="gloader-fallback-rings" aria-hidden="true">
        <span className="gloader-fallback-ring gloader-fallback-ring-a" />
        <span className="gloader-fallback-ring gloader-fallback-ring-b" />
        <span className="gloader-fallback-core" />
      </div>

      <div className="gloader-vignette" aria-hidden="true" />

      <div className="gloader-ui">
        <img src="/logo.svg" alt="" className="gloader-logo" />

        <div className="gloader-ring-wrap">
          <svg className="gloader-ring" viewBox="0 0 120 120" aria-hidden="true">
            <defs>
              <linearGradient id="gloader-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#ffb36b" />
                <stop offset="100%" stopColor="#ff5e00" />
              </linearGradient>
            </defs>
            <circle className="gloader-ring-track" cx="60" cy="60" r={RING_R} />
            <circle
              className="gloader-ring-glow"
              cx="60"
              cy="60"
              r={RING_R}
              stroke="url(#gloader-grad)"
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - progress / 100)}
            />
            <circle
              className="gloader-ring-fill"
              cx="60"
              cy="60"
              r={RING_R}
              stroke="url(#gloader-grad)"
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - progress / 100)}
            />
            <circle className="gloader-ring-dot" cx={dotX} cy={dotY} r="3.6" fill="url(#gloader-grad)" />
          </svg>
          <span className="gloader-pct">{progress}%</span>
        </div>

        <p className="gloader-phase">
          <span className="gloader-phase-text">{phase}…</span>
        </p>
        <p className="gloader-brand">Orplex Code</p>
      </div>
    </div>
  );
}