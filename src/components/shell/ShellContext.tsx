"use client";

/**
 * ShellContext.tsx — shell-level state shared by Strip/Rail/AppShell:
 * sidebar collapse (orplex.sidebarCollapsed, Ctrl+\, orplex:toggle-sidebar),
 * the Code/Chat surface mode (orplex.surfaceMode + orplex:surface-mode), and
 * the mobile drawer. Rail Layout button and the sidebar collapse button share
 * the SAME state (spec §2.3).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type SurfaceMode = "code" | "chat";

interface ShellContextValue {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  surfaceMode: SurfaceMode;
  setSurfaceMode: (m: SurfaceMode) => void;
  mobileSideOpen: boolean;
  setMobileSideOpen: (v: boolean) => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside ShellProvider");
  return ctx;
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [surfaceMode, setSurfaceModeState] = useState<SurfaceMode>("code");
  const [mobileSideOpen, setMobileSideOpen] = useState(false);

  useEffect(() => {
    try {
      setSidebarCollapsed(localStorage.getItem("orplex.sidebarCollapsed") === "1");
      const m = localStorage.getItem("orplex.surfaceMode");
      if (m === "chat" || m === "code") setSurfaceModeState(m);
    } catch {}
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem("orplex.sidebarCollapsed", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  const setSurfaceMode = useCallback((m: SurfaceMode) => {
    setSurfaceModeState(m);
    try { localStorage.setItem("orplex.surfaceMode", m); } catch {}
    window.dispatchEvent(new CustomEvent("orplex:surface-mode", { detail: { mode: m } }));
  }, []);

  // Rail buttons + the sidebar's own collapse button dispatch this event.
  useEffect(() => {
    const handler = () => toggleSidebar();
    window.addEventListener("orplex:toggle-sidebar", handler);
    return () => window.removeEventListener("orplex:toggle-sidebar", handler);
  }, [toggleSidebar]);

  const value = useMemo(
    () => ({ sidebarCollapsed, toggleSidebar, surfaceMode, setSurfaceMode, mobileSideOpen, setMobileSideOpen }),
    [sidebarCollapsed, toggleSidebar, surfaceMode, setSurfaceMode, mobileSideOpen]
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
