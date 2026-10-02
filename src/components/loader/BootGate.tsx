"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useReducedMotion } from "@/hooks/useReducedMotion";

// Lazy-load the 3D loader — removes ~2000 modules (three.js + react-three) from main bundle
const GeometricLoader = dynamic(() => import("./GeometricLoader"), {
  ssr: false,
  loading: () => (
    <div className="gloader" role="status" aria-label="Loading Orplex">
      <div className="gloader-vignette" />
      <div className="gloader-ui">
        <img src="/logo.svg" alt="" className="gloader-logo" />
      </div>
    </div>
  ),
});

/**
 * Boot gate: renders the 3D loader overlay on the FIRST full page load.
 * Returning users (localStorage flag) skip it entirely for instant access.
 *
 * Strategy: always render the overlay div (same DOM on server + client =
 * no hydration mismatch). Visibility is managed via CSS classes:
 *   - "boot-gate-active"  → overlay is visible
 *   - "boot-gate-fading"  → overlay is fading out
 *   - (no class)          → overlay is display:none
 */

const VISITED_KEY = "orplex-visited";
const SPLASH_MS = 1200;  // Reduced from 2200ms
const FADE_MS = 400;     // Reduced from 700ms
// Hard ceiling on waiting for the window `load` event. If a chunk request
// hangs (e.g. the dev server restarted mid-load), `load` never fires and the
// splash would sit at FINALIZING forever — so fade out regardless after this.
const LOAD_GRACE_MS = 4000;

export default function BootGate({ children }: { children: React.ReactNode }) {
  const reducedMotion = useReducedMotion();
  const [active, setActive] = useState(false);
  const [fading, setFading] = useState(false);
  const gateRef = useRef<HTMLDivElement>(null);
  const minTimer = useRef<ReturnType<typeof setTimeout>>();
  const fadeTimer = useRef<ReturnType<typeof setTimeout>>();
  const fadingStarted = useRef(false);

  useEffect(() => {
    // Skip entirely for reduced-motion users
    if (reducedMotion) return;

    // Force-show via ?splash param
    const forceSplash = new URLSearchParams(window.location.search).has("splash");

    // Skip splash for returning users — they've seen the branding already
    const hasVisited = (() => {
      try { return localStorage.getItem(VISITED_KEY) === "1"; } catch { return false; }
    })();

    if (!forceSplash && hasVisited) {
      // Returning user — skip splash entirely, show content immediately
      return;
    }

    // First visit or forced splash
    try { localStorage.setItem(VISITED_KEY, "1"); } catch {}

    setActive(true);
    document.documentElement.classList.add("boot-active");

    // Start minimum splash timer
    minTimer.current = setTimeout(() => {
      if (document.readyState === "complete") {
        startFade();
      } else {
        window.addEventListener("load", startFade, { once: true });
      }
    }, SPLASH_MS);
    // Safety net: never wait on `load` indefinitely (see LOAD_GRACE_MS).
    const loadFallback = setTimeout(startFade, SPLASH_MS + LOAD_GRACE_MS);

    return () => {
      clearTimeout(minTimer.current);
      clearTimeout(fadeTimer.current);
      clearTimeout(loadFallback);
      window.removeEventListener("load", startFade);
    };
  }, [reducedMotion]);

  function startFade() {
    if (fadingStarted.current) return; // load listener + fallback may both fire
    fadingStarted.current = true;
    setFading(true);
    document.documentElement.classList.remove("boot-active");
    document.documentElement.classList.add("boot-fading");
    fadeTimer.current = setTimeout(() => {
      setActive(false);
      setFading(false);
      document.documentElement.classList.remove("boot-fading");
    }, FADE_MS);
  }

  const handleSkip = useCallback(() => {
    clearTimeout(minTimer.current);
    clearTimeout(fadeTimer.current);
    startFade();
  }, []);

  // Esc key dismisses
  useEffect(() => {
    if (!active || reducedMotion) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, reducedMotion, handleSkip]);

  return (
    <>
      <div
        ref={gateRef}
        className={[
          "boot-gate",
          active && !fading ? "boot-gate-active" : "",
          fading ? "boot-gate-fading" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-hidden={!active}
        style={{ display: active || fading ? undefined : "none" }}
      >
        {(active || fading) && <GeometricLoader />}
        {active && !fading && !reducedMotion && (
          <>
            <span className="gloader-hint" aria-hidden="true">
              Tip: press Skip or Esc
            </span>
            <button
              type="button"
              className="gloader-skip"
              onClick={handleSkip}
              aria-label="Skip loading animation"
            >
              Skip
            </button>
          </>
        )}
      </div>
      <div className={active || fading ? "boot-content-hidden" : ""}>
        {children}
      </div>
    </>
  );
}
