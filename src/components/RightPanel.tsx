"use client";

/**
 * RightPanel.tsx — thin re-export kept so every existing import keeps working
 * after the shell refactor (spec §3). All logic lives in
 * right-panel/RightPanelShell.tsx; tab state comes from RightPanelContext,
 * so the component takes no props anymore.
 */
import RightPanelShell from "./right-panel/RightPanelShell";

export default function RightPanel() {
  return <RightPanelShell />;
}
