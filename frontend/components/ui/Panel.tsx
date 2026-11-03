"use client";

import type { ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons/ToolIcons";

interface PanelProps {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
  className?: string;
  /** When provided, renders a collapse chevron in the header. */
  onCollapse?: () => void;
  collapsed?: boolean;
  onExpand?: () => void;
  /** Which edge the panel slides into. Defaults to "left" (the watchlist);
   *  "right" flips the chevrons so a collapse arrow always points the way the
   *  panel actually goes. */
  side?: "left" | "right";
}

/**
 * Standard panel chrome: uppercase header with optional actions, a subtle
 * border, and a full-height scroll body. Kept intentionally small so every
 * side panel looks identical.
 */
export function Panel({ title, right, children, bodyClassName = "", className = "", onCollapse, collapsed, onExpand, side = "left" }: PanelProps) {
  const CollapseChevron = side === "left" ? ChevronLeftIcon : ChevronRightIcon;
  const ExpandChevron = side === "left" ? ChevronRightIcon : ChevronLeftIcon;

  if (collapsed) {
    return (
      <div className={`flex h-full flex-col items-center ${className}`} style={{ background: "var(--bg-panel)" }}>
        <button
          type="button"
          onClick={onExpand}
          title={`Expand ${title}`}
          className="icon-btn mt-1 h-7 w-7"
        >
          <ExpandChevron size={14} />
        </button>
        <div className="mt-2 select-none text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)", writingMode: "vertical-rl" }}>
          {title}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`} style={{ background: "var(--bg-panel)" }}>
      <div className="flex flex-shrink-0 items-center justify-between border-b" style={{ borderColor: "var(--border)" }}>
        <div className="panel-header">{title}</div>
        <div className="flex items-center gap-0.5 pr-1">
          {right}
          {onCollapse && (
            <button type="button" onClick={onCollapse} title={`Collapse ${title}`} className="icon-btn h-6 w-6">
              <CollapseChevron size={14} />
            </button>
          )}
        </div>
      </div>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </div>
  );
}
