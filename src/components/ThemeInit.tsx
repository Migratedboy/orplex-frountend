"use client";

import { useEffect } from "react";
import { syncThemeCookie } from "@/lib/theme-bootstrap";

/**
 * Early theme bootstrap — runs before the app paints its UI.
 * Pref model (shell spec §4 / D1): `orplex-theme` is 'light' | 'dark' |
 * 'system'; NO stored value = dark (today's default, and an existing stored
 * 'light' keeps working). Applies BOTH the new `data-theme` attribute and the
 * legacy `.dark` class so old components keep working.
 */
export default function ThemeInit() {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      let pref = "dark";
      try { pref = localStorage.getItem("orplex-theme") || "dark"; } catch {}
      const dark = pref === "dark" || (pref === "system" && mq.matches);
      const root = document.documentElement;
      root.dataset.theme = dark ? "dark" : "light";
      root.dataset.themeReady = "1";
      root.classList.toggle("dark", dark);
      // Keep the cookie the server reads in step with what is on screen; it is
      // what makes the next launch's FIRST frame correct.
      syncThemeCookie(dark ? "dark" : "light");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return null; // Renders nothing
}
