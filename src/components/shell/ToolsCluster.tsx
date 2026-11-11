"use client";

/**
 * ToolsCluster.tsx — the floating tool buttons at the top-right of the chat
 * surface (design §tools): Tasks / Terminal / Files jump straight into the
 * matching right-panel tab, and the panel toggle mirrors the panel's open
 * state (id kept for tour anchoring + keyboard tests).
 */
import { Icon, type IconName } from "@/components/ui/Icon";
import { useRightPanel } from "./RightPanelContext";
import type { TabId } from "@/lib/panel-state";

const TOOLS: Array<{ id: TabId; icon: IconName; label: string }> = [
  { id: "queue", icon: "tasks", label: "Tasks" },
  { id: "terminal", icon: "term", label: "Terminal" },
  { id: "files", icon: "folder", label: "Files" },
];

export default function ToolsCluster() {
  const rp = useRightPanel();

  return (
    <div className="ox-tools" data-tour-id="tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={rp.isOpen && rp.activeTab === t.id ? "on" : ""}
          aria-label={t.label}
          title={`${t.label} — open in the right panel`}
          aria-pressed={rp.isOpen && rp.activeTab === t.id}
          onClick={() => rp.open(t.id)}
        >
          <Icon name={t.icon} size={17} />
        </button>
      ))}
      <button
        id="ox-rptoggle"
        className={rp.isOpen ? "on" : ""}
        aria-label="Toggle right panel"
        aria-pressed={rp.isOpen}
        title="Toggle right panel (Ctrl+B)"
        onClick={rp.toggle}
      >
        <Icon name="panelr" size={17} />
      </button>
    </div>
  );
}
