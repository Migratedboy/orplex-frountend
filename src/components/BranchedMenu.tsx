"use client";

// BranchedMenu.tsx — TypeScript port of the branched-tree sidebar menu.
//
// Sections expand to reveal children connected by an animated SVG trunk (a
// colored line "reaches" along the branch to the active child — the signature
// effect). Leaf sections (no children) render as single clickable rows.
//
// Adaptations from the original JSX:
//   • No @hugeicons dependency — `icon` accepts any ReactNode, so the app's
//     Material Symbols components plug straight in.
//   • Optional `badge` node on children (run counts, approval pips).
//   • onSelect/onToggle get full item context; props are fully typed.

import {
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./BranchedMenu.css";

const PAD = 6;
const MARK = 16;

export interface BranchedChild {
  value: string;
  label: string;
  /** Any renderable node — e.g. a Material Symbols component. */
  icon?: ReactNode;
  /** Optional trailing node (badge, count pill). */
  badge?: ReactNode;
  /** Native title/tooltip. */
  title?: string;
}

export interface BranchedItem {
  value?: string;
  label: string;
  /** Present = collapsible section; absent = standalone leaf row. */
  children?: BranchedChild[];
  /** Leading icon on the section header row. */
  icon?: ReactNode;
  /** Trailing node on the header (ghost chip, count). */
  badge?: ReactNode;
  /** Native title/tooltip for the header row. */
  title?: string;
}

interface BranchedMenuProps {
  items: BranchedItem[];
  /** Section index(es) open initially. Number or array; negative = none. */
  defaultOpen?: number | number[];
  /** Initially active child value (or leaf value). */
  defaultActive?: string;
  onSelect?: (value: string, item: BranchedChild | BranchedItem) => void;
  onToggle?: (index: number, isOpen: boolean) => void;
  /** Right-click (or mobile long-press) on a section header row. */
  onHeadContextMenu?: (index: number, anchor: { x: number; y: number }) => void;
  color?: string;
  accentColor?: string;
  lineColor?: string;
  width?: number;
  rowHeight?: number;
  indent?: number;
  trunk?: number;
  radius?: number;
  lineWidth?: number;
  fontSize?: number;
  drawDuration?: number;
  foldDuration?: number;
  className?: string;
}

const toSet = (open: number | number[]): Set<number> =>
  new Set(Array.isArray(open) ? open : open >= 0 ? [open] : []);

export default function BranchedMenu({
  items,
  defaultOpen = 0,
  defaultActive = "",
  onSelect,
  onToggle,
  onHeadContextMenu,
  // Ink/line are OPTIONAL: when omitted, the values come from BranchedMenu.css
  // (--bm-ink/--bm-line: dark defaults, light-mode overrides via
  // html:not(.dark)). Writing them inline unconditionally would beat the
  // light-mode stylesheet rules and leave white-on-white text in light mode.
  color,
  accentColor = "#ff6b00",
  lineColor,
  width = 240,
  rowHeight = 36,
  indent = 32,
  trunk = 14,
  radius = 10,
  lineWidth = 1.5,
  fontSize = 14,
  drawDuration = 400,
  foldDuration = 300,
  className = "",
}: BranchedMenuProps) {
  const [open, setOpen] = useState<Set<number>>(() => toSet(defaultOpen));
  // Follow external expansion changes (Sidebar's expandedProjects is the
  // source of truth for project branches; e.g. reopenProject auto-expands).
  //
  // The parent hands us a NEW array identity on every render, so depending on
  // defaultOpen directly would reset local expand/collapse state constantly and
  // fight the user's clicks. Depend on a content key instead, and read the
  // array through a ref so this stays stable and lint-clean.
  const defaultOpenKey = JSON.stringify(defaultOpen);
  const defaultOpenRef = useRef(defaultOpen);
  defaultOpenRef.current = defaultOpen;
  useEffect(() => {
    setOpen(toSet(defaultOpenRef.current));
  }, [defaultOpenKey]);
  const [active, setActive] = useState<string>(() => {
    if (defaultActive) return defaultActive;
    const first = items.find((it, i) => it.children && toSet(defaultOpen).has(i));
    return first?.children?.[0]?.value ?? "";
  });
  // Follow external active changes (e.g. Sidebar derives defaultActive from
  // the pathname — navigating between routes must move the highlight).
  useEffect(() => {
    setActive(defaultActive);
  }, [defaultActive]);
  const navRef = useRef<HTMLElement | null>(null);
  const heads = useRef<(HTMLButtonElement | null)[]>([]);
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const latest = useRef<{
    onSelect?: BranchedMenuProps["onSelect"];
    onToggle?: BranchedMenuProps["onToggle"];
    onHeadContextMenu?: BranchedMenuProps["onHeadContextMenu"];
  }>({});
  latest.current = { onSelect, onToggle, onHeadContextMenu };

  const activeSection = items.findIndex((it) => it.children?.some((kid) => kid.value === active));
  const markerShown = activeSection >= 0 && open.has(activeSection);

  useLayoutEffect(() => {
    const place = (glide: boolean) => {
      const m = markerRef.current;
      const el = heads.current[activeSection];
      if (!m) return;
      const on = Boolean(markerShown && el);
      if (!glide) m.style.transition = "none";
      if (on && el) m.style.top = `${el.offsetTop + (el.offsetHeight - MARK) / 2}px`;
      m.toggleAttribute("data-on", on);
      if (!glide) {
        void m.offsetHeight; // flush so the next transition animates
        m.style.transition = "";
      }
    };
    place(true);
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      place(false);
    });
    if (navRef.current) ro.observe(navRef.current);
    return () => ro.disconnect();
  }, [activeSection, markerShown, items, fontSize, rowHeight]);

  const select = (value: string, item: BranchedChild | BranchedItem) => {
    setActive(value);
    latest.current.onSelect?.(value, item);
  };

  const toggle = (i: number) => {
    // Compute the next state OUTSIDE the updater: React may run updaters
    // during render, and calling the parent's setState (onToggle) from in
    // there triggered "Cannot update a component while rendering a
    // different component". Setstate-in-render is a StrictMode no-no.
    const isOpen = !open.has(i);
    const next = new Set(open);
    if (isOpen) next.add(i);
    else next.delete(i);
    setOpen(next);
    latest.current.onToggle?.(i, isOpen);
  };

  // Mobile long-press on a header → same context-menu callback as right-click.
  const headLongPress = useRef<{ timer: number | null; x: number; y: number; armed: boolean }>({
    timer: null,
    x: 0,
    y: 0,
    armed: false,
  });
  const headTouchStart = (i: number, e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t || !latest.current.onHeadContextMenu) return;
    headLongPress.current = { timer: null, x: t.clientX, y: t.clientY, armed: true };
    headLongPress.current.timer = window.setTimeout(() => {
      if (headLongPress.current.armed) {
        headLongPress.current.armed = false;
        latest.current.onHeadContextMenu?.(i, { x: headLongPress.current.x, y: headLongPress.current.y });
      }
    }, 550);
  };
  const headTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t || !headLongPress.current.timer) return;
    const dx = Math.abs(t.clientX - headLongPress.current.x);
    const dy = Math.abs(t.clientY - headLongPress.current.y);
    if (dx > 10 || dy > 10) {
      headLongPress.current.armed = false;
      window.clearTimeout(headLongPress.current.timer);
      headLongPress.current.timer = null;
    }
  };
  const headTouchEnd = () => {
    headLongPress.current.armed = false;
    if (headLongPress.current.timer) window.clearTimeout(headLongPress.current.timer);
    headLongPress.current.timer = null;
  };

  const r = Math.min(radius, rowHeight / 2 - 2);
  const endX = indent - 8;
  const rowY = (k: number) => PAD + k * rowHeight + rowHeight / 2;
  const branch = (k: number) =>
    `M ${trunk} ${rowY(k) - r} A ${r} ${r} 0 0 0 ${trunk + r} ${rowY(k)} H ${endX}`;
  const reach = (k: number) =>
    `M ${trunk} 0 V ${rowY(k) - r} A ${r} ${r} 0 0 0 ${trunk + r} ${rowY(k)} H ${endX}`;
  const length = (k: number) => rowY(k) - r + (Math.PI * r) / 2 + (endX - trunk - r);

  return (
    <nav
      ref={navRef}
      className={`branched-menu${className ? ` ${className}` : ""}`}
      style={
        {
          "--bm-w": `${width}px`,
          ...(color ? { "--bm-ink": color } : null),
          "--bm-accent": accentColor,
          ...(lineColor ? { "--bm-line": lineColor } : null),
          "--bm-font": `${fontSize}px`,
          "--bm-row": `${rowHeight}px`,
          "--bm-indent": `${indent}px`,
          "--bm-line-w": lineWidth,
          "--bm-draw": `${drawDuration}ms`,
          "--bm-fold": `${foldDuration}ms`,
        } as React.CSSProperties
      }
    >
      <span ref={markerRef} className="branched-menu__marker" aria-hidden="true" />
      {items.map((item, i) => {
        const kids = item.children;
        const isOpen = kids ? open.has(i) : false;
        const leafValue = item.value ?? item.label;
        const leafActive = !kids && leafValue === active;
        const bodyH = kids ? PAD * 2 + kids.length * rowHeight : 0;
        return (
          <div
            key={item.value ?? item.label}
            className="branched-menu__section"
            data-open={isOpen ? "" : undefined}
          >
            <button
              ref={(el) => {
                heads.current[i] = el;
              }}
              type="button"
              className="branched-menu__head"
              aria-expanded={kids ? isOpen : undefined}
              aria-current={leafActive ? "true" : undefined}
              data-active={leafActive ? "" : undefined}
              title={item.title}
              onClick={() => {
                if (!kids) {
                  select(leafValue, item);
                  return;
                }
                // A header with children toggles the branch AND, when it
                // carries a value, selects it. Toggling alone meant a project
                // row (which ALWAYS has children — the "No threads yet"
                // placeholder at minimum) could never fire onSelect, so
                // clicking a project never reopened its workspace.
                // `item.value` is undefined for pure GROUP headers (Agents,
                // Settings) — those must keep toggling only, or the consumer
                // would navigate to a route named after the label.
                toggle(i);
                if (item.value !== undefined) select(leafValue, item);
              }}
              onContextMenu={
                onHeadContextMenu
                  ? (e) => {
                      e.preventDefault();
                      onHeadContextMenu(i, { x: e.clientX, y: e.clientY });
                    }
                  : undefined
              }
              onTouchStart={(e) => headTouchStart(i, e)}
              onTouchMove={headTouchMove}
              onTouchEnd={headTouchEnd}
            >
              {item.icon ? (
                <span className="branched-menu__icon branched-menu__head-icon" aria-hidden="true">
                  {item.icon}
                </span>
              ) : null}
              <span className="branched-menu__label branched-menu__head-label">{item.label}</span>
              {item.badge ? <span className="branched-menu__badge branched-menu__head-badge">{item.badge}</span> : null}
            </button>
            {kids ? (
              <div className="branched-menu__body">
                <div className="branched-menu__fold">
                  <div className="branched-menu__tree" style={{ height: bodyH }}>
                    <svg
                      className="branched-menu__lines"
                      width={indent}
                      height={bodyH}
                      aria-hidden="true"
                    >
                      <path
                        className="branched-menu__base"
                        d={`M ${trunk} 0 V ${rowY(kids.length - 1) - r}`}
                      />
                      {kids.map((kid, k) => (
                        <path key={kid.value} className="branched-menu__base" d={branch(k)} />
                      ))}
                      {kids.map((kid, k) => (
                        <path
                          key={kid.value}
                          className="branched-menu__reach"
                          d={reach(k)}
                          style={{
                            strokeDasharray: length(k),
                            strokeDashoffset: kid.value === active ? 0 : length(k),
                          }}
                        />
                      ))}
                    </svg>
                    {kids.map((kid) => (
                      <button
                        key={kid.value}
                        type="button"
                        className="branched-menu__item"
                        aria-current={kid.value === active ? "true" : undefined}
                        data-active={kid.value === active ? "" : undefined}
                        title={kid.title}
                        tabIndex={isOpen ? 0 : -1}
                        onClick={() => select(kid.value, kid)}
                      >
                        {kid.icon ? (
                          <span className="branched-menu__icon" aria-hidden="true">
                            {kid.icon}
                          </span>
                        ) : null}
                        <span className="branched-menu__label">{kid.label}</span>
                        {kid.badge ? <span className="branched-menu__badge">{kid.badge}</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

/** Icon helper for callers that pass Material Symbols by name. */
export function MsIcon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <span className="ms" style={{ fontSize: size }} aria-hidden="true">
      {name}
    </span>
  );
}
