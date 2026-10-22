"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

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
 * Accessible-ish dropdown: opens on click, closes on outside click / Escape.
 * Renders the trigger and an absolutely-positioned panel.
 */
export function Popover({ label, tooltip, align = "left", width, active, className, title, children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={tooltip}
        onClick={() => setOpen((p) => !p)}
        className={`${className ?? "icon-btn h-7 w-7 text-xs"} tooltip-trigger`}
        data-active={active ?? open}
      >
        {label}
      </button>
      {open && (
        <div
          className="popover"
          role="menu"
          style={{ [align]: 0, top: "calc(100% + 5px)", width: width ? `${width}px` : undefined } as React.CSSProperties}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
