/**
 * The drawing visual language.
 *
 * One place defines how every annotation looks: stroke weights, dash grammar,
 * the selection halo, anchor geometry, label chips and fill translucency. The
 * primitive reads these instead of scattering magic numbers, so the language
 * lands everywhere at once and no shape can end up heavier than its neighbour.
 *
 * Two rules keep the set coherent:
 *
 * 1. A shape is drawn in *its own* colour; everything translucent about it (the
 *    fill, the zone bands, the extension of a ray) is that same colour at a
 *    lower alpha. A drawing never introduces a hue of its own.
 * 2. The *interface* around a shape — halo, handles, pending anchors, axis tags —
 *    is drawn from the theme (selection + chart background), never from the
 *    shape's colour. So "you are editing this" always looks the same whatever
 *    colour the user picked, which is what makes the states readable at a glance.
 *
 * Colours are keywords resolved against the live chart palette at paint time, so
 * the default ink follows the theme instead of being a hex that only works on one
 * of the two charts it can be drawn on.
 */

import type { ChartPalette } from "./theme";

/** A colour the renderer resolves at paint time. Anything else is a literal
 *  colour (a hex from the swatch row) and is passed through untouched. */
export type DrawColor =
  | "ink"
  | "up"
  | "down"
  | "text"
  | "muted"
  | "accent"
  | "danger"
  | "labelBg"
  | "labelText"
  | "selection"
  | (string & {});

export function resolveDrawColor(color: DrawColor | null | undefined, p: ChartPalette): string {
  // A drawing with no stored colour — data written before the field existed, or
  // restored from a partial save — must still be visible. Passing `undefined` to
  // the canvas leaves the previous paint style in place, so the shape comes out
  // in whatever colour the last tag used, or not drawn at all.
  if (!color) return p.drawInk;
  switch (color) {
    case "ink": return p.drawInk;
    case "up": return p.up;
    case "down": return p.down;
    case "text": return p.text;
    case "muted": return p.labelText;
    case "accent": return p.accent;
    case "danger": return p.danger;
    case "labelBg": return p.labelBg;
    case "labelText": return p.labelText;
    case "selection": return p.selection;
    default: return color;
  }
}

/** The keyword a new drawing is born with: the shape takes the chart's ink, so
 *  an annotation reads as part of the chart rather than as a coloured sticker. */
export const DEFAULT_INK: DrawColor = "ink";

/* ── strokes ─────────────────────────────────────────────────────────── */

/** Base weight of a drawing at rest, in CSS pixels. */
export const LINE = 1.5;
/** A shape that is hovered is a shade heavier, not a different shape. */
export const LINE_HOVER = 0.4;
/** A selected shape carries the handles, so it earns the clearest step. */
export const LINE_SELECTED = 0.8;
/** Weight of the secondary strokes a tool draws around its main line (the
 *  dashed extension of a ray, the rails of a position, connector ticks). */
export const LINE_SECOND = 1.2;
/** Weight of the boundary of a filled body (rectangle, circle, channel). */
export const LINE_EDGE = 1.3;

/** Stroke weight for a shape in state `s`. A user's own `lineWidth` is the base,
 *  so picking 4px does not stop the selection from reading as selected. */
export function strokeWidth(base: number | undefined, selected: boolean, hovered: boolean): number {
  const w = base ?? LINE;
  return w + (selected ? LINE_SELECTED : hovered ? LINE_HOVER : 0);
}

/* ── dash grammar ────────────────────────────────────────────────────── */

export const DASH_DOTTED = [2, 3];
export const DASH_SHORT = [3, 3];
export const DASH_DASHED = [7, 5];
/** The part of a line that runs to infinity. */
export const DASH_INFINITE = [5, 4];
/** Fib extension levels: further out, so lighter, not louder. */
export const DASH_PROJECTION = [3, 4];

/** Alpha of a secondary stroke — visible as *this continues*, never competing
 *  with the solid segment the user actually anchored. */
export const ALPHA_INFINITE = 0.5;
/** Alpha of a shape being placed (the ghost that follows the cursor). */
export const ALPHA_GHOST = 0.55;
/** Alpha of a locked shape: still legible, unmistakably inert. */
export const ALPHA_LOCKED = 0.72;

