"use client";

/**
 * Strip.tsx — the 44px top strip (spec §2.2): lead (history arrows, bell,
 * Code/Chat toggle), conversation tabs of the active project (+), right-panel
 * tabs in the rzone (+ opens the closed-tab list), and Electron window
 * controls. The whole strip is a window drag region; interactive children are
 * no-drag. Double-clicking empty strip space toggles maximize.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useConversations } from "@/components/ConversationProvider";
import { useFileSystemContext } from "@/components/FileSystemProvider";
import { forkConversation, isLocalConversationMode } from "@/lib/conversations-transport";
import { announceConversationOpen } from "@/lib/navigation-events";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useShell } from "./ShellContext";
import { useRightPanel } from "./RightPanelContext";
import { BellButton, NotifToasts } from "./NotificationsPopover";
import { useNotificationCenter } from "./useNotificationCenter";
import { WindowControls } from "./WindowControls";
import {
  NEW_TAB_ID,
  loadOpenTabs,
  saveOpenTabs,
  withTabOpen,
  withTabClosed,
} from "@/lib/conversation-tabs";
import { TAB_META, closedTabs, type TabId } from "@/lib/panel-state";
import { useToast } from "@/components/Toast";

/* ---------- whole-pixel tab widths ---------- */
/**
 * Flexbox splits a row fractionally (a 96.4px tab), which lands the tab's 1px
 * borders — and therefore the flare curves — on half pixels; at 125%/150%
 * Windows scaling that renders as a blurred sliver. Instead the row is measured
 * once per layout and every tab is given an INTEGER width inside the same
 * bounds the CSS expresses with flex (96–160, 120 floor for the active tab).
 */
function useSnappedTabWidths(
  ref: React.RefObject<HTMLElement | null>,
  bounds: { min: number; max: number; activeMin: number; reserved: number },
  dep: unknown,
) {
  const { min, max, activeMin, reserved } = bounds;

  const snap = useCallback(() => {
    const box = ref.current;
    if (!box) return;
    const tabs = [...box.querySelectorAll<HTMLElement>(":scope > .ox-tab")];
    if (tabs.length === 0) return;
    const avail = Math.floor(box.clientWidth - reserved);
    const per = Math.max(min, Math.min(max, Math.floor(avail / tabs.length)));
    for (const tab of tabs) {
      const want = tab.classList.contains("on") ? Math.max(per, activeMin) : per;
      const px = `${want}px`;
      if (tab.style.width !== px) tab.style.width = px;
      if (tab.style.flex !== "0 0 auto") tab.style.flex = "0 0 auto";
    }
  }, [ref, min, max, activeMin, reserved]);

  useEffect(() => {
    snap();
    const box = ref.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(snap);
    ro.observe(box);
    return () => ro.disconnect();
  }, [snap, dep, ref]);
}

/* ---------- flush side (tab sitting on a pane's own side edge) ---------- */
/**
 * Which side of the pane the ACTIVE TAB actually touches, measured rather than
 * assumed: under 24px from the pane's outer edge means the tab's concave flare
 * would be drawn on the pane's own rounded corner — two curves fighting in the
 * same pixels. Re-measured on resize, on scroll and after the tab list settles
 * (the row is laid out a couple of frames later).
 * It also publishes --hairline: the used 1px stroke width (0.667px at 150%
 * Windows scaling), which the flare CSS needs to land on the pane's border row.
 */
