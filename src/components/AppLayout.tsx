"use client";

/**
 * AppLayout.tsx — thin wrapper around the shell (spec §3). All composition
 * moved to shell/AppShell.tsx; the old top bar, keydown block and right-panel
 * state were re-homed to the strip, src/lib/shortcuts.ts and
 * shell/RightPanelContext.tsx. The overlay bridges keep their old import
 * path for every existing dynamic importer (AgentManager, CommandPalette,
 * RunBoard, useChatSession, RunHealthStrip).
 */
import AppShell from "./shell/AppShell";

export { openArtifactPanel, openMemoryPanel } from "./shell/AppShell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
