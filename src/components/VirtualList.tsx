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

  // Measure a rendered item's height
  const measureItem = useCallback(
    (index: number, el: HTMLDivElement | null) => {
      if (!el) return;
      const measured = el.getBoundingClientRect().height;
      const cached = heightsRef.current.get(index);
      if (cached !== measured) {
        heightsRef.current.set(index, measured);
        // Invalidate offsets from this index onward
        offsetsRef.current.length = index;
        recomputeOffsets();
      }
    },
    [recomputeOffsets]
  );

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
          return (
            <div
              key={key}
              ref={(el) => measureItem(actualIndex, el)}
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
