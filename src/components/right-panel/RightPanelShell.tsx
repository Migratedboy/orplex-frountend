"use client";

/**
 * RightPanelShell.tsx — the Right Panel v2 shell (P1): Freebuff-style open-tab
 * bar, empty launcher, persistence + migration, lazy tabs, per-tab error
 * boundary, resize grip, and the browser keep-mounted contract (native views
 * survive panel close / tab close — hidden via `preview:show-tab`, freed
 * after 10 min idle once the browser tab is closed — DECISIONS D13).
 *
 * The aside is ALWAYS rendered (display:none when closed): returning null
 * would unmount the browser tab and destroy its native WebContentsViews,
 * which is exactly the state loss v2 removes.
 */
import { lazy, Suspense, Component, type ReactNode, useEffect, useRef, useState } from "react";
import { ErrorView } from "../StateViews";
import { QueuePanelSkeleton, FilesPanelSkeleton, ChangesPanelSkeleton } from "../PanelSkeletons";
import {
  OPEN_KEY,
  OPEN_TABS_KEY,
  LEGACY_TAB_KEY,
  parseOpenTabs,
  legacyTabToOpenTabs,
  defaultTabToOpenTabs,
  toLegacyTabId,
  addTab,
  closeTab,
  type TabId,
} from "@/lib/panel-state";
import { useActiveRunCount } from "@/hooks/useActiveRunCount";
import { TabBar } from "./TabBar";
import { EmptyLauncher } from "./EmptyLauncher";

// Lazy tabs (budget §2.8: a closed tab costs ~0; chunk loads on first open).
const QueueTab = lazy(() => import("./QueueTab").then((m) => ({ default: m.QueueTab })));
const ChangesTab = lazy(() => import("./changes-tab").then((m) => ({ default: m.ChangesTab })));
const FilesTab = lazy(() => import("./FilesTab").then((m) => ({ default: m.FilesTab })));
const TerminalTab = lazy(() => import("./terminal-tab").then((m) => ({ default: m.TerminalTab })));
const ScratchTab = lazy(() => import("./ScratchTab").then((m) => ({ default: m.ScratchTab })));
// The native preview view can't be hidden by CSS; it stays mounted and its
// visibility is toggled via preview:showTab (preview-tab handles that).
const BrowserPreview = lazy(() => import("./preview-tab"));

// Error boundary to prevent one tab crash from killing the whole panel
// (moved verbatim from RightPanel.tsx).
class TabErrorBoundary extends Component<{ children: ReactNode; tab: string }, { error: string | null; errorInfo: string | null }> {
  state = { error: null as string | null, errorInfo: null as string | null };
  static getDerivedStateFromError(err: Error) { return { error: err.message }; }
  componentDidCatch(err: Error, info: React.ErrorInfo) {
    this.setState({ errorInfo: info.componentStack || null });
    console.error(`[TabErrorBoundary:${this.props.tab}]`, err, info);
  }
  render() {
    if (this.state.error) {
      return (
        <ErrorView
          error={this.state.error}
          title="Tab error"
          retry={() => this.setState({ error: null, errorInfo: null })}
          className="rp-empty"
        />
      );
    }
    return this.props.children;
  }
}

function RpTabFallback({ tab }: { tab: TabId }) {
  if (tab === "queue") return <QueuePanelSkeleton />;
  if (tab === "files") return <FilesPanelSkeleton />;
  if (tab === "changes") return <ChangesPanelSkeleton />;
  return <div className="rp-empty" aria-busy="true">Loading…</div>;
}

export interface RightPanelShellProps {
  open: boolean;
  onClose: () => void;
  defaultTab?: string;
  onResizingChange?: (resizing: boolean) => void;
}

const DEFAULT_RP_WIDTH = 620;
const BROWSER_IDLE_FREE_MS = 10 * 60 * 1000;

