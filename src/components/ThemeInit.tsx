"use client";

import { useEffect } from "react";

/**
 * Initializes the dark theme from localStorage on mount.
 * Replaces the inline <script> tag that was causing React warnings.
 * Must be rendered as a child of <html> to set the class before paint.
 */
export default function ThemeInit() {
  useEffect(() => {
    try {
      if (localStorage.getItem("orplex-theme") === "dark") {
        document.documentElement.classList.add("dark");
      }
    } catch {
      // localStorage unavailable
    }
  }, []);

  return null; // Renders nothing
}
