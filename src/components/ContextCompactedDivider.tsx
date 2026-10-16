"use client";

// ContextCompactedDivider — a quiet system row in the agent timeline showing
// that the conversation context was summarized to free up tokens.
//
// It is an EVENT MARKER, not a message: nothing said it, nobody can reply to
// it. So it deliberately has no avatar, no bubble, and no accent colour —
// every tone is a neutral gray, because a system event that looks like the
// assistant talking is a system event that will be misread.
//
// Token counts come from format-tokens.ts and are "~"-prefixed: they are
// estimates, and a row claiming "210,003 tokens" would be claiming precision
// the app does not have.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatTokenDelta } from "@/lib/format-tokens";
import { IconChevronRight, IconMore } from "./Icons";

export interface ContextCompactedProps {
  tokensBefore: number;
  tokensAfter: number;
  mode: "automatic" | "manual";
  /** The summary the evicted turns were replaced with, if one was captured. */
  summary?: string;
  onCopy?: (summary: string) => void;
  onViewFull?: () => void;
  /**
   * Undo action. Omitted entirely when not provided — the app has no
   * restore-compaction path, so rendering a dead button would be worse than
   * not offering one.
   */
  onUndo?: () => void;
}

export default function ContextCompactedDivider({
  tokensBefore,
  tokensAfter,
  mode,
  summary,
  onCopy,
  onViewFull,
  onUndo,
}: ContextCompactedProps) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const panelId = useId();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const kebabRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const kebabId = useId();

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const closeMenu = useCallback((returnFocus = true) => {
    setMenuOpen(false);
    // Focus goes back to the trigger, otherwise keyboard users are dumped at
    // the top of the document when the menu closes.
    if (returnFocus) kebabRef.current?.focus();
  }, []);

  // Outside click closes the menu (but NOT the row — only Escape does that,
  // so a click on the summary text does not collapse what you just opened).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen, closeMenu]);

  // Arrow-key roving + Escape, scoped to the menu.
  useEffect(() => {
    if (!menuOpen || !menuRef.current) return;
    const items = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeMenu();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = items.indexOf(document.activeElement as HTMLButtonElement);
        // idx === -1 (focus moved off the menu) must land on the LAST item for
        // ArrowUp, not on `length - 2`.
        const next =
          e.key === "ArrowDown"
            ? (idx + 1) % items.length
            : idx <= 0
              ? items.length - 1
              : idx - 1;
        items[next]?.focus();
        return;
      }
      // Tab out of the menu must close it (WAI-ARIA menu-button pattern).
      // Focus is deliberately NOT returned to the kebab here — the user is
      // tabbing forward, and yanking focus back would trap them.
      if (e.key === "Tab") closeMenu(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuOpen, closeMenu]);

  // Open the menu with the first item focused, so it is keyboard-reachable.
  useEffect(() => {
    if (!menuOpen) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]");
    first?.focus();
  }, [menuOpen]);

  const menuItems = [
    onCopy && summary ? { key: "copy", label: "Copy summary", run: () => onCopy(summary) } : null,
    onViewFull ? { key: "full", label: "View full summary", run: onViewFull } : null,
    onUndo ? { key: "undo", label: "Undo compaction", run: onUndo } : null,
  ].filter(Boolean) as Array<{ key: string; label: string; run: () => void }>;

  const hasSummary = typeof summary === "string" && summary.trim().length > 0;
  // Always expandable: the panel renders content in BOTH cases (the summary,
  // or an explicit "no summary was captured" note), so gating the disclosure
  // on `hasSummary` produced a row that toggled visually while advertising no
  // aria-expanded at all. The summary only gates the Copy menu ITEM.
  const expandable = true;

  return (
    <div className="ccd" ref={rootRef}>
      <div className="ccd-row-wrap">
        <button
          type="button"
          className="ccd-row"
          onClick={toggle}
          // Escape collapses an open disclosure: without this, a keyboard user
          // can expand it and has no way back.
          onKeyDown={(e) => {
            if (e.key === "Escape" && expanded) {
              e.stopPropagation();
              setExpanded(false);
            }
          }}
          aria-expanded={expandable ? expanded : undefined}
          aria-controls={expandable ? panelId : undefined}
        >
          <span className={`ccd-chevron${expanded ? " ccd-chevron-open" : ""}`} aria-hidden="true">
            <IconChevronRight size={16} />
          </span>
          <span className="ccd-label">Context compacted</span>
          <span className="ccd-delta">{formatTokenDelta(tokensBefore, tokensAfter)}</span>
          <span className="ccd-mode">{mode === "automatic" ? "Automatic" : "Manual"}</span>
          <span className="ccd-fill" aria-hidden="true" />
        </button>

        {menuItems.length > 0 && (
          <button
            type="button"
            className="ccd-kebab"
            ref={kebabRef}
            id={kebabId}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onClick={(e) => {
              // Without this the click bubbles to the row and the whole
              // divider expands every time you try to open the menu.
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            <IconMore size={16} />
          </button>
        )}
      </div>

      {menuOpen && (
        <div className="ccd-menu" id={menuId} role="menu" ref={menuRef} aria-labelledby={kebabId}>
          {menuItems.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="ccd-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                closeMenu();
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      <div
        id={panelId}
        className={`ccd-panel${expanded ? " ccd-panel-open" : ""}`}
        // NOT `hidden`: Tailwind's preflight sets `[hidden]{display:none}` at
        // the TOP of globals.css, and `.ccd-panel{display:grid}` further down
        // wins on source order at equal specificity — so `hidden` did nothing,
        // and a collapsed row still exposed the whole summary to screen
        // readers. aria-hidden is the honest signal while `0fr` keeps the
        // height transition animatable.
        aria-hidden={!expanded || undefined}
      >
        <div className="ccd-panel-divider" aria-hidden="true" />
        {hasSummary ? (
          <p className="ccd-summary">{summary}</p>
        ) : (
          <p className="ccd-summary ccd-summary-empty">No summary was captured for this compaction.</p>
        )}
      </div>
    </div>
  );
}