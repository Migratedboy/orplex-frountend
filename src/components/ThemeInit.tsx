"use client";

import { useEffect } from "react";

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
      root.classList.toggle("dark", dark);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return null; // Renders nothing
}
