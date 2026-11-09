"use client";

/**
 * TabBar.tsx — the Freebuff-style tab bar (Right Panel v2, P1): open tabs as
 * icon+label chips, active tab expanded with a close ✕ (reference shows ✕ on
 * the active tab only), "+" popover listing closed tabs, spacer, and the
 * panel Close button on the far right.
 *
 * a11y: role=tablist / role=tab / aria-selected, ArrowLeft/ArrowRight/Home/End
 * navigation, Esc closes the popover (focus returns to the "+" button).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { closedTabs, ALL_TABS, TAB_META, type TabId } from "@/lib/panel-state";
import { RIcon, type RefIconName } from "./ref-icons";

const ICONS: Record<TabId, RefIconName> = {
  queue: "queue",
  changes: "branch",
  browser: "laptop",
  terminal: "term",
  files: "folder",
  scratch: "pen",
};

export function TabIcon({ id, size = 17 }: { id: TabId; size?: number }) {
  return <RIcon name={ICONS[id] ?? "queue"} size={size} />;
}

export interface TabBadges {
  /** Orange dot: a dev server is live (browser tab). */
  browserLive?: boolean;
  /** Queue running count (>0 shows a pill / dot). */
  queueCount?: number;
}

interface TabBarProps {
  openTabs: TabId[];
  activeTab: TabId | null;
  onActivate: (id: TabId) => void;
  onCloseTab: (id: TabId) => void;
  onOpenTab: (id: TabId) => void;
  onClosePanel: () => void;
  badges?: TabBadges;
  /** When the "+" popover opens, freeze the native view (P4 wires useOverlayFreeze). */
  onPopoverChange?: (open: boolean) => void;
}

export function TabBar({
  openTabs,
  activeTab,
  onActivate,
  onCloseTab,
  onOpenTab,
  onClosePanel,
  badges,
  onPopoverChange,
}: TabBarProps) {
  const [popOpen, setPopOpen] = useState(false);
  const plusRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // The bar renders even with no open tabs (reference: launcher state shows
  // the "+" alone) so the panel reads as "open a tab", not a dead zone.

  const setPop = useCallback(
    (open: boolean) => {
      setPopOpen(open);
      onPopoverChange?.(open);
    },
    [onPopoverChange]
  );

  // Close popover on outside click / Escape (focus returns to "+").
  useEffect(() => {
    if (!popOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest(".rp-v2-pop") && !el.closest(".rp-v2-plus")) setPop(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPop(false);
        plusRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [popOpen, setPop]);

  const onTabKeyDown = useCallback(
    (e: React.KeyboardEvent, idx: number) => {
      const n = openTabs.length;
      if (n === 0) return;
      let next: number | null = null;
      if (e.key === "ArrowRight") next = (idx + 1) % n;
      else if (e.key === "ArrowLeft") next = (idx - 1 + n) % n;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = n - 1;
      if (next !== null) {
        e.preventDefault();
        onActivate(openTabs[next]);
        tabRefs.current[next]?.focus();
      }
    },
    [openTabs, onActivate]
  );

  // The bar renders even with no open tabs (reference: launcher state shows
  // the "+" alone) so the panel reads as "open a tab", not a dead zone.
  const closed = closedTabs(openTabs);

  return (
    <div className="rp-v2-tabs" role="tablist" aria-label="Right panel tabs">
      {openTabs.map((id, idx) => {
        const meta = TAB_META[id];
        const active = id === activeTab;
        const showDot = id === "browser" && badges?.browserLive;
        const queueN = id === "queue" ? (badges?.queueCount ?? 0) : 0;
        return (
          <div
            key={id}
            className={`rp-v2-tab ${active ? "active" : ""}`}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={meta.label}
            // The div handles keyboard focus; the label/close are real buttons.
            ref={(el) => {
              tabRefs.current[idx] = el as unknown as HTMLButtonElement | null;
            }}
            onClick={() => onActivate(id)}
            onKeyDown={(e) => onTabKeyDown(e, idx)}
          >
            <span className="rp-v2-tab-icon" aria-hidden="true"><TabIcon id={id} size={17} /></span>
            <span className="rp-v2-tab-label">{meta.label}</span>
            {showDot && <span className="rp-v2-tab-dot" title="Dev server live" aria-hidden="true" />}
            {queueN > 0 && (
              <span className={`rp-v2-tab-count ${active ? "" : "is-dot"}`} title={`${queueN} running`}>
                {active ? queueN : ""}
              </span>
            )}
            {active && (
              <button
                className="rp-v2-tab-x"
                aria-label={`Close ${meta.label} tab`}
                title={`Close ${meta.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(id);
                }}
              >
                <RIcon name="x" size={14} />
              </button>
            )}
          </div>
        );
      })}

      <button
        ref={plusRef}
        className="rp-v2-plus"
        aria-label="Open another tab"
        aria-haspopup="menu"
        aria-expanded={popOpen}
        title="Open a tab"
        onClick={() => setPop(!popOpen)}
      >
        <RIcon name="plus" size={18} />
      </button>

      <div className="rp-v2-spacer" />

      <button className="rp-v2-panel-close" aria-label="Close right panel" title="Close panel" onClick={onClosePanel}>
        <RIcon name="x" size={16} />
      </button>

      {popOpen && (
        <div
          ref={popRef}
          className="rp-v2-pop"
          role="menu"
          aria-label="Closed tabs"
        >
          {closed.length === 0 ? (
            <div className="rp-v2-pop-none">All tabs are open</div>
          ) : (
            closed.map((id) => (
              <button
                key={id}
                className="rp-v2-pop-item"
                role="menuitem"
                onClick={() => {
                  onOpenTab(id);
                  setPop(false);
                  plusRef.current?.focus();
                }}
              >
                <TabIcon id={id} size={16} />
                {TAB_META[id].label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
