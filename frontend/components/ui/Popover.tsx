"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface PopoverProps {
  label: ReactNode;
  tooltip?: string;
  align?: "left" | "right";
  width?: number;
  active?: boolean;
  className?: string;
  title?: string;
  children: (close: () => void) => ReactNode;
}

/**
 * Dropdown that opens on click and closes on outside click / Escape.
 *
 * The panel is portalled to `document.body` and pinned with fixed coordinates:
 * the chart toolbar scrolls horizontally, and `overflow-x: auto` forces
 * `overflow-y` to auto too, which would clip an in-flow panel to the 38px-tall
 * bar — the indicator and settings menus were invisible for that reason.
 */
export function Popover({ label, tooltip, align = "left", width, active, className, title, children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) { setOpen(false); return; }
    const r = el.getBoundingClientRect();
    const w = width ?? 200;
    const left = align === "right" ? r.right - w : r.left;
    setPos({
      left: Math.max(6, Math.min(left, window.innerWidth - w - 6)),
      top: Math.min(r.bottom + 5, Math.max(6, window.innerHeight - 44)),
    });
  }, [open, width, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    // Pinned coordinates go stale as soon as anything moves under the panel.
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={title ?? tooltip}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={tooltip}
        onClick={() => setOpen((p) => !p)}
        className={`${className ?? "icon-btn h-7 w-7 text-xs"} tooltip-trigger`}
        data-active={active ?? open}
      >
        {label}
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          className="popover popover-pinned"
          role="menu"
          style={{ left: pos.left, top: pos.top, width: width ? `${width}px` : undefined }}
        >
          {children(() => setOpen(false))}
        </div>,
        document.body,
      )}
    </>
  );
}
