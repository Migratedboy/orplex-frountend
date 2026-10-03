"use client";

import { ErrorBoundary } from "react-error-boundary";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useState, useEffect, useCallback } from "react";
import ScrollFadeManager from "./ScrollFadeManager";

const ArtifactPanel = dynamic(() => import("./ArtifactPanel"), { ssr: false });
const RightPanel = dynamic(() => import("./RightPanel"), { ssr: false });
const ApprovalDialog = dynamic(() => import("./ApprovalDialog"), { ssr: false });
const CommandPalette = dynamic(() => import("./CommandPalette"), { ssr: false });
const MemoryPanel = dynamic(() => import("./MemoryPanel"), { ssr: false });

// Dynamic imports: Sidebar and TopBar use usePathname/useRouter which need client context.
// Loaded once and persisted across all navigations since this component
// now lives in the root layout.
const SidebarInner = dynamic(() => import("./Sidebar"), {
  ssr: false,
  loading: () => <nav className="sidebar-nav"><div style={{ padding: 16, opacity: 0.3 }}><div className="skeleton" style={{ height: 32, width: "80%", marginBottom: 12 }} /><div className="skeleton" style={{ height: 24, width: "60%", marginBottom: 8 }} /><div className="skeleton" style={{ height: 24, width: "70%", marginBottom: 8 }} /></div></nav>,
});
const TopBarInner = dynamic(() => import("./TopBar"), {
  ssr: false,
  loading: () => <header className="topbar-header"><div style={{ padding: "0 16px", height: 56, display: "flex", alignItems: "center" }}><div className="skeleton" style={{ height: 20, width: 120 }} /></div></header>,
});
const BugReportModal = dynamic(() => import("./BugReportModal"), { ssr: false });
const ProductivityOverlays = dynamic(() => import("./ProductivityOverlays"), { ssr: false });

// Artifact panel state — managed at layout level so any component can open it.
// A const bridge object (not reassignable module-lets) so the React compiler
// can safely memoize components that import these functions.
const artifactPanelBridge: {
  open: ((runId: string) => void) | null;
  close: (() => void) | null;
} = { open: null, close: null };

// Memory panel bridge — same pattern as the artifact panel: global open()
// assigned in an effect, so slash commands / command palette can invoke it.
const memoryPanelBridge: { open: (() => void) | null } = { open: null };

export function openMemoryPanel() {
  memoryPanelBridge.open?.();
}

export function openArtifactPanel(runId: string) {
  artifactPanelBridge.open?.(runId);
}

export function closeArtifactPanel() {
  artifactPanelBridge.close?.();
}

const ROUTE_TITLES: Record<string, string> = {
  "/": "New Chat",
  "/history": "History",
  "/packages": "Packages",
  "/settings": "Settings",
};

