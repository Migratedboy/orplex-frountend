"use client";

import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";

interface VirtualListProps<T> {
  items: T[];
  /** Estimated item height for initial rendering — actual height is measured after render */
  estimatedHeight?: number;
  overscan?: number;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  onScroll?: (scrollTop: number) => void;
  /** Key extractor for stable item identity */
  getItemKey?: (item: T, index: number) => string | number;
}

/**
 * Variable-height virtual scrolling list.
 * Measures actual item heights after render and caches them.
 * Only renders visible items + overscan buffer.
 * Handles thousands of items without performance degradation.
 */
export function VirtualList<T>({
  items,
  estimatedHeight = 80,
  overscan = 5,
  renderItem,
  className,
  onScroll,
  getItemKey,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  // Cache measured heights — index → measured height
  const heightsRef = useRef<Map<number, number>>(new Map());
  // Cache cumulative offsets — index → top offset
  const offsetsRef = useRef<number[]>([]);

  // Measure container height on mount and resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Build cumulative offsets from measured or estimated heights
  const getOffset = useCallback(
    (index: number): number => {
      if (offsetsRef.current[index] !== undefined) {
        return offsetsRef.current[index];
      }
      // Compute from cache or estimation
      let offset = 0;
      for (let i = 0; i < index; i++) {
        offset += heightsRef.current.get(i) ?? estimatedHeight;
      }
      offsetsRef.current[index] = offset;
      return offset;
    },
    [estimatedHeight]
  );

  // Recompute all offsets (call after height measurement)
  const recomputeOffsets = useCallback(() => {
    const offsets: number[] = [0];
    for (let i = 0; i < items.length; i++) {
      const h = heightsRef.current.get(i) ?? estimatedHeight;
      offsets.push(offsets[i] + h);
    }
    offsetsRef.current = offsets;
  }, [items.length, estimatedHeight]);

  // Measure a rendered item's height.
  //
  // Cache reads are cheap; getBoundingClientRect() is a FORCED synchronous
  // layout, and the inline ref callback below created a new closure every
  // render, so React detached + re-attached it on every commit and every
  // visible row re-measured on every frame (~160 forced reflows/second while
  // streaming). Now the callback is stable per index.
  const measureItem = useCallback(
    (index: number, el: HTMLDivElement | null) => {
      if (!el) return;
      // Cheap guard BEFORE the forced layout: if the cached height is within a
      // pixel of last frame's, skip the measurement entirely.
      const cached = heightsRef.current.get(index);
      if (cached !== undefined && Math.abs(cached - el.offsetHeight) < 1 && el.offsetHeight > 0) return;
      const measured = el.getBoundingClientRect().height;
      if (cached !== measured) {
        heightsRef.current.set(index, measured);
        // Invalidate offsets from this index onward
        offsetsRef.current.length = index;
        recomputeOffsets();
      }
    },
    [recomputeOffsets]
  );

  // One stable ref callback per index, memoised across renders. This is the
  // whole point: an inline arrow is a NEW function every render, so React calls
  // the old ref with null and the new one with the element on EVERY commit.
  const measureRefCache = useRef(new Map<number, (el: HTMLDivElement | null) => void>());
  const measureRef = useCallback(
    (index: number) => {
      const cache = measureRefCache.current;
      let fn = cache.get(index);
      if (!fn) {
        fn = (el: HTMLDivElement | null) => measureItem(index, el);
        cache.set(index, fn);
      }
      return fn;
    },
    [measureItem]
  );
  // Drop cached callbacks for rows that scrolled away so the map cannot grow
  // without bound across a long conversation. (Declared here; the effect that
  // uses it needs startIndex/endIndex, so it lives below their computation.)

  // Recompute on items change
  useEffect(() => {
    recomputeOffsets();
  }, [items.length, recomputeOffsets]);

  const totalHeight = items.length > 0
    ? getOffset(items.length)
    : 0;

  // Find visible range
  let startIndex = 0;
  for (let i = 0; i < items.length; i++) {
    if (getOffset(i) + (heightsRef.current.get(i) ?? estimatedHeight) >= scrollTop) {
      startIndex = Math.max(0, i - overscan);
      break;
    }
  }

  let endIndex = items.length;
  for (let i = startIndex; i < items.length; i++) {
    if (getOffset(i) > scrollTop + containerHeight) {
      endIndex = Math.min(items.length, i + overscan);
      break;
    }
  }

  const visibleItems = items.slice(startIndex, endIndex);

  // Prune the per-index ref cache to the rendered window so it cannot grow
  // without bound across a long conversation.
  useEffect(() => {
    const cache = measureRefCache.current;
    for (const k of Array.from(cache.keys())) {
      if (k < startIndex || k >= endIndex + 1) cache.delete(k);
    }
  }, [startIndex, endIndex]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const top = el.scrollTop;
    setScrollTop(top);
    onScroll?.(top);
  }, [onScroll]);

  // Auto-scroll to bottom when new items are added
  const prevLengthRef = useRef(items.length);
  useEffect(() => {
    const el = containerRef.current;
    if (el && items.length > prevLengthRef.current) {
      // Only auto-scroll if user was near bottom (within 200px)
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
      if (nearBottom) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    }
    prevLengthRef.current = items.length;
  }, [items.length]);

  return (
    <div
      ref={containerRef}
      className={className}
      onScroll={handleScroll}
      style={{ overflow: "auto", position: "relative", height: "100%" }}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {visibleItems.map((item, i) => {
          const actualIndex = startIndex + i;
          const key = getItemKey ? getItemKey(item, actualIndex) : actualIndex;
          const offset = getOffset(actualIndex);
          // Stable per-index ref. An inline arrow made React detach + re-attach
          // the ref on every commit, so every visible row ran a forced layout
          // every frame.
          const setRef = measureRef(actualIndex);
          return (
            <div
              key={key}
              ref={setRef}
              style={{
                position: "absolute",
                top: offset,
                left: 0,
                right: 0,
              }}
            >
              {renderItem(item, actualIndex)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
