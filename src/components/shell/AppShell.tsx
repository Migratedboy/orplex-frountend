"use client";

/**
 * AppShell.tsx — the new shell (spec §2/§3): top strip + icon rail + sidebar
 * slot + center (ToolsCluster + page host) + right-panel slot. The full-page
 * Settings/Integrations views will mount as shell slots in phases 6/7.
 *
 * Everything the old AppLayout composed (overlay bridges, artifact/memory
 * panels, palette, approval dialog, bug report, productivity overlays,
 * update card, scroll fades, first-run tour) is re-mounted here. The bridge
 * exports keep their old import path — AppLayout re-exports them.
 */
import { ErrorBoundary } from "react-error-boundary";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";
import ScrollFadeManager from "../ScrollFadeManager";
import { ShortcutsPanel, OnboardingTour } from "../ui";
import { useConversations } from "../ConversationProvider";
import { useFileSystemContext } from "../FileSystemProvider";
import { useTheme } from "../ThemeProvider";
import { IconDefs } from "@/components/ui/Icon";
import "./shell.css";
import { normalizeTabId } from "@/lib/panel-state";
import { ShellProvider, useShell } from "./ShellContext";
import { RightPanelProvider, useRightPanel } from "./RightPanelContext";
import { useShortcuts } from "@/lib/shortcuts";
import Strip from "./Strip";
import Rail from "./Rail";
import ToolsCluster from "./ToolsCluster";
import RightPanelShell from "../right-panel/RightPanelShell";

// Dynamic imports: Sidebar uses usePathname/useRouter which need client
// context. Loaded once and persisted across all navigations since this
// component lives in the root layout.
const SidebarInner = dynamic(() => import("../Sidebar"), {
  ssr: false,
  loading: () => <nav aria-label="Conversations" style={{ padding: 16, opacity: 0.3 }}><div className="skeleton" style={{ height: 32, width: "80%", marginBottom: 12 }} /><div className="skeleton" style={{ height: 24, width: "60%", marginBottom: 8 }} /><div className="skeleton" style={{ height: 24, width: "70%", marginBottom: 8 }} /></nav>,
});

const ArtifactPanel = dynamic(() => import("../ArtifactPanel"), { ssr: false });
const ApprovalDialog = dynamic(() => import("../ApprovalDialog"), { ssr: false });
const CommandPalette = dynamic(() => import("../CommandPalette"), { ssr: false });
const MemoryPanel = dynamic(() => import("../MemoryPanel"), { ssr: false });
const BugReportModal = dynamic(() => import("../BugReportModal"), { ssr: false });
const ProductivityOverlays = dynamic(() => import("../ProductivityOverlays"), { ssr: false });
const UpdateCard = dynamic(() => import("../update/UpdateCard"), { ssr: false });

// Artifact panel state — managed at shell level so any component can open it.
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

function closeArtifactPanel() {
  artifactPanelBridge.close?.();
}

/**
 * The active project (workspace NAME) for right-panel tab grouping, or null
 * for ungrouped chats (global legacy keys). Same rule the strip tabs use:
 * the open conversation's workspace, else the attached folder.
 */
