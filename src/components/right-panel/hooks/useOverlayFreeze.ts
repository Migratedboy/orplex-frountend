"use client";

/**
 * useOverlayFreeze.ts — the native view sits ABOVE DOM overlays, so menus,
 * dialogs and popovers render underneath it. While any overlay intersecting
 * the view bounds is open, hide the native view (`showTab(null)`) and paint a
 * `capturePage()` snapshot in its place so nothing flashes (spec §2.2).
 *
 * Pure seam: `decideFreeze` is unit-tested; the hook owns the snapshot async.
 */
import { useEffect, useState } from "react";

type ShotFn = (tabId: number) => Promise<string | null>;

/** Whether to freeze: an overlay is open AND a snapshot exists to swap in. */
export function freezeVisible(overlayOpen: boolean, snapshot: string | null): boolean {
  return overlayOpen && snapshot !== null;
}

/**
 * While `overlayOpen` is true the hook captures a snapshot via `screenshot`
 * and exposes `snapshot` (dataURL | null). `frozen` = show the snapshot
 * instead of letting the native view through. The capture is best-effort:
 * a failed screenshot keeps the view hidden (never the DOM overlay flash).
 */
export function useOverlayFreeze(
  overlayOpen: boolean,
  activeMainId: number | undefined,
  screenshot: ShotFn,
): { snapshot: string | null; frozen: boolean } {
  const [snapshot, setSnapshot] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (overlayOpen) {
      if (activeMainId === undefined) return;
      void screenshot(activeMainId).then((data) => {
        if (!cancelled) setSnapshot(data);
      });
    } else {
      setSnapshot(null);
    }
    return () => { cancelled = true; };
  }, [overlayOpen, activeMainId, screenshot]);

  return { snapshot, frozen: freezeVisible(overlayOpen, snapshot) };
}
