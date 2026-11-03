"use client";

import { useCallback, useEffect, useRef } from "react";

interface ResizeHandleProps {
  orientation: "vertical" | "horizontal";
  /** Reads the current size at drag start (width for vertical, height for horizontal). */
  getSize: () => number;
  /** Applies the new size (already clamped is the caller's job). */
  onResize: (size: number) => void;
  ariaLabel: string;
  /** For a panel pinned to the right/bottom edge: dragging towards the edge
   *  grows it, so the pointer delta is subtracted instead of added. */
  invert?: boolean;
}

/**
 * Pointer-driven resize handle. No external deps; uses pointer capture so the
 * drag keeps tracking even when the pointer leaves the handle.
 */
export function ResizeHandle({ orientation, getSize, onResize, ariaLabel, invert = false }: ResizeHandleProps) {
  const start = useRef<{ pos: number; size: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    start.current = { pos: orientation === "vertical" ? e.clientX : e.clientY, size: getSize() };
    document.body.style.cursor = orientation === "vertical" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }, [orientation, getSize]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const pos = orientation === "vertical" ? e.clientX : e.clientY;
    const delta = pos - start.current.pos;
    onResize(start.current.size + (invert ? -delta : delta));
  }, [orientation, onResize, invert]);

  const end = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    start.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => () => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const cls = orientation === "vertical" ? "resize-handle w-1 flex-shrink-0 cursor-col-resize" : "resize-handle h-1 flex-shrink-0 cursor-row-resize";
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      className={cls}
      style={{ background: "var(--border)" }}
    />
  );
}
