"use client";

import { useEffect, useState } from "react";

const PHASES = ["Initializing", "Loading modules", "Warming models", "Finalizing"] as const;

/**
 * Simulated boot progress (0-100) with an ease-in-out-sine curve and
 * rotating phase labels. Drives the loader's progress ring.
 */
export function useBootProgress(durationMs = 2600): { progress: number; phase: string } {
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<string>(PHASES[0]);

  useEffect(() => {
    let raf = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = -(Math.cos(Math.PI * t) - 1) / 2;
      setProgress(Math.round(eased * 100));
      setPhase(PHASES[Math.min(PHASES.length - 1, Math.floor(t * PHASES.length))]);
      if (t < 1) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [durationMs]);

  return { progress, phase };
}