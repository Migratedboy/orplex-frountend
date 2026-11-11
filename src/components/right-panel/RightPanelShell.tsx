"use client";

/**
 * RightPanelShell.tsx — the Right Panel v2 body (P1): empty launcher, lazy
 * tabs, per-tab error boundary, resize grip, and the browser keep-mounted
 * contract (native views survive panel close / tab close — hidden via
 * `preview:show-tab`, freed after 10 min idle once the browser tab is
 * closed — DECISIONS D13).
 *
 * The tab BAR moved into the strip (spec §3): open/active tab state lives in
 * RightPanelContext and is shared with the strip's rzone. This component
 * renders the panel BODY inside the shell's `.ox-rpanel` slot (in-flow —
 * shell.css neutralizes the legacy fixed-position rules) and is ALWAYS
 * rendered: display:none when closed, because returning null would unmount
 * the browser tab and destroy its native WebContentsViews.
 */
import { lazy, Suspense, Component, type ReactNode, useEffect, useRef } from "react";
import { ErrorView } from "../StateViews";
import { QueuePanelSkeleton, FilesPanelSkeleton, ChangesPanelSkeleton } from "../PanelSkeletons";
import { useRightPanel } from "@/components/shell/RightPanelContext";
import { EmptyLauncher } from "./EmptyLauncher";

// Lazy tabs (budget §2.8: a closed tab costs ~0; chunk loads on first open).
const QueueTab = lazy(() => import("./QueueTab").then((m) => ({ default: m.QueueTab })));
const ChangesTab = lazy(() => import("./changes-tab").then((m) => ({ default: m.ChangesTab })));
const FilesTab = lazy(() => import("./FilesTab").then((m) => ({ default: m.FilesTab })));
const TerminalTab = lazy(() => import("./terminal-tab").then((m) => ({ default: m.TerminalTab })));
const ScratchTab = lazy(() => import("./ScratchTab").then((m) => ({ default: m.ScratchTab })));
// The native preview view can't be hidden by CSS; it stays mounted and its
// visibility is toggled via preview:showTab (preview-tab handles that).
const BrowserPreview = lazy(() => import("./BrowserTab"));

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

function RpTabFallback({ tab }: { tab: string }) {
  if (tab === "queue") return <QueuePanelSkeleton />;
  if (tab === "files") return <FilesPanelSkeleton />;
  if (tab === "changes") return <ChangesPanelSkeleton />;
  return <div className="rp-empty" aria-busy="true">Loading…</div>;
}

const DEFAULT_RP_WIDTH = 420;

export default function RightPanelShell() {
  const rp = useRightPanel();
  const { width, setWidth, resizing, setResizing } = rp;
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragStart = useRef({ x: 0, w: 0 });

  // The slot width follows the context width (NOT persisted — unchanged
  // behavior: reload always returns to the default).
  useEffect(() => {
    document.documentElement.style.setProperty("--rp-w", `${Math.round(width)}px`);
  }, [width]);

  // === Resize (drag the left grip) — moved verbatim from RightPanel.tsx ===
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
  }, [resizing, setWidth, setResizing]);

  const open = rp.isOpen;
  const activeTab = rp.activeTab;
  const browserVisible = rp.browserVisible;

  return (
    <aside
      className="orplex-rp right-panel"
      style={{ display: open ? "flex" : "none" }}
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
          if (e.key === "ArrowLeft") { e.preventDefault(); setWidth(Math.max(280, Math.min(max, widthRef.current + step))); }
          if (e.key === "ArrowRight") { e.preventDefault(); setWidth(Math.max(280, Math.min(max, widthRef.current - step))); }
        }}
        tabIndex={0}
      />
      <div className="rp-content">
        {open && activeTab === null && <EmptyLauncher onOpen={rp.open} />}
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
        {rp.browserMounted && (
          <div
            style={{
              height: "100%",
              display: browserVisible ? undefined : "none",
            }}
            aria-hidden={!browserVisible}
          >
            <TabErrorBoundary tab="browser">
              <Suspense fallback={<RpTabFallback tab="browser" />}>
                <BrowserPreview panelActive={browserVisible} overlayOpen={rp.overlayOpen} />
              </Suspense>
            </TabErrorBoundary>
          </div>
        )}
      </div>
    </aside>
  );
}
