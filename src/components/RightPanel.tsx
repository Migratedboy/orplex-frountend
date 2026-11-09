"use client";

/**
 * RightPanel.tsx — thin re-export kept so every existing import (AppLayout)
 * keeps working after the v2 shell landed (spec §3). All logic lives in
 * right-panel/RightPanelShell.tsx.
 */
import RightPanelShell, { type RightPanelShellProps } from "./right-panel/RightPanelShell";

export type RightPanelProps = RightPanelShellProps & {
  /** Legacy alias: pre-v2 builds stored "preview"; the shell normalizes. */
  defaultTab?: string;
};

export default function RightPanel(props: RightPanelProps) {
  return <RightPanelShell {...props} />;
}
