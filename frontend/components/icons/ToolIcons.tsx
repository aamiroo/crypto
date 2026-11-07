"use client";

/**
 * Line icons for the chart tools and the drawing list. They are inline SVG (not
 * font glyphs) because the previous text symbols (─ │ ╱ ϝ ⇔) were unreadable at
 * 13px and made every tool look the same.
 *
 * The drawing tools below follow three rules, so the rail can be read without
 * the tooltip:
 *  - a filled dot is an anchor, i.e. a click the tool expects;
 *  - a dashed wing is where the shape continues on its own, beyond the anchors;
 *  - a filled band is where the shape encloses a zone (a channel, P/L).
 * Strokes are 1.4 on a 16 grid; anything decorative is at lower opacity so the
 * geometry, not the ornament, is what stands out at 15px.
 */

import type { ChartTool } from "@/lib/types";
import type { ReactElement } from "react";

interface IconProps { size?: number; className?: string }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

/** A solid, finite segment: 1.4, round ends. */
const seg = (d: string) => <path d={d} />;
/** A dotted continuation of the segment: where the shape extends itself. */
const wing = (d: string, opacity = 0.55) => (
  <path d={d} strokeWidth={1.2} strokeDasharray="1.5 2.2" opacity={opacity} />
);
/** An anchor: the point the user clicks. */
const dot = (cx: number, cy: number, r = 1.5) => (
  <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
);

export function CursorIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M4 3l7.5 4.2-3.1.8-.8 3.1z" />
    </svg>
  );
}

export function HorizontalIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      {seg("M2 8h7.4")}
      {dot(2.4, 8, 1.4)}
      <rect x="9.6" y="5.4" width="4.6" height="5.2" rx="1.3" strokeWidth={1.2} />
      <path d="M11 8h2.2" strokeWidth={1.2} opacity={0.7} />
    </svg>
  );
}

export function VerticalIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      {seg("M8 2v7.4")}
      {dot(8, 2.4, 1.4)}
      <rect x="5.2" y="9.6" width="5.6" height="4.4" rx="1.3" strokeWidth={1.2} />
      <path d="M6.8 11.8h2.4" strokeWidth={1.2} opacity={0.7} />
    </svg>
  );
}

export function TrendlineIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      {seg("M3.2 12.4L12.8 3.6")}
      {dot(3.2, 12.4)}
      {dot(12.8, 3.6)}
    </svg>
  );
}

export function RayIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      {seg("M2.6 13L10.2 5.9")}
      {wing("M10.2 5.9L14.2 2.2")}
      {dot(2.6, 13)}
      {dot(10.2, 5.9, 1.2)}
    </svg>
  );
}

export function FibonacciIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M2.4 2.6v11.2" strokeWidth={1.1} opacity={0.35} />
      <path d="M2.4 2.6h11.2" strokeWidth={1.1} opacity={0.4} />
      <path d="M2.4 5.4h11.2" strokeWidth={1.2} opacity={0.7} />
      <path d="M2.4 8.2h11.2" strokeWidth={1.8} />
      <path d="M2.4 11h11.2" strokeWidth={1.2} opacity={0.7} />
      <path d="M2.4 13.8h11.2" strokeWidth={1.1} opacity={0.4} />
    </svg>
  );
}

export function MeasureIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      {wing("M3.2 12.2L12.8 4.4", 0.9)}
      {seg("M1.8 10.5L4.6 13.9")}
      {seg("M11.4 2.7L14.2 6.1")}
      {dot(3.2, 12.2, 1.4)}
      {dot(12.8, 4.4, 1.4)}
    </svg>
  );
}

export function LongPositionIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <rect x="2.2" y="3.4" width="11.6" height="4.6" fill="currentColor" fillOpacity={0.34} stroke="none" />
      <rect x="2.2" y="8" width="11.6" height="4.6" fill="currentColor" fillOpacity={0.09} stroke="none" />
      {seg("M2.2 8h11.6")}
      <path d="M2.2 3.4h11.6M2.2 12.6h11.6" strokeWidth={1.1} strokeDasharray="2 2" opacity={0.75} />
    </svg>
  );
}

export function ShortPositionIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <rect x="2.2" y="8" width="11.6" height="4.6" fill="currentColor" fillOpacity={0.34} stroke="none" />
      <rect x="2.2" y="3.4" width="11.6" height="4.6" fill="currentColor" fillOpacity={0.09} stroke="none" />
      {seg("M2.2 8h11.6")}
      <path d="M2.2 3.4h11.6M2.2 12.6h11.6" strokeWidth={1.1} strokeDasharray="2 2" opacity={0.75} />
    </svg>
  );
}

export function LockIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.8 7V5.2a2.2 2.2 0 014.4 0V7" />
    </svg>
  );
}

export function UnlockIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.8 7V5.2a2.2 2.2 0 014.4-.4" />
    </svg>
  );
}