export default function RightPanelShell({ open, onClose, defaultTab, onResizingChange }: RightPanelShellProps) {
  const [openTabs, setOpenTabs] = useState<TabId[]>([]);
  const [activeTab, setActiveTab] = useState<TabId | null>(null);
  const [browserMounted, setBrowserMounted] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [browserLive, setBrowserLive] = useState(false);
  const [restored, setRestored] = useState(false);

  // === Restore persisted state (post-hydration, never in useState) ===
  useEffect(() => {
    let initial: TabId[] = [];
    let initialActive: TabId | null = null;
    try {
      const fromNew = parseOpenTabs(sessionStorage.getItem(OPEN_TABS_KEY));
      if (fromNew !== null) {
        initial = fromNew;
        const legacy = legacyTabToOpenTabs(sessionStorage.getItem(LEGACY_TAB_KEY));
        const preferred = legacy[0];
        initialActive =
          (preferred && initial.includes(preferred) ? preferred : initial[initial.length - 1]) ?? null;
      } else {
        initial = legacyTabToOpenTabs(sessionStorage.getItem(LEGACY_TAB_KEY));
        if (initial.length === 0) initial = defaultTabToOpenTabs(defaultTab);
        initialActive = initial[initial.length - 1] ?? null;
      }
    } catch {
      // storage blocked — fall through to the empty launcher
    }
    setOpenTabs(initial);
    setActiveTab(initialActive);
    if (initial.includes("browser")) setBrowserMounted(true);
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Programmatic open (AppLayout's defaultTab changed: Ctrl+T, Ctrl+1..6,
  // orplex:open-panel). Runs after restore so mount-time restore wins.
  useEffect(() => {
    if (!restored || !defaultTab) return;
    const toOpen = defaultTabToOpenTabs(defaultTab);
    if (toOpen.length === 0) return;
    const id = toOpen[0];
    setOpenTabs((prev) => {
      if (prev.includes(id)) return prev;
      return [...prev, id];
    });
    setActiveTab(id);
    if (id === "browser") setBrowserMounted(true);
  }, [restored, defaultTab]);

  // Persist open list + legacy keys (AppLayout + reset-recovery-tab compat).
  useEffect(() => {
    if (!restored) return;
    try {
      sessionStorage.setItem(OPEN_TABS_KEY, JSON.stringify(openTabs));
      sessionStorage.setItem(OPEN_KEY, open ? "1" : "0");
      if (activeTab) sessionStorage.setItem(LEGACY_TAB_KEY, toLegacyTabId(activeTab));
    } catch {}
  }, [openTabs, activeTab, open, restored]);

  // === Resize (drag the left grip) — moved verbatim from RightPanel.tsx ===
  // Panel width lives IN CODE (no persistence): 620px out of the box — a
  // real browser width for the preview. Dragging resizes for the session;
  // reload always returns to the coded default.
  const [width, setWidth] = useState<number>(DEFAULT_RP_WIDTH);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragStart = useRef({ x: 0, w: 0 });

  useEffect(() => {
    document.documentElement.style.setProperty("--rp-w", `${Math.round(width)}px`);
  }, [width]);

  useEffect(() => {
    onResizingChange?.(resizing);
    return () => onResizingChange?.(false);
  }, [resizing, onResizingChange]);

  useEffect(() => {
    if (!resizing) return undefined;
    // Freeze text selection + show the resize cursor for the whole drag.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onPointerMove = (e: PointerEvent) => {
      const max = Math.min(720, window.innerWidth - 320);
      // Clamp the max FIRST, then enforce the 280 floor — on narrow windows
      // max can drop below the floor and must not shrink the panel.
      const next = Math.max(280, Math.min(max, dragStart.current.w + (dragStart.current.x - e.clientX)));
      setWidth(next);
    };
    const stop = () => {
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizing]);

  // Browser idle-free (D13): tab closed → hidden views freed after 10 min.
  useEffect(() => {
    if (!browserMounted || openTabs.includes("browser")) return;
    const t = setTimeout(() => setBrowserMounted(false), BROWSER_IDLE_FREE_MS);
    return () => clearTimeout(t);
  }, [browserMounted, openTabs]);

  // Browser-live dot (localhost probe) while the panel is open.
  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  const { activeRuns } = useActiveRunCount(10_000);

  // Popover open does NOT freeze the native view here — useOverlayFreeze (P4)
  // is what hides the view under overlays; this state just toggles the menu.
  void popoverOpen;

  const onActivate = (id: TabId) => {
    setActiveTab(id);
    if (id === "browser") setBrowserMounted(true);
  };
  const onOpenTab = (id: TabId) => {
    const r = addTab(openTabs, id);
    setOpenTabs(r.openTabs);
    setActiveTab(r.activeTab);
    if (id === "browser") setBrowserMounted(true);
  };
  const onCloseTab = (id: TabId) => {
    const r = closeTab(openTabs, activeTab, id);
    setOpenTabs(r.openTabs);
    setActiveTab(r.activeTab);
  };

  const browserVisible = open && activeTab === "browser" && openTabs.includes("browser");

  return (
    <aside
      className="orplex-rp right-panel"
      style={{
        position: "fixed", top: 64, right: 0, bottom: 0,
        width: "min(var(--rp-w, 620px), 100vw)", zIndex: 35,
        display: open ? "flex" : "none",
      }}
      data-resizing={resizing ? "" : undefined}
      aria-hidden={!open}
    >
      {/* Resize grip — drag to resize, double-click to reset, arrows for keyboard */}
      <div
        className="rp-resize-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        title="Drag to resize · double-click to reset"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragStart.current = { x: e.clientX, w: widthRef.current };
          try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
          setResizing(true);
        }}
        onDoubleClick={() => setWidth(DEFAULT_RP_WIDTH)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 40 : 16;
          const max = Math.min(720, window.innerWidth - 320);
          if (e.key === "ArrowLeft") { e.preventDefault(); setWidth(w => Math.max(280, Math.min(max, w + step))); }
          if (e.key === "ArrowRight") { e.preventDefault(); setWidth(w => Math.max(280, Math.min(max, w - step))); }
        }}
        tabIndex={0}
      />
      <TabBar
        openTabs={openTabs}
        activeTab={activeTab}
        onActivate={onActivate}
        onCloseTab={onCloseTab}
        onOpenTab={onOpenTab}
        onClosePanel={onClose}
        badges={{ browserLive, queueCount: activeRuns }}
        onPopoverChange={setPopoverOpen}
      />
      <div className="rp-content">
        {open && activeTab === null && <EmptyLauncher onOpen={onOpenTab} />}
        {open && activeTab !== null && (
          <TabErrorBoundary tab={activeTab}>
            <Suspense fallback={<RpTabFallback tab={activeTab} />}>
              {activeTab === "queue" && <QueueTab />}
              {activeTab === "changes" && <ChangesTab />}
              {activeTab === "files" && <FilesTab />}
              {/* Browser: kept mounted (hidden) across close/switch; native
                  view visibility is driven by panelActive via showTab. */}
              {activeTab === "terminal" && <TerminalTab />}
              {activeTab === "scratch" && <ScratchTab />}
            </Suspense>
          </TabErrorBoundary>
        )}
        {/* Browser lives outside the conditional tree: hiding the aside
            (panel closed) or the tab wrapper (tab closed) must not unmount it. */}
        {browserMounted && (
          <div
            style={{
              height: "100%",
              display: browserVisible ? undefined : "none",
            }}
            aria-hidden={!browserVisible}
          >
            <TabErrorBoundary tab="browser">
              <Suspense fallback={<RpTabFallback tab="browser" />}>
                <BrowserPreview panelActive={browserVisible} />
              </Suspense>
            </TabErrorBoundary>
          </div>
        )}
      </div>
    </aside>
  );
}