function useFlushSide(
  activeSelector: string,
  paneSelector: string,
  deps: unknown[],
): "left" | "right" | null {
  const [side, setSide] = useState<"left" | "right" | null>(null);

  useEffect(() => {
    const compute = () => {
      const pane = document.querySelector<HTMLElement>(paneSelector);
      if (!pane) return;
      const hairline = getComputedStyle(pane).borderTopWidth;
      if (hairline) document.documentElement.style.setProperty("--hairline", hairline);
      const tab = document.querySelector<HTMLElement>(activeSelector);
      if (!tab) {
        setSide((prev) => (prev === null ? prev : null));
        return;
      }
      const t = tab.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      const fromLeft = t.left - p.left;
      const fromRight = p.right - t.right;
      const next: "left" | "right" | null =
        Math.abs(fromLeft) <= 1 ? "left" : Math.abs(fromRight) <= 1 ? "right" : null;
      setSide((prev) => (prev === next ? prev : next));
    };

    compute();
    // The tab's box settles a couple of async layout layers later (widths are
    // assigned by the width pass, tabs come from a persisted store).
    const timers = [16, 64, 200].map((ms) => setTimeout(compute, ms));
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(compute) : null;
    const pane = document.querySelector<HTMLElement>(paneSelector);
    if (ro && pane) ro.observe(pane);
    const list = document.querySelector<HTMLElement>(".ox-tabs-scroll");
    list?.addEventListener("scroll", compute, { passive: true });
    window.addEventListener("resize", compute);
    return () => {
      for (const timer of timers) clearTimeout(timer);
      ro?.disconnect();
      list?.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSelector, paneSelector, ...deps]);

  return side;
}

/* ---------- horizontal tab scroller ---------- */
/**
 * TabScroller — the conversation tab row.
 *
 * Layout contract: this element is the TAB AREA. It may never paint outside
 * itself and never slides under the window-control notch, so it is
 * `overflow: hidden` and the notch is a sibling grid column (not an overlay).
 * Inside: a scrollable list (flex:1, min-width:0) then the `+` button
 * (flex:none), which therefore cannot be pushed out of view.
 *
 * Behaviour: tabs shrink to 96px before the list scrolls, the active tab is
 * kept in view on selection, on a new tab and on resize, the list fades at the
 * edge that still has content, and a vertical wheel scrolls it sideways.
 */
function TabScroller({
  label,
  children,
  action,
  activeKey,
  count,
}: {
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  activeKey?: string | null;
  count: number;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  // The tab count drives the width pass: it changes when a tab is added or
  // removed, which is exactly when the row has to be re-divided.
  const childCount = count;
  // 96–160px, 120 floor for the active tab; 12px is the list's end padding.
  useSnappedTabWidths(scrollerRef, { min: 96, max: 160, activeMin: 120, reserved: 12 }, childCount);

  const measure = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const max = sc.scrollWidth - sc.clientWidth;
    const left = sc.scrollLeft > 1;
    const right = max > 1 && sc.scrollLeft < max - 1;
    setFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  /** Put the active tab fully inside the visible window of the list. */
  const revealActive = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const el = sc.querySelector<HTMLElement>(".ox-tab.on");
    if (!el) return;
    // 12px of breathing room matches the list's horizontal padding, which is
    // also where the active tab's flares live.
    const pad = 12;
    const leftEdge = el.offsetLeft - pad;
    const rightEdge = el.offsetLeft + el.offsetWidth + pad;
    const viewLeft = sc.scrollLeft;
    const viewRight = sc.scrollLeft + sc.clientWidth;
    if (leftEdge < viewLeft) {
      // `scrollTo({ behavior: "smooth" })` never advances in this renderer, so
      // the position is assigned directly — it always lands, no animation. It is
      // ROUNDED because a fractional scrollLeft puts every tab's 1px borders on
      // a half pixel, which blurs the flare curves at 125%/150% scaling.
      sc.scrollLeft = Math.round(Math.max(0, leftEdge));
    } else if (rightEdge > viewRight) {
      sc.scrollLeft = Math.round(Math.min(sc.scrollWidth - sc.clientWidth, rightEdge - sc.clientWidth));
    }
    // The arithmetic above can run against a box that is one render behind (a
    // tab's width depends on whether it is active), so ask the browser to do the
    // same job on the real layout when it disagrees. `nearest` on both axes only
    // ever moves this list — never the page — and the shell itself does not
    // scroll. Its result is re-snapped to a whole pixel for the same reason.
    const list = sc.getBoundingClientRect();
    const tab = el.getBoundingClientRect();
    if (tab.left < list.left + pad || tab.right > list.right - pad) {
      el.scrollIntoView({ inline: "nearest", block: "nearest" });
      const snapped = Math.round(sc.scrollLeft);
      if (snapped !== sc.scrollLeft) sc.scrollLeft = snapped;
    }
    measure();
  }, [measure]);

  /**
   * Reveal now, then again after the next layout. Two passes are needed because
   * a tab's width depends on whether it is active (120px floor vs 96px), so the
   * first measurement can be stale and leave the active tab over the clip edge.
   * The second pass is a timer, NOT requestAnimationFrame: rAF never fires while
   * the window is hidden (minimised, on another desktop, before the first
   * paint), and the row must still be on the right tab when it appears.
   */
  const revealTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const schedule = useCallback(() => {
    revealActive();
    for (const t of revealTimers.current) clearTimeout(t);
    // A tab's box can settle a couple of layers of async state later (the tab
    // list itself comes from a persisted store), so correct the position a few
    // times instead of trusting one measurement that may have been stale.
    revealTimers.current = [16, 64, 200].map((ms) => setTimeout(revealActive, ms));
  }, [revealActive]);

  useEffect(() => () => { for (const t of revealTimers.current) clearTimeout(t); }, []);

  // Active tab changed, or tabs were added/removed → reveal it.
  useEffect(() => {
    schedule();
  }, [activeKey, childCount, schedule]);

  // Anything that resizes or re-orders the row reveals again: the list box (a
  // pane/window width change), the row's own DOM (a tab appended at the end, or
  // the active class moving to another tab), and the window itself. React
  // identity alone misses the last two when the active key and the count both
  // stay the same.
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(sc);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mo?.observe(sc, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [schedule]);

  // Vertical wheel over the strip moves it sideways; horizontal deltas keep
  // their native behaviour. Non-passive so the page under it does not scroll.
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (sc.scrollWidth <= sc.clientWidth) return;
      e.preventDefault();
      sc.scrollLeft = Math.round(sc.scrollLeft + e.deltaY);
      measure();
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, [measure]);

  // At rest the list must sit on a whole pixel: a fractional scrollLeft offsets
  // every tab horizontally, so its 1px borders straddle half a device pixel and
  // the flare curves come out blurred. Snapping mid-gesture would judder, so it
  // is done once, shortly after the last scroll event.
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        const snapped = Math.round(sc.scrollLeft);
        if (Math.abs(snapped - sc.scrollLeft) > 0.02) sc.scrollLeft = snapped;
      }, 140);
    };
    sc.addEventListener("scroll", settle, { passive: true });
    return () => {
      sc.removeEventListener("scroll", settle);
      if (t) clearTimeout(t);
    };
  }, []);

  return (
    <div className="ox-tabs">
      <div
        className="ox-tabs-scroll"
        role="tablist"
        aria-label={label}
        ref={scrollerRef}
        onScroll={measure}
        data-fade-left={fade.left ? "1" : undefined}
        data-fade-right={fade.right ? "1" : undefined}
      >
        {children}
      </div>
      {action}
    </div>
  );
}