export function EyeIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M1.5 8s2.4-3.6 6.5-3.6S14.5 8 14.5 8s-2.4 3.6-6.5 3.6S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.5" />
    </svg>
  );
}

export function EyeOffIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M2.6 5.4C1.9 6.2 1.5 8 1.5 8s2.4 3.6 6.5 3.6c1.2 0 2.2-.3 3.1-.8" />
      <path d="M12.2 10.2c1.4-1.2 2.3-2.2 2.3-2.2S12.1 4.4 8 4.4c-.6 0-1.2.1-1.7.2" />
      <path d="M2 2l12 12" />
    </svg>
  );
}

export function TrashIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M2.8 4.2h10.4M6 4.2V2.8h4v1.4M4.2 4.2l.7 9h6.2l.7-9" />
    </svg>
  );
}

export function UndoIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M3 6.5h6.5A3.5 3.5 0 0113 10v0a3.5 3.5 0 01-3.5 3.5H6" />
      <path d="M5.5 3.5L2.8 6.3 5.5 9" />
    </svg>
  );
}

export function RedoIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M13 6.5H6.5A3.5 3.5 0 003 10v0a3.5 3.5 0 003.5 3.5H10" />
      <path d="M10.5 3.5L13.2 6.3 10.5 9" />
    </svg>
  );
}

export function LayersIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M8 2.2l6 3.2-6 3.2-6-3.2z" />
      <path d="M2.6 9.4L8 12.3l5.4-2.9" />
    </svg>
  );
}

/* ---- chrome icons -------------------------------------------------------
   These replaced the last text glyphs (✕ ⌕ ⚙ ⤢ ƒ 🔔 ☀ ☾ ★ ▲ ▼ › ✓). The
   glyphs came from whatever font the OS happened to substitute, so they were
   misaligned, inconsistently weighted, and rendered as boxes on some machines —
   the single loudest source of the "this UI is a mockup" feeling. */

export function CloseIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
    </svg>
  );
}

export function CheckIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M3.2 8.6L6.4 11.8 12.8 4.6" />
    </svg>
  );
}

export function SearchIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2L13.4 13.4" />
    </svg>
  );
}

export function GearIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8l1.1 1.9 2.1-.5.5 2.1 1.9 1.1-1.4 1.6 1.4 1.6-1.9 1.1-.5 2.1-2.1-.5L8 14.2l-1.1-1.9-2.1.5-.5-2.1L2.4 9.6l1.4-1.6L2.4 6.4l1.9-1.1.5-2.1 2.1.5z" />
    </svg>
  );
}

export function ExpandIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4" />
      <path d="M13.5 2.5L9.6 6.4M2.5 13.5l3.9-3.9" />
    </svg>
  );
}

export function CollapseIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4" />
      <path d="M9.5 6.5L6.4 3.4M6.5 9.5l3.1 3.1" />
    </svg>
  );
}

export function IndicatorsIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M2 12.6c1.8 0 1.8-4 3.6-4s1.8 5.4 3.6 5.4S11 3.4 12.8 3.4H14" />
    </svg>
  );
}

export function BellIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M4 10.5V7a4 4 0 018 0v3.5l1 1.5H3z" />
      <path d="M6.6 12.2a1.5 1.5 0 002.8 0" />
    </svg>
  );
}

export function SunIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2L3.5 12.5" />
    </svg>
  );
}

export function MoonIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M13 9.8A5.4 5.4 0 016.2 3a5.4 5.4 0 106.8 6.8z" />
    </svg>
  );
}

export function StarIcon({ size = 16, className, filled = true }: IconProps & { filled?: boolean }) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path
        d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 6.5l4-.6z"
        fill={filled ? "currentColor" : "none"}
      />
    </svg>
  );
}

/** Single caret rotated by the caller: one shape for both sort directions so
 *  the active column can never render a heavier glyph than the inactive one. */
export function ExtendedLineIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      {seg("M5.2 11.4L10.8 5")}
      {wing("M10.8 5L14.2 1.4")}
      {wing("M5.2 11.4L1.8 14.8")}
      {dot(5.2, 11.4)}
      {dot(10.8, 5)}
    </svg>
  );
}

export function ParallelChannelIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M2.2 6.4L13.8 3.2L13.8 9.6L2.2 12.8Z" fill="currentColor" fillOpacity={0.13} stroke="none" />
      {seg("M2.2 6.4L13.8 3.2")}
      {seg("M2.2 12.8L13.8 9.6")}
      <path d="M2.2 9.6L13.8 6.4" strokeWidth={1} strokeDasharray="1.5 2.2" opacity={0.4} />
      {dot(2.2, 12.8, 1.3)}
      {dot(13.8, 9.6, 1.3)}
      {dot(7, 5.05, 1.3)}
    </svg>
  );
}

