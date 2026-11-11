"use client";

/**
 * RightPanelContext.tsx — lifted right-panel state (spec §3): the tab BAR
 * moved into the strip, so the open/active tab state lives here and is
 * consumed by both the strip (tabs) and the panel body (RightPanelShell).
 *
 * All six tab bodies stay mounted with display:none when inactive, so
 * Terminal and Browser keep their state. Persistence keys are preserved
 * (orplex.rightPanel / .rightPanelTab / .rightPanelTabs) and are now keyed
 * per project via `orplex.rightPanelTabs.<projectId>` (legacy global key is
 * the fallback/migration source). Width is NOT persisted (unchanged behavior).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  OPEN_KEY,
  OPEN_TABS_KEY,
  LEGACY_TAB_KEY,
  parseOpenTabs,
  legacyTabToOpenTabs,
  defaultTabToOpenTabs,
  toLegacyTabId,
  addTab as addTabPure,
  closeTab as closeTabPure,
  type TabId,
} from "@/lib/panel-state";
import { useActiveRunCount } from "@/hooks/useActiveRunCount";

export interface RightPanelContextValue {
  isOpen: boolean;
  /** null = no project grouping (ungrouped chats). */
  projectId: string | null;
  tabs: TabId[];
  activeTab: TabId | null;
  open: (tab?: TabId) => void;
  close: (tab: TabId) => void;
  activate: (tab: TabId) => void;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  width: number;
  setWidth: (w: number) => void;
  resizing: boolean;
  setResizing: (v: boolean) => void;
  /** Popovers/menus over the browser view freeze its native snapshot. */
  overlayOpen: boolean;
  setOverlayOpen: (v: boolean) => void;
  /** True only when the panel AND its active tab should really show (not
   *  while Settings/Integrations cover the shell). */
  browserVisible: boolean;
  /** The native browser views stay mounted (hidden) until 10 min idle. */
  browserMounted: boolean;
  browserLive: boolean;
  queueCount: number;
}

const RightPanelContext = createContext<RightPanelContextValue | null>(null);

export function useRightPanel(): RightPanelContextValue {
  const ctx = useContext(RightPanelContext);
  if (!ctx) throw new Error("useRightPanel must be used inside RightPanelProvider");
  return ctx;
}

/** Optional consumer (overlays that render outside the provider). */
export function useRightPanelOptional(): RightPanelContextValue | null {
  return useContext(RightPanelContext);
}

export function projectTabsKey(projectId: string | null): string {
  return projectId ? `${OPEN_TABS_KEY}.${projectId}` : OPEN_TABS_KEY;
}

interface Props {
  children: ReactNode;
  /** Active project (workspace NAME) or null for ungrouped. */
  projectId: string | null;
  /** True while a full-page view (Settings/Integrations) covers the shell. */
  fullPage: boolean;
}