interface AppLayoutProps {
  children: React.ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  const pathname = usePathname();
  const title = ROUTE_TITLES[pathname] || "Orplex";
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // Right panel open/tab state survives page reloads (dev HMR, crash
  // recovery) — a closed panel on refresh made the embedded browser feel
  // like it "disappeared".
  // NOTE: deterministic defaults + restore-in-effect, NEVER storage reads in
  // useState initializers (server HTML would mismatch the client → React
  // hydration error).
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<string | undefined>(undefined);
  useEffect(() => {
    try {
      const savedOpen = sessionStorage.getItem("orplex.rightPanel") === "1";
      if (savedOpen) setRightPanelOpen(true);
      const savedTab = sessionStorage.getItem("orplex.rightPanelTab");
      if (savedTab) setRightPanelTab(savedTab);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem("orplex.rightPanel", rightPanelOpen ? "1" : "0");
      if (rightPanelTab) sessionStorage.setItem("orplex.rightPanelTab", rightPanelTab);
      else sessionStorage.removeItem("orplex.rightPanelTab");
    } catch {}
  }, [rightPanelOpen, rightPanelTab]);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // === Left sidebar collapse ===
  // User-controlled collapse (separate from the automatic left-hidden when
  // the right panel opens). Persisted, and restored in an effect — never a
  // storage read in useState (hydration mismatch).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    try { setSidebarCollapsed(localStorage.getItem("orplex.sidebarCollapsed") === "1"); } catch {}
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem("orplex.sidebarCollapsed", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  // Global New Chat handler — always mounted (even on /history, /settings, etc.)
  // Ensures chat state is cleared when New Chat is clicked from any page
  useEffect(() => {
    const handler = () => {
      // Kill the running agent AND clear state — New Chat means "stop working"
      try { import("@/lib/background-chat").then(m => m.abortCurrentTask()); } catch {}
    };
    window.addEventListener("orplex:new-chat", handler);
    return () => window.removeEventListener("orplex:new-chat", handler);
  }, []);

  // Cross-component panel opening (FirstRunExperience advanced row, recovery
  // actions, tips): open the right panel directly to a tab.
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent).detail?.tab;
      setRightPanelOpen(true);
      if (typeof tab === "string") setRightPanelTab(tab);
    };
    window.addEventListener("orplex:open-panel", handler);
    return () => window.removeEventListener("orplex:open-panel", handler);
  }, []);

  // Keyboard shortcuts for right panel + command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "b") {
        e.preventDefault();
        setRightPanelOpen(prev => !prev);
        setRightPanelTab(undefined); // default tab
      } else if (mod && e.key === "t") {
        e.preventDefault();
        setRightPanelOpen(true);
        setRightPanelTab("terminal");
      } else if (mod && e.key === "k") {
        // Command palette — intercepts Ctrl+K before TopBar search-focus handler
        e.preventDefault();
        e.stopImmediatePropagation();
        setPaletteOpen(true);
      } else if (mod && ["1", "2", "3", "4", "5", "6"].includes(e.key)) {
        // Ctrl+1..6: jump straight to a right-panel tab (opens the panel).
        const tab = { "1": "queue", "2": "changes", "3": "files", "4": "preview", "5": "terminal", "6": "scratch" }[e.key];
        if (tab) {
          e.preventDefault();
          setRightPanelOpen(true);
          setRightPanelTab(tab);
        }
      } else if (mod && e.key === "\\") {
        // Ctrl+\: collapse/expand the left sidebar.
        e.preventDefault();
        toggleSidebar();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // Register the global open/close functions (assigned in an effect, not render)
  useEffect(() => {
    artifactPanelBridge.open = (runId: string) => {
      setSelectedRunId(runId);
      setArtifactPanelOpen(true);
    };
    artifactPanelBridge.close = () => {
      setArtifactPanelOpen(false);
    };
    memoryPanelBridge.open = () => setMemoryPanelOpen(true);
    return () => {
      artifactPanelBridge.open = null;
      artifactPanelBridge.close = null;
      memoryPanelBridge.open = null;
    };
  }, []);

  const isAuthRoute = pathname.startsWith("/auth");

  if (isAuthRoute) {
    return <>{children}</>;
  }  return (
    <>
      <div className={`app-root ${rightPanelOpen ? "left-hidden" : ""} ${sidebarCollapsed ? "sb-collapsed" : ""}`}>
        <SidebarInner />
        <TopBarInner title={title} onBugReport={() => setBugReportOpen(true)} onTogglePanel={() => setRightPanelOpen(!rightPanelOpen)} panelOpen={rightPanelOpen} onToggleSidebar={toggleSidebar} sidebarCollapsed={sidebarCollapsed} />
        {sidebarCollapsed && (
          <button className="sb-expand-fab" onClick={toggleSidebar} title="Expand sidebar (Ctrl+\)" aria-label="Expand sidebar">
            <span className="ms">left_panel_open</span>
          </button>
        )}
        <main className={`main-content ${artifactPanelOpen ? "panel-open" : ""} ${rightPanelOpen ? "rp-open" : ""} ${rightPanelResizing ? "rp-resizing" : ""}`}>
          {children}
        </main>
        <ArtifactPanel
          open={artifactPanelOpen}
          runId={selectedRunId}
          onClose={() => setArtifactPanelOpen(false)} />
        {memoryPanelOpen && (
          <div className="memory-panel-overlay fixed inset-0 z-40" onClick={() => setMemoryPanelOpen(false)} style={{ background: "rgba(0,0,0,0.2)" }}>
            <div
              className="absolute top-16 right-6 w-[380px] max-w-[90vw] rounded-lg border border-surface-variant bg-surface shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <MemoryPanel onClose={() => setMemoryPanelOpen(false)} />
            </div>
          </div>
        )}
      {bugReportOpen && <BugReportModal onClose={() => setBugReportOpen(false)} />}
      <ProductivityOverlays />
    </div>        <RightPanel open={rightPanelOpen} onClose={() => setRightPanelOpen(false)} defaultTab={rightPanelTab as any} onResizingChange={setRightPanelResizing} />
      {paletteOpen && (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onOpenPanel={(tab) => { setRightPanelOpen(true); setRightPanelTab(tab); }}
          onOpenRun={(runId) => openArtifactPanel(runId)}
        />
      )}
      <ApprovalDialog />
      <ScrollFadeManager />
    </>
  );
}