export function FibExtensionIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M4.6 1.6v12.8" strokeWidth={1.1} opacity={0.3} />
      <path d="M4.6 1.6h9.4" strokeWidth={1.1} strokeDasharray="1.5 2.2" opacity={0.5} />
      <path d="M4.6 4.6h9.4" strokeWidth={1.2} opacity={0.7} />
      <path d="M4.6 7.4h9.4" strokeWidth={1.8} />
      <path d="M4.6 10.2h9.4" strokeWidth={1.2} opacity={0.7} />
      <path d="M4.6 13.4h9.4" strokeWidth={1.1} strokeDasharray="1.5 2.2" opacity={0.5} />
      <path d="M11.6 3L14 1.6l-.3 2.7" strokeWidth={1.1} opacity={0.7} />
    </svg>
  );
}

export function RectangleIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <rect x="2.6" y="4.4" width="10.8" height="7.2" rx="1.2" fill="currentColor" fillOpacity={0.13} />
      {dot(2.6, 4.4, 1.3)}
      {dot(13.4, 11.6, 1.3)}
    </svg>
  );
}

export function CircleIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <circle cx="7.8" cy="8" r="5.6" fill="currentColor" fillOpacity={0.12} />
      {dot(7.8, 8, 1.3)}
      <path d="M7.8 8h5.6" strokeWidth={1.1} strokeDasharray="1.5 2.2" opacity={0.5} />
    </svg>
  );
}

export function TextIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M3.6 4h8.8" strokeWidth={1.7} />
      <path d="M8 4v8.4" />
      <path d="M5.8 12.4h4.4" strokeWidth={1.2} opacity={0.45} />
    </svg>
  );
}

export function ArrowIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      {seg("M2.8 13.2L11.4 5.4")}
      <path d="M13.9 3.1l-3.8.7 2.9 3z" fill="currentColor" stroke="none" />
      {dot(2.8, 13.2, 1.3)}
    </svg>
  );
}

export function PriceLabelIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      {seg("M2.6 8h6")}
      {dot(2.6, 8, 1.4)}
      <rect x="8.8" y="5.2" width="5.4" height="5.6" rx="1.4" fill="currentColor" fillOpacity={0.85} stroke="none" />
      <path d="M10.2 8h2.6" strokeWidth={1.2} stroke="var(--bg-elevated)" opacity={0.9} />
    </svg>
  );
}

export function DuplicateIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <rect x="3" y="4" width="9" height="7" rx="1" />
      <path d="M7 3h6v6" />
    </svg>
  );
}

export function CaretIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M4 10l4-4 4 4" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M6 3.2L10.8 8 6 12.8" />
    </svg>
  );
}

export function ChevronLeftIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M10 3.2L5.2 8 10 12.8" />
    </svg>
  );
}

export function WarningIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M8 2.6l5.8 10.2H2.2z" />
      <path d="M8 6.4v3.1M8 11.3h.01" />
    </svg>
  );
}

export function InfoIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.3v3.5M8 4.9h.01" />
    </svg>
  );
}

export function KeyboardIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <rect x="1.8" y="4" width="12.4" height="8" rx="1.5" />
      <path d="M4.4 6.6h.01M7 6.6h.01M9.6 6.6h.01M12.2 6.6h.01M5.6 9.4h4.8" />
    </svg>
  );
}

/** Wordless brand mark: two candles, so the header says what the app shows
 *  instead of a lettered box that could belong to any product. */
export function LogoIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M5.6 2v2.4M5.6 11.6V14M10.4 2v4.2M10.4 13.4V14" />
      <rect x="3.8" y="4.4" width="3.6" height="7.2" rx="0.8" fill="currentColor" fillOpacity={0.28} />
      <rect x="8.6" y="6.2" width="3.6" height="7.2" rx="0.8" fill="currentColor" fillOpacity={0.28} />
    </svg>
  );
}

/** One glyph per chart tool, so the rail, the flyout and the drawings list all
 *  show the same picture of the same tool. Keyed by id: the tool list in
 *  lib/utils/drawings stays the single source for order, labels and shortcuts. */
export const TOOL_ICON: Record<ChartTool, (p: { size?: number }) => ReactElement> = {
  crosshair: CursorIcon,
  horizontal: HorizontalIcon,
  vertical: VerticalIcon,
  trendline: TrendlineIcon,
  extendedLine: ExtendedLineIcon,
  ray: RayIcon,
  parallelChannel: ParallelChannelIcon,
  fibonacci: FibonacciIcon,
  fibExtension: FibExtensionIcon,
  measure: MeasureIcon,
  rectangle: RectangleIcon,
  circle: CircleIcon,
  text: TextIcon,
  arrow: ArrowIcon,
  priceLabel: PriceLabelIcon,
  longPosition: LongPositionIcon,
  shortPosition: ShortPositionIcon,
};
