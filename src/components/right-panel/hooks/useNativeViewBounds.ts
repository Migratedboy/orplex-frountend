"use client";

/**
 * useNativeViewBounds.ts — keeps one native WebContentsView positioned over
 * a DOM viewport placeholder (B23). ResizeObserver + window resize + a
 * 500 ms safety tick (layout shifts without resize events) → rAF-throttled
 * setBounds IPC. Extracted from preview-tab.tsx so BrowserTab and the
 * floating-window work (P5) share one tested sync path.
 */
import { useEffect, useRef } from "react";

type NativeBridge = {
  setBounds: (tabId: number, rect: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
};

export function useNativeViewBounds(
  native: NativeBridge | null,
  viewportRef: React.RefObject<HTMLDivElement | null>,
  getMainId: () => number | undefined,
): void {
  useEffect(() => {
    if (!native) return;
    // Coalesce to one sync per frame. A raw capture-phase window handler
    // fired at display refresh rate — a forced getBoundingClientRect() plus
    // an IPC round-trip per call (~120 setBounds messages per second).
    let raf = 0;
    const sync = () => {
      if (raf) return; // already scheduled this frame
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = viewportRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const mainId = getMainId();
        if (mainId === undefined) return;
        void native.setBounds(mainId, {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      });
    };
    sync();
    const ro = new ResizeObserver(sync);
    if (viewportRef.current) ro.observe(viewportRef.current);
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    const iv = setInterval(sync, 500); // layout shifts without resize events
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
      clearInterval(iv);
      // A frame scheduled but never run must not fire against an unmounted view.
      if (raf) cancelAnimationFrame(raf);
    };
  }, [native, viewportRef, getMainId]);
}