/* ---------- history arrows ---------- */
function HistoryArrows() {
  const router = useRouter();
  const pathname = usePathname();
  // Tracker: our own navigation increments depth; Back/Forward move the
  // index. Disabled states follow the index honestly.
  const depth = useRef(0);
  const index = useRef(0);
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);
  const moving = useRef<null | "back" | "fwd">(null);

  useEffect(() => {
    if (moving.current === "back") {
      index.current = Math.max(0, index.current - 1);
    } else if (moving.current === "fwd") {
      index.current = Math.min(depth.current, index.current + 1);
    } else {
      // A push (new entry) truncates any forward history.
      depth.current = index.current + 1;
      index.current = depth.current;
    }
    moving.current = null;
    setCanBack(index.current > 1);
    setCanFwd(index.current < depth.current);
  }, [pathname]);

  const go = (dir: "back" | "fwd") => {
    moving.current = dir;
    router[dir === "back" ? "back" : "forward"]();
  };

  return (
    <div className="ox-nav">
      <button aria-label="Back" disabled={!canBack} onClick={() => go("back")}><Icon name="back" size={15} /></button>
      <button aria-label="Forward" disabled={!canFwd} onClick={() => go("fwd")}><Icon name="fwd" size={15} /></button>
    </div>
  );
}

