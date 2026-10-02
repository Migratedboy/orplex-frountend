"use client";

import { useEffect } from "react";

/**
 * ScrollFadeManager — invisible scrollbars companion.
 *
 * Scrollbars are hidden app-wide (globals.css SCROLLBAR section), so panels
 * give no visual hint that more content exists. This component auto-detects
 * scrollable panels and tags them:
 *
 *   data-fade-scroll            — element is a live scroll container
 *   data-fade-top / -bottom     — content is scrolled out of view on that edge
 *
 * CSS (see globals.css "Scroll fade hints") masks the content at those edges —
 * a background-independent fade that works in both themes without color
 * matching. The attributes are pure hints: no layout, no pointer events.
 */
export default function ScrollFadeManager() {
  useEffect(() => {
    const EPS = 2; // px of scroll slack treated as "at the edge"
    const tagged = new Set<HTMLElement>();

    const isCandidate = (el: HTMLElement) => {
      if (el === document.body || el === document.documentElement || !el.isConnected) return false;
      // Cheap size pre-filter: must be tall enough to scroll meaningfully.
      return el.clientHeight > 40 && el.scrollHeight > el.clientHeight + EPS;
    };

    const update = (el: HTMLElement) => {
      const top = el.scrollTop > EPS;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - EPS;
      el.toggleAttribute("data-fade-top", top);
      el.toggleAttribute("data-fade-bottom", bottom);
    };

    const untag = (el: HTMLElement) => {
      el.removeAttribute("data-fade-scroll");
      el.removeAttribute("data-fade-top");
      el.removeAttribute("data-fade-bottom");
      tagged.delete(el);
    };

    const maybeTag = (el: HTMLElement) => {
      if (!isCandidate(el)) return;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return;
      if (!tagged.has(el)) {
        el.setAttribute("data-fade-scroll", "");
        tagged.add(el);
      }
      update(el);
    };

    // Full sweep (mount / resize / safety interval): tag new panels, untag
    // panels that stopped scrolling or were removed.
    const scan = () => {
      for (const el of Array.from(tagged)) {
        if (!el.isConnected || !isCandidate(el)) untag(el);
        else update(el);
      }
      const all = document.querySelectorAll<HTMLElement>("div,section,main,aside,nav,ul,ol,pre,article,textarea");
      for (const el of all) {
        if (!tagged.has(el)) maybeTag(el);
      }
    };

    // Scroll: capture phase catches every element's scroll (scroll does not
    // bubble). Only the scrolled element is touched — O(1) per scroll tick.
    const onScroll = (e: Event) => {
      const el = e.target;
      if (el instanceof HTMLElement && tagged.has(el)) update(el);
    };

    // DOM growth (chat streaming, lists loading): refresh only the affected
    // ancestor chain instead of re-scanning the whole document.
    const queue = new Set<HTMLElement>();
    let moTimer: number | null = null;
    const flushQueue = () => {
      moTimer = null;
      for (const start of queue) {
        let cur: HTMLElement | null = start;
        while (cur && cur !== document.body) {
          if (tagged.has(cur)) update(cur);
          else maybeTag(cur);
          cur = cur.parentElement;
        }
      }
      queue.clear();
    };
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.target instanceof HTMLElement) queue.add(m.target);
        for (const n of m.addedNodes) {
          if (n instanceof HTMLElement) queue.add(n.parentElement ?? n);
        }
      }
      if (queue.size && moTimer === null) moTimer = window.setTimeout(flushQueue, 150);
    });

    // Layout changes (sidebar collapse, mobile→desktop switch) change which
    // panels scroll WITHOUT any DOM mutation — rescan, debounced.
    let resizeTimer: number | null = null;
    const onResize = () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(scan, 150);
    };

    scan();
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    mo.observe(document.body, { childList: true, subtree: true });
    const safety = window.setInterval(scan, 3000); // nets non-DOM growth (images, canvas)

    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      window.removeEventListener("resize", onResize);
      mo.disconnect();
      window.clearTimeout(resizeTimer as unknown as number);
      window.clearTimeout(moTimer as unknown as number);
      window.clearInterval(safety);
      for (const el of Array.from(tagged)) untag(el);
    };
  }, []);

  return null;
}
