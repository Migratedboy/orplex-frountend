"use client";

/**
 * EmptyLauncher.tsx — shown when no tabs are open (fresh install state in v2):
 * the six tab entries as a vertical launcher list (reference Empty state).
 */
import { ALL_TABS, TAB_META, type TabId } from "@/lib/panel-state";
import { TabIcon } from "./TabBar";

export function EmptyLauncher({ onOpen }: { onOpen: (id: TabId) => void }) {
  // Reference order for the launcher (browser first), not canonical tab order.
  const LAUNCH_ORDER: TabId[] = ["browser", "files", "terminal", "changes", "queue", "scratch"];
  const ordered = LAUNCH_ORDER.filter((id) => (ALL_TABS as string[]).includes(id));
  return (
    <div className="rp-v2-launcher" role="menu" aria-label="Open a tab">
      {ordered.map((id) => (
        <button key={id} className="rp-v2-launcher-item" onClick={() => onOpen(id)}>
          <TabIcon id={id} size={17} />
          {TAB_META[id].label}
        </button>
      ))}
    </div>
  );
}
