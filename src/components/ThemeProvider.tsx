"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { syncThemeCookie } from "@/lib/theme-bootstrap";

export type ThemePref = "light" | "dark" | "system";

interface ThemeContextType {
  /** Effective resolved theme (what is on screen right now). */
  dark: boolean;
  /** Legacy one-shot flip (kept for every existing caller). */
  toggle: () => void;
  /** Stored preference — 'system' follows the OS live. */
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  dark: true,
  toggle: () => {},
  pref: "dark",
  setPref: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

/**
 * Theme is DARK by default (layout.tsx ships <html class="dark">). The stored
 * preference ('orplex-theme') is now 'light' | 'dark' | 'system'; anything
 * unreadable stays dark. ThemeInit applies pre-paint; this provider mirrors
 * the same resolution and keeps `data-theme` + `.dark` in sync on change.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(true);
  const [pref, setPrefState] = useState<ThemePref>("dark");

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    let saved: string | null = null;
    try { saved = localStorage.getItem("orplex-theme"); } catch {}
    const initial: ThemePref =
      saved === "light" || saved === "system" ? (saved as ThemePref) : "dark";
    const apply = (p: ThemePref) => {
      const isDark = p === "dark" || (p === "system" && mq.matches);
      setPrefState(p);
      setDark(isDark);
      document.documentElement.classList.toggle("dark", isDark);
      document.documentElement.dataset.theme = isDark ? "dark" : "light";
      syncThemeCookie(isDark ? "dark" : "light");
    };
    apply(initial);
    // In 'system' mode follow the OS live.
    const onChange = () => {
      try { if ((localStorage.getItem("orplex-theme") || "dark") === "system") apply("system"); } catch {}
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setPref = (p: ThemePref) => {
    try { localStorage.setItem("orplex-theme", p); } catch {}
    const isDark = p === "dark" || (p === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    setPrefState(p);
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    syncThemeCookie(isDark ? "dark" : "light");
  };

  const toggle = () => setPref(dark ? "light" : "dark");

  return (
    <ThemeContext.Provider value={{ dark, toggle, pref, setPref }}>
      {children}
    </ThemeContext.Provider>
  );
}
