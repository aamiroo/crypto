"use client";

/**
 * Line icons for the chart tools and the drawing list. They are inline SVG (not
 * font glyphs) because the previous text symbols (─ │ ╱ ϝ ⇔) were unreadable at
 * 13px and made every tool look the same.
 */

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
      <path d="M2 8h12" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function VerticalIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M8 2v12" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TrendlineIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M2.5 13L13.5 3" />
      <circle cx="2.5" cy="13" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="13.5" cy="3" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function RayIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M2.5 12L11 4.5" />
      <path d="M8.6 3.6L12 3l-.5 3.3" />
      <circle cx="2.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function FibonacciIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M2 3.5h12M2 7h12M2 10.5h12M2 14h12" strokeWidth={1.2} />
    </svg>
  );
}

export function MeasureIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M2 8h12" />
      <path d="M4.5 5.5L2 8l2.5 2.5M11.5 5.5L14 8l-2.5 2.5" />
    </svg>
  );
}

export function LongPositionIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M2.5 8h11" />
      <path d="M3 7.6L8 2.6l5 5z" fill="currentColor" fillOpacity={0.35} />
      <path d="M3 8.4L8 13.4l5-5z" fill="currentColor" fillOpacity={0.12} />
    </svg>
  );
}

export function ShortPositionIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M2.5 8h11" />
      <path d="M3 8.4L8 13.4l5-5z" fill="currentColor" fillOpacity={0.35} />
      <path d="M3 7.6L8 2.6l5 5z" fill="currentColor" fillOpacity={0.12} />
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
