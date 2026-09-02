"use client";

import { ErrorBoundary } from "react-error-boundary";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";

const ArtifactPanel = dynamic(() => import("./ArtifactPanel"), { ssr: false });
const RightPanel = dynamic(() => import("./RightPanel"), { ssr: false });
const ApprovalDialog = dynamic(() => import("./ApprovalDialog"), { ssr: false });
const CommandPalette = dynamic(() => import("./CommandPalette"), { ssr: false });

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

// Artifact panel state — managed at layout level so any component can open it
let _openArtifactPanel: ((runId: string) => void) | null = null;
let _closeArtifactPanel: (() => void) | null = null;

export function openArtifactPanel(runId: string) {
  _openArtifactPanel?.(runId);
}

export function closeArtifactPanel() {
  _closeArtifactPanel?.();
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
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<string | undefined>(undefined);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Global New Chat handler — always mounted (even on /history, /settings, etc.)
  // Ensures chat state is cleared when New Chat is clicked from any page
  useEffect(() => {
    const handler = () => {
      // Clear background task state
      try { import("@/lib/background-chat").then(m => m.cancelTask()); } catch {}
    };
    window.addEventListener("orplex:new-chat", handler);
    return () => window.removeEventListener("orplex:new-chat", handler);
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
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // Register the global open/close functions
  _openArtifactPanel = (runId: string) => {
    setSelectedRunId(runId);
    setArtifactPanelOpen(true);
  };
  _closeArtifactPanel = () => {
    setArtifactPanelOpen(false);
  };

  const isAuthRoute = pathname.startsWith("/auth");

  if (isAuthRoute) {
    return <>{children}</>;
  }  return (
    <>
      <div className="app-root">
        <SidebarInner />
        <TopBarInner title={title} onBugReport={() => setBugReportOpen(true)} onTogglePanel={() => setRightPanelOpen(!rightPanelOpen)} panelOpen={rightPanelOpen} />
        <main className={`main-content ${artifactPanelOpen ? "panel-open" : ""} ${rightPanelOpen ? "rp-open" : ""}`}>
          {children}
        </main>
        <ArtifactPanel
          open={artifactPanelOpen}
          runId={selectedRunId}
          onClose={() => setArtifactPanelOpen(false)} />
        {bugReportOpen && <BugReportModal onClose={() => setBugReportOpen(false)} />}
      </div>        <RightPanel open={rightPanelOpen} onClose={() => setRightPanelOpen(false)} defaultTab={rightPanelTab as any} />
      {paletteOpen && (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onOpenPanel={(tab) => { setRightPanelOpen(true); setRightPanelTab(tab); }}
          onOpenRun={(runId) => openArtifactPanel(runId)}
        />
      )}
      <ApprovalDialog />
    </>
  );
}