/* ---------- Code / Chat segmented toggle (Decision D2) ---------- */
function SurfaceToggle() {
  const { surfaceMode, setSurfaceMode } = useShell();
  return (
    <div className="ox-seg" role="group" aria-label="Surface mode">
      <button className={surfaceMode === "code" ? "on" : ""} aria-pressed={surfaceMode === "code"} onClick={() => setSurfaceMode("code")}>Code</button>
      <button className={surfaceMode === "chat" ? "on" : ""} aria-pressed={surfaceMode === "chat"} onClick={() => setSurfaceMode("chat")}>Chat</button>
    </div>
  );
}

/* ---------- conversation tabs ---------- */
interface ConvTabMenu { id: string; x: number; y: number }

function ConversationTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const { conversations } = useConversations();
  const { directoryName } = useFileSystemContext();
  const { toast } = useToast();
  const { setMobileSideOpen } = useShell();
  const [tabs, setTabs] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ConvTabMenu | null>(null);
  const projRef = useRef<string>("");

  // Active chat follows the ?c= query (same contract as Sidebar).
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

  // Which project's strip is this? The open conversation's workspace, else
  // the attached folder, else ungrouped.
  const projectId = useMemo(() => {
    const conv = activeId ? conversations.find((c) => c.id === activeId) : undefined;
    return conv?.workspaceName || directoryName || "default";
  }, [activeId, conversations, directoryName]);

  // Load this project's open-tab list on project change.
  useEffect(() => {
    if (projRef.current === projectId) return;
    projRef.current = projectId;
    setTabs(loadOpenTabs(projectId));
  }, [projectId]);

  // Keep active/unsaved-new tabs present; persist.
  useEffect(() => {
    setTabs((prev) => {
      let next = prev;
      if (activeId) next = withTabOpen(next, activeId);
      // An unsaved "New chat" tab only lives while the user is actually on a
      // fresh chat; it yields once a real conversation is active.
      if (activeId && next.includes(NEW_TAB_ID)) next = next.filter((t) => t !== NEW_TAB_ID);
      if (next !== prev) {
        saveOpenTabs(projectId, next);
        return next;
      }
      return prev;
    });
  }, [activeId, projectId]);

  const persist = useCallback((next: string[]) => {
    setTabs(next);
    saveOpenTabs(projectId, next);
  }, [projectId]);

  const titleFor = useCallback((id: string): string => {
    if (id === NEW_TAB_ID) return "New chat";
    return conversations.find((c) => c.id === id)?.title ?? "Chat";
  }, [conversations]);

  const openTab = useCallback((id: string) => {
    if (id === NEW_TAB_ID) {
      router.push("/");
      return;
    }
    router.push(`/?c=${encodeURIComponent(id)}`);
    announceConversationOpen(id);
  }, [router]);

  const closeTab = useCallback((id: string) => {
    const { list, nextActive } = withTabClosed(tabs, activeId, id);
    persist(list);
    if (nextActive === activeId) return;
    if (nextActive && nextActive !== NEW_TAB_ID) {
      router.push(`/?c=${encodeURIComponent(nextActive)}`);
      announceConversationOpen(nextActive);
    } else if (nextActive === NEW_TAB_ID) {
      router.push("/");
    } else {
      router.push("/");
    }
  }, [tabs, activeId, persist, router]);

  const newChat = useCallback(() => {
    persist(withTabOpen(tabs, NEW_TAB_ID));
    router.push("/");
    setMobileSideOpen(false);
  }, [tabs, persist, router, setMobileSideOpen]);

  const forkFromMenu = useCallback(async (id: string) => {
    setMenu(null);
    try {
      const result = await forkConversation(id);
      if (!result) {
        toast("Fork failed — the thread may have been deleted.", "error");
        return;
      }
      toast(`Forked — ${result.copied} message${result.copied === 1 ? "" : "s"} copied.`, "success");
      router.push(`/?c=${result.conversationId}`);
      announceConversationOpen(result.conversationId);
    } catch {
      toast("Fork failed — please try again.", "error");
    }
  }, [router, toast]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("orplex:close-popovers", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("orplex:close-popovers", close);
    };
  }, [menu]);

  // Which pane side the active tab touches, measured from the live layout.
  const flush = useFlushSide(
    ".ox-tabs:not(.ox-tabs-rp) .ox-tab.on",
    ".ox-center",
    [activeId, tabs.length],
  );

  const canFork = isLocalConversationMode();
  const menuConv = menu ? conversations.find((c) => c.id === menu.id) : undefined;

  return (
    <>
      <TabScroller
        label="Conversation tabs"
        activeKey={activeId}
        count={tabs.length}
        action={(
          <button className="ox-add" aria-label="New conversation" title="New chat" onClick={newChat}>
            <Icon name="plus" size={15} />
          </button>
        )}
      >
        {tabs.map((id, index) => {
          const active = id === activeId || (id === NEW_TAB_ID && !activeId && pathname === "/");
          const title = titleFor(id);
          return (
            <div
              key={id}
              className={`ox-tab ${active ? "on" : ""}`}
              role="tab"
              aria-selected={active}
              title={title}
              data-flush={
                active && index === 0 && flush === "left"
                  ? "left"
                  : active && index === tabs.length - 1 && flush === "right"
                    ? "right"
                    : undefined
              }
              onClick={(e) => { if (!(e.target as HTMLElement).closest(".ox-tx")) openTab(id); }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ id, x: e.clientX, y: e.clientY }); }}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } }}
            >
              <Icon name="branch" size={14} />
              <span>{title}</span>
              {/* The pane-border patch is a real element because both of the
                  tab's pseudo-elements are the concave flares. */}
              {active && <span className="ox-patch" aria-hidden="true" />}
              <button
                className="ox-tx"
                aria-label={`Close ${title}`}
                title={`Close ${title}`}
                onClick={(e) => { e.stopPropagation(); closeTab(id); }}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          );
        })}
      </TabScroller>
      {menu && (
        <div className="ox-tabmenu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: menu.y + 4 }} role="menu">
          <button role="menuitem" onClick={() => openTab(menu.id)}>
            <Icon name="chev" size={13} /> Switch to tab
          </button>
          <button role="menuitem" disabled={!canFork || !menuConv}
            title={canFork ? undefined : "Fork is available in the desktop app"}
            onClick={() => void forkFromMenu(menu.id)}>
            <Icon name="branch" size={13} /> Fork chat
          </button>
          <button role="menuitem" onClick={() => { setMenu(null); closeTab(menu.id); }}>
            <Icon name="x" size={13} /> Close tab
          </button>
        </div>
      )}
    </>
  );
}