/* ── selection halo ──────────────────────────────────────────────────── */

/** Extra width of the soft ring drawn under a selected or hovered shape. Kept
 *  tight: a wide ring on a 1.5px line reads as a highlighter stroke and, on a
 *  multi-line shape like the retracement, drowns the shape it is marking. */
export const HALO_SPREAD = 4;
export const HALO_ALPHA_SELECTED = 0.2;
export const HALO_ALPHA_HOVERED = 0.12;

/* ── anchors and handles ─────────────────────────────────────────────── */

/** Editing handle: a square, TradingView's shape, so it reads as a handle and
 *  not as another point on the curve. */
export const HANDLE_SIZE = 9;
export const HANDLE_RADIUS = 2;
export const HANDLE_BORDER = 1.6;
/** A locked shape keeps its handle but cannot be dragged, so the handle is drawn
 *  hollow instead of filled. */
export const HANDLE_LOCKED_BORDER = 1.2;
/** Radius of the anchor dot of a shape that is only hovered (no handles yet). */
export const ANCHOR_R = 3.2;
/** The dot that marks a click already landed while a tool is mid-placement. */
export const PENDING_R = 3.6;
/** Centre mark of a circle tool — the anchor is the geometry, so it is shown. */
export const CENTER_R = 2.4;

/* ── label chips ─────────────────────────────────────────────────────── */

/** Chip typography: a small ratio/label in medium weight, the value in regular. */
export const TAG_FONT = 10;
export const TAG_FONT_SUB = 9;
export const TAG_LINE = 12;
export const TAG_PAD_X = 5;
export const TAG_PAD_Y = 3;
export const TAG_RADIUS = 4;
/** Gap between a chip and the geometry it describes. */
export const TAG_GAP = 6;
/** Alpha of the chip body: it sits on candles, so it must be solid enough to
 *  read but must not look like a panel pasted over the chart. */
export const TAG_BG_ALPHA = 0.92;
/** Hairline around a chip, in the chip's own colour. */
export const TAG_BORDER_ALPHA = 0.4;

/* ── fills ───────────────────────────────────────────────────────────── */

/** Translucency of a filled body (rectangle, circle, channel, fib box). */
export const FILL_REST = 0.07;
export const FILL_ACTIVE = 0.12;
/** Fib zones: the retracement area is read as a *field*, so each band is tinted
 *  by how close it sits to the middle of the swing. The golden zone (0.382–0.618)
 *  is the densest part of the shape and the outer bands fade out. */
export const FIB_ZONE_MAX = 0.13;
export const FIB_ZONE_MIN = 0.03;
/** Position tool bands: profit and loss have to be separable at a glance, which
 *  a 0.07 fill cannot do over a busy candle field. */
export const POSITION_FILL = 0.16;
export const POSITION_FILL_ACTIVE = 0.22;

/* ── fib level weights ───────────────────────────────────────────────── */

/** The swing anchors (0 and 1) are the shape's frame. */
export const FIB_KEY = 1.25;
/** 0.5 is the half-way line of the swing. */
export const FIB_MID = 1;
/** 0.382 / 0.618 are the golden zone the tool exists to show. */
export const FIB_GOLDEN = 1.1;
/** The remaining retracement levels. */
export const FIB_LEVEL = 0.8;
/** Extensions sit outside the swing and are projections, not measurements. */
export const FIB_EXT = 0.75;
/** Ratios the golden zone is made of. */
export const FIB_GOLDEN_LEVELS = [0.382, 0.618];
/** Ratios drawn as projections by the extension tool. */
export const FIB_EXTENSION_LEVELS = [1.618, 2.618, 4.236];

/* ── snapping ────────────────────────────────────────────────────────── */

/** Device-pixel centre of a straight line, so a 1px stroke lands on one pixel
 *  instead of bleeding across two. `ratio` is the bitmap scale of the pane. */
export function snapAxis(css: number, ratio: number, width: number): number {
  const dev = width * ratio;
  const center = Math.round(css * ratio);
  return (Math.round(dev) % 2 === 1 ? center + 0.5 : center) / ratio;
}