export function RightPanelProvider({ children, projectId, fullPage }: Props) {
  const [isOpen, setOpenState] = useState(false);
  const [tabsByProject, setTabsByProject] = useState<Record<string, TabId[]>>({});
  const [activeByProject, setActiveByProject] = useState<Record<string, TabId | null>>({});
  const [browserMounted, setBrowserMounted] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [restored, setRestored] = useState(false);
  const [width, setWidth] = useState(420);
  const [resizing, setResizing] = useState(false);

  const tabs = useMemo(() => tabsByProject[projectId ?? ""] ?? [], [tabsByProject, projectId]);
  const activeTab = useMemo(
    () => activeByProject[projectId ?? ""] ?? null,
    [activeByProject, projectId]
  );

  // === Restore persisted state (post-hydration, never in useState) ===
  useEffect(() => {
    let initial: TabId[] = [];
    let initialActive: TabId | null = null;
    try {
      const savedOpen = sessionStorage.getItem(OPEN_KEY) === "1";
      if (savedOpen) setOpenState(true);
      // Per-project first, then the legacy global key, then the legacy tab.
      let raw = sessionStorage.getItem(projectTabsKey(projectId));
      let fromNew = parseOpenTabs(raw);
      if (fromNew === null) {
        fromNew = parseOpenTabs(sessionStorage.getItem(OPEN_TABS_KEY));
      }
      if (fromNew !== null) {
        initial = fromNew;
        const legacy = legacyTabToOpenTabs(sessionStorage.getItem(LEGACY_TAB_KEY));
        const preferred = legacy[0];
        initialActive =
          (preferred && initial.includes(preferred) ? preferred : initial[initial.length - 1]) ?? null;
      } else {
        initial = legacyTabToOpenTabs(sessionStorage.getItem(LEGACY_TAB_KEY));
        initialActive = initial[initial.length - 1] ?? null;
      }
    } catch {
      // storage blocked — fall through to the empty launcher
    }
    const key = projectId ?? "";
    setTabsByProject((prev) => ({ ...prev, [key]: initial }));
    setActiveByProject((prev) => ({ ...prev, [key]: initialActive }));
    if (initial.includes("browser")) setBrowserMounted(true);
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Project switch: load (or lazily seed) that project's tab list.
  useEffect(() => {
    if (!restored) return;
    const key = projectId ?? "";
    setTabsByProject((prev) => {
      if (prev[key]) return prev;
      let initial: TabId[] = [];
      let initialActive: TabId | null = null;
      try {
        const fromNew = parseOpenTabs(sessionStorage.getItem(projectTabsKey(projectId)));
        if (fromNew !== null) {
          initial = fromNew;
          const legacy = legacyTabToOpenTabs(sessionStorage.getItem(LEGACY_TAB_KEY));
          const preferred = legacy[0];
          initialActive =
            (preferred && initial.includes(preferred) ? preferred : initial[initial.length - 1]) ?? null;
        }
      } catch {}
      setActiveByProject((a) => (a[key] !== undefined ? a : { ...a, [key]: initialActive }));
      return { ...prev, [key]: initial };
    });
  }, [projectId, restored]);

  // Persist open list + legacy keys (AppLayout + reset-recovery-tab compat).
  useEffect(() => {
    if (!restored) return;
    try {
      sessionStorage.setItem(OPEN_KEY, isOpen ? "1" : "0");
      if (tabs.length) sessionStorage.setItem(projectTabsKey(projectId), JSON.stringify(tabs));
      if (activeTab) sessionStorage.setItem(LEGACY_TAB_KEY, toLegacyTabId(activeTab));
    } catch {}
  }, [tabs, activeTab, isOpen, projectId, restored]);

  // Programmatic open (Ctrl+T, Ctrl+1..6, orplex:open-panel) via event.
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent).detail?.tab as string | undefined;
      setOpenState(true);
      if (typeof tab === "string") {
        const toOpen = defaultTabToOpenTabs(tab);
        if (toOpen.length) {
          const id = toOpen[0];
          const key = projectId ?? "";
          setTabsByProject((prev) => {
            const list = prev[key] ?? [];
            return list.includes(id) ? prev : { ...prev, [key]: [...list, id] };
          });
          setActiveByProject((prev) => ({ ...prev, [key]: id }));
          if (id === "browser") setBrowserMounted(true);
        }
      }
    };
    window.addEventListener("orplex:open-panel", handler);
    return () => window.removeEventListener("orplex:open-panel", handler);
  }, [projectId]);

  const activate = useCallback((id: TabId) => {
    const key = projectId ?? "";
    setActiveByProject((prev) => ({ ...prev, [key]: id }));
    if (id === "browser") setBrowserMounted(true);
  }, [projectId]);

  const open = useCallback((tab?: TabId) => {
    setOpenState(true);
    if (!tab) return;
    const key = projectId ?? "";
    setTabsByProject((prev) => {
      const list = prev[key] ?? [];
      return list.includes(tab) ? prev : { ...prev, [key]: [...list, tab] };
    });
    setActiveByProject((prev) => ({ ...prev, [key]: tab }));
    if (tab === "browser") setBrowserMounted(true);
  }, [projectId]);

  const close = useCallback((id: TabId) => {
    const key = projectId ?? "";
    setTabsByProject((prev) => {
      const list = prev[key] ?? [];
      return { ...prev, [key]: list.filter((t) => t !== id) };
    });
    setActiveByProject((prev) => {
      const list = tabsByProject[key] ?? [];
      const idx = list.indexOf(id);
      const next = list.filter((t) => t !== id);
      let nextActive = prev[key] ?? null;
      if (nextActive === id) nextActive = next[Math.max(0, idx - 1)] ?? null;
      return { ...prev, [key]: nextActive };
    });
  }, [projectId, tabsByProject]);

  const toggle = useCallback(() => setOpenState((v) => !v), []);

  // Browser idle-free (D13): tab closed → hidden views freed after 10 min.
  useEffect(() => {
    if (!browserMounted || tabs.includes("browser")) return;
    const t = setTimeout(() => setBrowserMounted(false), 10 * 60 * 1000);
    return () => clearTimeout(t);
  }, [browserMounted, tabs]);

  // Browser-live dot (localhost probe) while the panel is open.
  const [browserLive, setBrowserLive] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    const probe = async () => {
      try {
        const res = await fetch("/api/localhost-probe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const d = (await res.json()) as { live?: number[] };
        if (alive) setBrowserLive((d.live ?? []).length > 0);
      } catch {
        /* offline — the dot just stays off */
      }
    };
    void probe();
    const iv = setInterval(probe, 10_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [isOpen]);

  // Badge polls only while the panel is open (§2.8).
  const { activeRuns } = useActiveRunCount(isOpen ? 10_000 : 3_600_000);

  const browserVisible =
    isOpen && !fullPage && activeTab === "browser" && tabs.includes("browser") && !overlayOpen;

  const value = useMemo<RightPanelContextValue>(
    () => ({
      isOpen,
      projectId,
      tabs,
      activeTab,
      open,
      close,
      activate,
      toggle,
      setOpen: setOpenState,
      width,
      setWidth,
      resizing,
      setResizing,
      overlayOpen,
      setOverlayOpen,
      browserVisible,
      browserMounted,
      browserLive,
      queueCount: activeRuns,
    }),
    [isOpen, projectId, tabs, activeTab, open, close, activate, toggle, width, resizing, overlayOpen, browserVisible, browserMounted, browserLive, activeRuns]
  );

  return <RightPanelContext.Provider value={value}>{children}</RightPanelContext.Provider>;
}

/** Pure helpers re-exported for strip use (keep imports in one place). */
export { addTabPure, closeTabPure };