/* ---------- right-panel tabs in the rzone ---------- */
const TAB_ICONS: Record<TabId, IconName> = {
  queue: "tasks",
  changes: "branch",
  browser: "laptop",
  terminal: "term",
  files: "folder",
  scratch: "edit" as IconName,
};

function RightPanelTabs() {
  const rp = useRightPanel();
  const { setOverlayOpen } = rp;
  const [popOpen, setPopOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  // 74–140px, 110 floor for the active tab; 34px is the "+" button plus its
  // margins, which shares this row.
  useSnappedTabWidths(rowRef, { min: 74, max: 140, activeMin: 110, reserved: 34 }, rp.tabs.length);
  const flush = useFlushSide(
    ".ox-tabs-rp .ox-tab.on",
    ".ox-shell .ox-rpanel > .right-panel",
    [rp.activeTab, rp.tabs.length, rp.isOpen],
  );

  // Popovers over the browser view freeze its native snapshot (same contract
  // the old in-panel TabBar used via onPopoverChange).
  useEffect(() => {
    setOverlayOpen(popOpen);
    return () => setOverlayOpen(false);
  }, [popOpen, setOverlayOpen]);

  useEffect(() => {
    if (!popOpen) return;
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      const pop = document.querySelector(".ox-rpop");
      if (pop?.contains(e.target as Node)) return;
      setPopOpen(false);
    };
    const close = () => setPopOpen(false);
    document.addEventListener("mousedown", onDown, { passive: true });
    window.addEventListener("orplex:close-popovers", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("orplex:close-popovers", close);
    };
  }, [popOpen]);

  const closed = closedTabs(rp.tabs);

  // Closing the panel's only tab means closing the panel: an open pane with no
  // tabs in it has nothing to show, and the group's "x" is the panel's close.
  const closePanelTab = (id: TabId) => {
    const wasLast = rp.isOpen && rp.tabs.length <= 1;
    rp.close(id);
    if (wasLast) rp.toggle();
  };

  return (
    <>
      <div ref={rowRef} className="ox-tabs ox-tabs-rp" role="tablist" aria-label="Right panel tabs">
      {rp.tabs.map((id, index) => {
        const active = id === rp.activeTab;
        const meta = TAB_META[id];
        return (
          <div
            key={id}
            className={`ox-tab ${active ? "on" : ""}`}
            role="tab"
            aria-selected={active}
            title={meta.label}
            data-flush={
              active && index === 0 && flush === "left"
                ? "left"
                : active && index === rp.tabs.length - 1 && flush === "right"
                  ? "right"
                  : undefined
            }
            onClick={() => rp.activate(id)}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); rp.close(id); } }}
          >
            <Icon name={TAB_ICONS[id] ?? "tasks"} size={14} />
            <span>{meta.label}</span>
            {active && <span className="ox-patch" aria-hidden="true" />}
            <button className="ox-tx" aria-label={`Close ${meta.label} tab`} onClick={(e) => { e.stopPropagation(); closePanelTab(id); }}>
              <Icon name="x" size={11} />
            </button>
          </div>
        );
      })}
      <button
        ref={btnRef}
        className="ox-add"
        aria-label="New panel tab"
        aria-haspopup="menu"
        aria-expanded={popOpen}
        title="Open a tab"
        onClick={() => setPopOpen((v) => !v)}
      >
        <Icon name="plus" size={15} />
      </button>
      {popOpen && (
        <div
          className="ox-rpop"
          style={{ left: Math.max(8, (btnRef.current?.getBoundingClientRect().left ?? 0) - 130), top: (btnRef.current?.getBoundingClientRect().bottom ?? 44) + 6 }}
          role="menu"
        >
          {closed.length === 0 ? (
            <div className="ox-rpop-none">All tabs are open</div>
          ) : (
            closed.map((id) => (
              <button key={id} role="menuitem" onClick={() => { rp.open(id); setPopOpen(false); }}>
                <Icon name={TAB_ICONS[id] ?? "tasks"} size={14} />
                {TAB_META[id].label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
    </>
  );
}
/* ---------- the strip ---------- */
export default function Strip() {
  const { sidebarCollapsed } = useShell();
  // ONE notification poller for the whole shell: bell + toast stack consume it.
  const notif = useNotificationCenter();

  // Double-clicking empty strip space toggles maximize, like a real title bar.
  // Drag regions do not forward double-clicks reliably in a frameless window,
  // and any tab/button must keep its own click behaviour.
  const onStripDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    if (el.closest("button, .ox-tab, input, a")) return;
    const win = (window as unknown as { orplexDesktop?: { window?: { toggleMaximize?: () => void } } }).orplexDesktop?.window;
    win?.toggleMaximize?.();
  };

  return (
    <>
      <header className="ox-strip" data-tour-id="strip" onDoubleClick={onStripDoubleClick}>
        <div className="ox-lead">
          <HistoryArrows />
          {!sidebarCollapsed && (
            <div className="ox-lead-r">
              <BellButton notif={notif} />
              <SurfaceToggle />
            </div>
          )}
        </div>
        <div className="ox-tabs-zone">
          <ConversationTabs />
          <RightPanelTabs />
        </div>
        <WindowControls />
      </header>
      <NotifToasts notif={notif} />
    </>
  );
}