function useActiveProjectId(): string | null {
  const { conversations } = useConversations();
  const { directoryName } = useFileSystemContext();
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const read = () => setActiveId(new URLSearchParams(window.location.search).get("c"));
    read();
    window.addEventListener("popstate", read);
    window.addEventListener("orplex:open-conversation", read);
    const interval = setInterval(() => {
      const current = new URLSearchParams(window.location.search).get("c");
      setActiveId((prev) => (prev === current ? prev : current));
    }, 400);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener("orplex:open-conversation", read);
      clearInterval(interval);
    };
  }, []);

  const conv = activeId ? conversations.find((c) => c.id === activeId) : undefined;
  return conv?.workspaceName || directoryName || null;
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { sidebarCollapsed } = useShell();
  const rp = useRightPanel();
  const { toggle: toggleTheme } = useTheme();
  const { status } = useSession();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

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

  // The single global shortcut dispatcher (Decision D4 — src/lib/shortcuts.ts).
  useShortcuts({
    palette: () => setPaletteOpen(true),
    help: () => setShortcutsOpen(true),
    panel: () => rp.toggle(),
    terminal: () => rp.open("terminal"),
    "tab-queue": () => rp.open("queue"),
    "tab-changes": () => rp.open("changes"),
    "tab-files": () => rp.open("files"),
    "tab-browser": () => rp.open("browser"),
    "tab-terminal": () => rp.open("terminal"),
    "tab-scratch": () => rp.open("scratch"),
    sidebar: () => window.dispatchEvent(new CustomEvent("orplex:toggle-sidebar")),
    "new-chat": () => window.dispatchEvent(new CustomEvent("orplex:new-chat")),
    stop: () => { void import("@/lib/background-chat").then((m) => m.abortCurrentTask()); },
    theme: () => toggleTheme(),
  });

  // === First-run guided tour ===
  // Shown exactly once per browser profile: the first authenticated visit to
  // home (i.e. right after the account was created — sign-up is OAuth and
  // lands on "/"). Completion is persisted locally; "Take the tour" in the
  // empty-start hero reopens it on demand via orplex:open-tutorial.
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (status !== "authenticated" || pathname !== "/") return;
    // Let the dynamic sidebar/prompt bar + BootGate settle before the first
    // spotlight appears.
    const t = setTimeout(() => {
      try {
        if (localStorage.getItem("orplex.hasCompletedTutorial") !== "1") setTourOpen(true);
      } catch {
        setTourOpen(true); // no storage (private mode) → show anyway, once per mount
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [status, pathname]);
  const finishTour = useCallback(() => {
    try { localStorage.setItem("orplex.hasCompletedTutorial", "1"); } catch {}
    setTourOpen(false);
  }, []);
  useEffect(() => {
    const onOpenTour = () => setTourOpen(true);
    window.addEventListener("orplex:open-tutorial", onOpenTour);
    return () => window.removeEventListener("orplex:open-tutorial", onOpenTour);
  }, []);

  const rootClasses = [
    "ox-shell",
    sidebarCollapsed ? "collapsed" : "",
    rp.isOpen ? "" : "rp-hidden",
  ].filter(Boolean).join(" ");

  return (
    <div className={rootClasses}>
      <IconDefs />
      <Strip />
      <div className="ox-body">
        <Rail />
        <aside className="ox-side">
          <div className="ox-side-in">
            <SidebarInner />
          </div>
        </aside>
        <main className="ox-main">
          <section className="ox-center">
            <ToolsCluster />
            <div className="ox-page-host">
              <ErrorBoundary fallback={<div style={{ padding: 24, textAlign: "center", color: "#666" }}>Something went wrong loading this view. <button onClick={() => window.location.reload()} style={{ color: "#a04100" }}>Reload</button></div>}>
                {children}
              </ErrorBoundary>
            </div>
          </section>
          <div className="ox-rpanel">
            <RightPanelShell />
          </div>
        </main>
      </div>
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
      {shortcutsOpen && <ShortcutsPanel visible={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />}
      <ProductivityOverlays />
      {paletteOpen && (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onOpenPanel={(tab) => rp.open(normalizeTabId(tab) ?? "queue")}
          onOpenRun={(runId) => openArtifactPanel(runId)}
        />
      )}
      <ApprovalDialog />
      <ScrollFadeManager />
      <UpdateCard />
      {tourOpen && <OnboardingTour onComplete={finishTour} />}
    </div>
  );
}

export { closeArtifactPanel };

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const projectId = useActiveProjectId();
  const isAuthRoute = pathname.startsWith("/auth");
  // Full-page views cover the shell: the native browser view must hide.
  const fullPage = pathname.startsWith("/settings") || pathname.startsWith("/integrations");

  if (isAuthRoute) {
    return <>{children}</>;
  }

  return (
    <ShellProvider>
      <RightPanelProvider projectId={projectId} fullPage={fullPage}>
        <ShellInner>{children}</ShellInner>
      </RightPanelProvider>
    </ShellProvider>
  );
}
