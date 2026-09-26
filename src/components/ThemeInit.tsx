"use client";

import { useEffect } from "react";

/**
 * Early theme bootstrap — runs before the app paints its UI.
 * DARK is the default (layout.tsx ships <html class="dark">); the only stored
 * preference is an explicit LIGHT choice in localStorage ("orplex-theme").
 * Replaces the inline <script> tag that was causing React warnings.
 */
export default function ThemeInit() {
  useEffect(() => {
    try {
      if (localStorage.getItem("orplex-theme") === "light") {
        document.documentElement.classList.remove("dark");
      } else {
        document.documentElement.classList.add("dark");
      }
    } catch {
      // localStorage unavailable — stay dark
    }
  }, []);

  return null; // Renders nothing
}
