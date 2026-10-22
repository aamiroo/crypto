"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface VirtualWindow {
  start: number;
  end: number;
  offsetY: number;
  /** Scroll handler to attach to the scrolling container. */
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}

/**
 * Fixed-height windowing for long lists (the watchlist holds every listed
 * pair, not just the visible ~30). Renders `overscan` rows beyond each edge so
 * fast scrolling never shows a blank gap.
 */
export function useVirtualList(count: number, rowHeight: number, overscan = 8): VirtualWindow {
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 60) });
  const frame = useRef<number | null>(null);

  const measure = useCallback((el: HTMLDivElement) => {
    const start = Math.max(0, Math.floor(el.scrollTop / rowHeight) - overscan);
    const visible = Math.ceil(el.clientHeight / rowHeight) + overscan * 2;
    setRange({ start, end: Math.min(count, start + visible) });
  }, [count, rowHeight, overscan]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      measure(el);
    });
  }, [measure]);

  useEffect(() => {
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, []);

  useEffect(() => {
    // Re-clamp when the list shrinks (filtering, tab change).
    setRange((r) => ({
      start: Math.min(r.start, Math.max(0, count - 1)),
      end: Math.min(Math.max(r.end, 1), count),
    }));
  }, [count]);

  return { start: range.start, end: range.end, offsetY: range.start * rowHeight, onScroll };
}
