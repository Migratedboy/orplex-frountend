"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";

interface ThemeContextType {
  dark: boolean;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextType>({ dark: true, toggle: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}

/**
 * Theme is DARK by default (set server-side on <html> in layout.tsx). The only
 * stored preference is an explicit LIGHT choice ("orplex-theme": "light") —
 * when the user switches to light we persist it and honor it on every load;
 * anything else (no preference, "dark", unreadable storage) stays dark.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("orplex-theme");
    } catch {
      // localStorage unavailable — keep dark default
    }
    if (saved === "light") {
      setDark(false);
      document.documentElement.classList.remove("dark");
    } else {
      // no explicit light preference → dark (covers first run and "dark")
      setDark(true);
      document.documentElement.classList.add("dark");
    }
  }, []);

  const toggle = () => {
    setDark((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("orplex-theme", next ? "dark" : "light");
      } catch {
        // persistence is best-effort
      }
      document.documentElement.classList.toggle("dark", next);
      return next;
    });
  };

  return (
    <ThemeContext.Provider value={{ dark, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}
