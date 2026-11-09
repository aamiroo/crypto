/**
 * Chart annotations drawn *inside* the chart's own canvas, as a lightweight-charts
 * v5 series primitive.
 *
 * This replaces a floating SVG layer, and the difference is exactly what the user
 * notices: the shapes share the chart's coordinate system, font, clipping and
 * redraw cycle, so they cannot lag a frame behind the candles, cannot spill over
 * the price axis, and cannot be styled like a window pasted on top of a chart.
 * Prices and times of the live shapes are handed to the chart's own axis
 * renderer, so a level reads as part of the scale it belongs to.
 *
 * Geometry is resolved into a plain `Shape` description and painted by one
 * generic renderer, which keeps the maths testable and the canvas code short.
 *
 * The look of every shape comes from `drawingStyle.ts`; the colour of every shape
 * comes from the live `ChartPalette`. Nothing here hard-codes a hex.
 */
import type {
  BarPrice,
  Coordinate,
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  Logical,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { Drawing, DrawingPoint, DrawingType } from "@/lib/types";
import { FIB_LEVELS, positionMetrics } from "@/lib/utils/drawings";
import { withAlpha, type ChartPalette } from "./theme";
import * as S from "./drawingStyle";

/** What the primitive may look at. Everything is a getter so the primitive never
 *  holds a stale snapshot of the store. */
export interface DrawingsSource {
  drawings(): Drawing[];
  selectedId(): string | null;
  hoverId(): string | null;
  /** The shape that would be created if the next click landed here. */
  ghost(): Drawing | null;
  /** Anchors placed so far for the shape in progress. */
  pending(): DrawingPoint[];
  /** True while the cursor tool is armed — only then are shapes grabbable. */
  interactive(): boolean;
  palette(): ChartPalette;
  fmtPrice(price: number): string;
  fmtTime(time: number): string;
  /** Duration of one axis slot in seconds; lets anchors live outside the loaded candles. */
  barSeconds(): number;
}

/**
 * Hit ids are read back out of `MouseEventParams.hoveredInfo.objectId` by the
 * pointer controller, so they are a contract between the two files.
 */
export const hitBodyId = (id: string): string => `${id}|body`;
export const hitPointId = (id: string, index: number): string => `${id}|p${index}`;

export function parseHit(objectId: unknown): { id: string; part: "body" | "point"; index: number } | null {
  if (typeof objectId !== "string") return null;
  const sep = objectId.lastIndexOf("|");
  if (sep < 0) return null;
  const id = objectId.slice(0, sep);
  const part = objectId.slice(sep + 1);
  if (!id) return null;
  if (part === "body") return { id, part: "body", index: -1 };
  if (part.startsWith("p")) {
    const index = Number(part.slice(1));
    if (Number.isInteger(index) && index >= 0) return { id, part: "point", index };
  }
  return null;
}

/** A colour the renderer resolves at paint time, so a shape can say "the chart's
 *  ink" and follow the theme instead of carrying a literal hex. */
export type ShapeColor = S.DrawColor;

export function resolveColor(color: ShapeColor, p: ChartPalette): string {
  return S.resolveDrawColor(color, p);
}

export interface ShapeLine {
  x1: number; y1: number; x2: number; y2: number;
  color: ShapeColor;
  width: number;
  dash?: number[];
  alpha?: number;
  /** `false` keeps this stroke out of the selection halo. */
  halo?: boolean;
}
/** Per-stroke overrides inside `buildShape`; omitted fields inherit the
 *  drawing's own colour, width, and dash. */
type StrokeOpts = { color?: ShapeColor; width?: number; dash?: number[]; alpha?: number };
export interface ShapeBand { x: number; y: number; w: number; h: number; color: ShapeColor; alpha: number }
export interface ShapeArc { cx: number; cy: number; r: number; startAngle: number; endAngle: number; color: ShapeColor; width: number; alpha?: number }
export interface ShapeDisc { cx: number; cy: number; r: number; color: ShapeColor; alpha: number }
/** A closed figure (channel body, arrow head): fill only, never a hit area. */
export interface ShapePoly { pts: [number, number][]; color: ShapeColor; alpha: number; edge?: number }
export interface ShapeTag {
  x: number; y: number;
  /** Primary string, in the tag's own colour. */
  text: string;
  /** Secondary string, drawn after it in the theme's muted ink (ratio + price). */
  sub?: string;
  color: ShapeColor;
  align: "left" | "center";
  /** `soft` = chip on the label background, `solid` = chip filled with the
   *  colour itself (a price tag), `none` = bare text. */
  chip?: "soft" | "solid" | "none";
  alpha?: number;
}
/** Bare annotation text, with the chart's own font and a background-coloured
 *  halo so it stays readable over a wall of candles. */
export interface ShapeText { x: number; y: number; text: string; size: number; color: ShapeColor; align: "left" | "center"; alpha?: number }
export type HandleKind = "handle" | "anchor" | "pending" | "center" | "locked";
export interface ShapeDot { x: number; y: number; r: number; kind: HandleKind; color?: ShapeColor; alpha?: number }

/** One annotation, already in CSS pixels relative to the pane's plot area. */
export interface Shape {
  /** Drawing id for a real shape, or a hit id for a synthetic one (a handle). */
  id: string;
  type: DrawingType;
  /** Drives the halo pass: the interface colour of a shape never depends on the
   *  colour the user picked for it. */
  state: "rest" | "hover" | "select";
  lines: ShapeLine[];
  bands: ShapeBand[];
  arcs: ShapeArc[];
  discs: ShapeDisc[];
  polys: ShapePoly[];
  tags: ShapeTag[];
  texts: ShapeText[];
  dots: ShapeDot[];
  /** Grab areas, used by `hitTest`: segments, boxes and points. */
  hit: { lines: [number, number, number, number][]; bands: [number, number, number, number][]; points: [number, number][] };
}

export interface Projector {
  xOf(time: number): number | null;
  yOf(price: number): number | null;
  plotW: number;
  plotH: number;
}

type TimeScaleApi = ReturnType<IChartApi["timeScale"]>;

function numericTime(t: Time): number | null {
  return typeof t === "number" && Number.isFinite(t) ? t : null;
}

/** Axis position of a time, including the empty padding before/after the data.
 *  Inside a capped outage the neighbouring axis points are adjacent although
 *  their timestamps are not, so the fraction is taken across the drawn slot. */
/** Axis position of a time, including the empty padding before/after the data. */
function logicalIndexOfTime(data: readonly { time: Time }[], time: number, barSeconds: number): number | null {
  const n = data.length;
  if (n === 0 || !(barSeconds > 0) || !Number.isFinite(time)) return null;
  const first = numericTime(data[0]!.time);
  const last = numericTime(data[n - 1]!.time);
  if (first == null || last == null) return null;
  if (time <= first) return (time - first) / barSeconds;
  if (time >= last) return (n - 1) + (time - last) / barSeconds;

  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const t = numericTime(data[mid]!.time);
    if (t == null) return null;
    if (t < time) lo = mid + 1;
    else hi = mid;
  }
  const next = numericTime(data[lo]!.time);
  if (next == null) return null;
  if (next === time) return lo;
  const prev = numericTime(data[lo - 1]!.time);
  if (prev == null || next <= prev) return null;
  return (lo - 1) + (time - prev) / (next - prev);
}

function timeAtLogical(data: readonly { time: Time }[], logical: number, barSeconds: number): number | null {
  const n = data.length;
  if (n === 0 || !(barSeconds > 0) || !Number.isFinite(logical)) return null;
  const first = numericTime(data[0]!.time);
  const last = numericTime(data[n - 1]!.time);
  if (first == null || last == null) return null;
  if (logical <= 0) return first + logical * barSeconds;
  if (logical >= n - 1) return last + (logical - (n - 1)) * barSeconds;
  const i = Math.floor(logical);
  const a = numericTime(data[i]!.time);
  const b = numericTime(data[i + 1]!.time);
  if (a == null || b == null) return null;
  return a + (b - a) * (logical - i);
}

/** `logicalToCoordinate` is only valid for integer indices; the fractional part
 *  is carried by the bar spacing instead of being passed into the library.
 *  An index outside the visible axis (before the first candle or after the
 *  last one) has no library coordinate, so we extrapolate from the nearest
 *  visible edge — this is what lets drawings live outside the loaded candle
 *  range instead of vanishing. */
function coordinateOfLogical(ts: TimeScaleApi, logical: number, spacing: number): number | null {
  if (!(spacing > 0) || !Number.isFinite(logical)) return null;
  const anchor = Math.round(logical);
  let x: Coordinate | null = ts.logicalToCoordinate(anchor as Logical);
  if (x == null || !Number.isFinite(Number(x))) {
    const range = ts.getVisibleLogicalRange();
    if (!range) return null;
    const edge = logical < range.from ? range.from : range.to;
    const edgeX: Coordinate | null = ts.logicalToCoordinate(edge as Logical);
    if (edgeX == null || !Number.isFinite(Number(edgeX))) return null;
    x = (edgeX + (logical - edge) * spacing) as Coordinate;
  } else {
    x = (x + (logical - anchor) * spacing) as Coordinate;
  }
  return x;
}

function logicalOfCoordinate(ts: TimeScaleApi, x: number, spacing: number): number | null {
  if (!(spacing > 0) || !Number.isFinite(x)) return null;
  const anchor = ts.coordinateToLogical(x);
  if (anchor != null) {
    const ax = ts.logicalToCoordinate(anchor);
    if (ax != null && Number.isFinite(Number(ax))) return Number(anchor) + (x - Number(ax)) / spacing;
  }
  // Outside the axis: extrapolate from the nearest visible edge so a tool
  // dragged before the first candle or after the last one keeps working.
  const range = ts.getVisibleLogicalRange();
  if (!range) return null;
  const fromX = ts.logicalToCoordinate(range.from as Logical);
  const toX = ts.logicalToCoordinate(range.to as Logical);
  if (fromX == null || toX == null || !Number.isFinite(Number(fromX)) || !Number.isFinite(Number(toX))) return null;
  const fx = Number(fromX);
  const tx = Number(toX);
  return x <= fx ? Number(range.from) + (x - fx) / spacing : Number(range.to) + (x - tx) / spacing;
}

export interface ShapeStyle {
  color: ShapeColor;
  selected: boolean;
  hovered: boolean;
  ghost: boolean;
  /** A locked shape is drawn lighter and gets hollow handles: the shape says
   *  "I am not movable" without a tooltip or a cursor trick. */
  locked?: boolean;
}

/** `toPrecision(4)` on a price difference without the exponent notation a bare
 *  `toPrecision` produces for the sub-cent values low-cap coins trade at. */
export function trimDiff(v: number): string {
  const s = v.toPrecision(4);
  if (!s.includes("e")) return s;
  const mag = Math.abs(v) > 0 ? Math.floor(Math.log10(Math.abs(v))) : 0;
  return v.toFixed(Math.min(12, Math.max(0, 3 - mag)));
}

/** A signed percent with a real minus sign and no redundant decimals. */
function pct(v: number): string {
  const s = Math.abs(v).toFixed(2);
  return `${v < 0 ? "−" : "+"}${s}%`;
}

/** Distance from a point to a segment, in CSS pixels. */
export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Distance from a point to a circle outline, in CSS pixels. */
export function distToCircle(px: number, py: number, cx: number, cy: number, r: number): number {
  return Math.abs(Math.hypot(px - cx, py - cy) - r);
}

/** Distance from a point to a rectangle edge, in CSS pixels. */
export function distToRect(px: number, py: number, x: number, y: number, w: number, h: number): number {
  const dx = Math.max(x - px, 0, px - (x + w));
  const dy = Math.max(y - py, 0, py - (y + h));
  return Math.hypot(dx, dy);
}

/**
 * Turns one drawing into pixel geometry, or null when it cannot be placed (off
 * scale, or missing the anchors its type needs). That null is also what makes a
 * drawing on another symbol vanish without any extra bookkeeping.
 *
 * The `hit` arrays are the shape's contract with `hitTest`, and they are the one
 * part of this function a visual redesign must not touch: every grab area below
 * is exactly where it was before the redesign.
 */
export function buildShape(d: Drawing, proj: Projector, style: ShapeStyle, fmtPrice: (p: number) => string): Shape | null {
  const [p1, p2, p3] = d.points;
  if (!p1) return null;
  const color = style.color;
  const width = S.strokeWidth(d.lineWidth, style.selected, style.hovered);
  const ghost = style.ghost;
  /** A ghost is a promise, a locked shape is inert: both are the geometry drawn
   *  at less than full strength, and everything below multiplies through this. */
  const shapeAlpha = (ghost ? S.ALPHA_GHOST : 1) * (style.locked ? S.ALPHA_LOCKED : 1);
  const A = (a: number) => a * shapeAlpha;
  const dash = d.dash;
  const state: Shape["state"] = style.selected ? "select" : style.hovered ? "hover" : "rest";
  const out: Shape = {
    id: d.id, type: d.type, state,
    lines: [], bands: [], arcs: [], discs: [], polys: [], tags: [], texts: [], dots: [],
    hit: { lines: [], bands: [], points: [] },
  };

  /** A stroke that the cursor can also land on. */
  const line = (x1: number, y1: number, x2: number, y2: number, opts?: StrokeOpts) => {
    const l: ShapeLine = {
      x1, y1, x2, y2,
      color: opts?.color ?? color,
      width: opts?.width ?? width,
      dash: opts?.dash ?? dash,
      alpha: A(opts?.alpha ?? 1),
    };
    out.lines.push(l);
    out.hit.lines.push([x1, y1, x2, y2]);
  };
  /** A stroke that is only ever seen: end caps, guides, zone rails. */
  const mark = (x1: number, y1: number, x2: number, y2: number, opts?: StrokeOpts) => {
    out.lines.push({
      x1, y1, x2, y2,
      color: opts?.color ?? color,
      width: opts?.width ?? width,
      dash: opts?.dash,
      alpha: A(opts?.alpha ?? 1),
    });
  };
  const fill = (x: number, y: number, w: number, h: number, alpha: number, c: ShapeColor = color) => {
    out.bands.push({ x, y, w, h, color: c, alpha: alpha * shapeAlpha });
  };

  /** Perpendicular end caps, so a finite line reads as a segment with ends and
   *  not as a cut across the chart. */
  const caps = (x1: number, y1: number, x2: number, y2: number, len = 5) => {
    const dx = x2 - x1, dy = y2 - y1;
    const n = Math.hypot(dx, dy) || 1;
    const nx = (-dy / n) * len, ny = (dx / n) * len;
    mark(x1 - nx, y1 - ny, x1 + nx, y1 + ny, { width: S.LINE_SECOND, alpha: 0.75 });
    mark(x2 - nx, y2 - ny, x2 + nx, y2 + ny, { width: S.LINE_SECOND, alpha: 0.75 });
  };

  if (d.type === "horizontal") {
    const y = proj.yOf(p1.price);
    if (y == null) return null;
    line(0, y, proj.plotW, y);
    return out;
  }

  if (d.type === "vertical") {
    const x = proj.xOf(p1.time);
    if (x == null) return null;
    line(x, 0, x, proj.plotH);
    return out;
  }

  if ((d.type === "trendline" || d.type === "ray" || d.type === "measure") && p2) {
    const x1 = proj.xOf(p1.time), y1 = proj.yOf(p1.price);
    const x2 = proj.xOf(p2.time), y2 = proj.yOf(p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
    let ex = x2, ey = y2;
    if (d.type === "ray") {
      const dx = x2 - x1, dy = y2 - y1;
      if (dx !== 0 || dy !== 0) {
        const edge = dx >= 0 ? proj.plotW : 0;
        ex = edge;
        ey = y1 + dy * ((edge - x1) / (dx || 1e-9));
      }
    }
    if (d.type === "measure") {
      line(x1, y1, x2, y2, { dash: S.DASH_SHORT, width: Math.min(width, S.LINE + 0.3) });
      caps(x1, y1, x2, y2);
      const diff = p2.price - p1.price;
      const pctv = p1.price !== 0 ? (diff / p1.price) * 100 : 0;
      const minutes = Math.round(Math.abs(p2.time - p1.time) / 60);
      const span = minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
      out.tags.push({
        x: (x1 + x2) / 2,
        y: (y1 + y2) / 2 - S.TAG_GAP - S.TAG_LINE,
        text: `${diff >= 0 ? "+" : "−"}${trimDiff(Math.abs(diff))}  ${pct(pctv)}`,
        sub: span,
        color: diff >= 0 ? "up" : "down",
        align: "center",
      });
      return out;
    }
    line(x1, y1, x2, y2);
    if (d.type === "ray") {
      // The origin is the shape's identity: mark it even when nothing is selected.
      out.dots.push({ x: x1, y: y1, r: S.CENTER_R, kind: "center", alpha: A(1) });
      mark(x2, y2, ex, ey, { dash: S.DASH_INFINITE, width: S.LINE_SECOND, alpha: S.ALPHA_INFINITE });
    }
    if (state !== "rest") {
      for (const [x, y] of [[x1, y1], [x2, y2]] as const) {
        out.dots.push({ x, y, r: S.ANCHOR_R, kind: "anchor", alpha: A(1) });
      }
    }
    return out;
  }

  if ((d.type === "fibonacci" || d.type === "fibExtension") && p2) {
    const x1 = proj.xOf(p1.time), x2 = proj.xOf(p2.time);
    const x3 = d.type === "fibExtension" ? proj.xOf(p3?.time ?? 0) : null;
    if (x1 == null || x2 == null) return null;
    if (d.type === "fibExtension" && x3 == null) return null;
    const left = Math.min(x1, x2, x3 ?? x1);
    const right = Math.max(x1, x2, x3 ?? x2, left + 8);
    const ext = d.type === "fibExtension";
    const rows: { lvl: number; price: number; y: number }[] = [];
    for (const lvl of ext ? [...FIB_LEVELS, ...S.FIB_EXTENSION_LEVELS] : FIB_LEVELS) {
      const price = p1.price + (p2.price - p1.price) * lvl;
      const y = proj.yOf(price);
      if (y != null) rows.push({ lvl, price, y });
    }
    if (rows.length === 0) return null;
    const ys = rows.map((r) => r.y);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    const boxH = Math.max(bottom - top, 8);
    out.hit.bands.push([left, top, right - left, boxH]);

    // The retracement is a field, not a fence: each band between two levels is
    // tinted by how close that band is to the middle of the swing, so the golden
    // zone reads as the dense part of the shape at a glance.
    const sorted = [...rows].sort((a, b) => a.lvl - b.lvl);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!, b = sorted[i]!;
      if (b.lvl - a.lvl < 0.05) continue;
      const mid = (a.lvl + b.lvl) / 2;
      const near = ext && mid > 1;
      const weight = near ? 0.25 : 1 - Math.abs(mid - 0.5) * 1.35;
      const alpha = S.FIB_ZONE_MIN + Math.max(0, Math.min(1, weight)) * (S.FIB_ZONE_MAX - S.FIB_ZONE_MIN);
      fill(left, Math.min(a.y, b.y), right - left, Math.abs(b.y - a.y), alpha);
    }

    for (const r of rows) {
      const isExt = ext && S.FIB_EXTENSION_LEVELS.includes(r.lvl);
      const golden = S.FIB_GOLDEN_LEVELS.includes(r.lvl);
      const mult = isExt ? S.FIB_EXT : r.lvl === 0 || r.lvl === 1 ? S.FIB_KEY : golden ? S.FIB_GOLDEN : r.lvl === 0.5 ? S.FIB_MID : S.FIB_LEVEL;
      out.lines.push({
        x1: left, y1: r.y, x2: right, y2: r.y, color, width: width * mult,
        // A measured level is a rule the eye has to follow across the chart, so
        // it is drawn solid like the swing frame; only the projected extension
        // levels are dashed, because they are a forecast and not a measurement.
        dash: isExt ? S.DASH_PROJECTION : dash,
        alpha: A(isExt ? 0.6 : 1),
        // Selection marks the swing the retracement was measured from; haloing
        // all seven levels at once turns the tool into a block of interface
        // colour and hides the field the levels define.
        halo: r.lvl === 0 || r.lvl === 1,
      });
      out.hit.lines.push([left, r.y, right, r.y]);
      out.tags.push({
        x: right + S.TAG_GAP, y: r.y,
        text: r.lvl.toFixed(3),
        sub: fmtPrice(r.price),
        color, align: "left",
        alpha: A(isExt ? 0.7 : 1),
      });
    }
    return out;
  }

  if (d.type === "extendedLine" && p2) {
    const x1 = proj.xOf(p1.time), y1 = proj.yOf(p1.price);
    const x2 = proj.xOf(p2.time), y2 = proj.yOf(p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
    const dx = x2 - x1;
    if (dx === 0) {
      line(x1, 0, x1, proj.plotH);
      out.hit.bands.push([x1 - 4, 0, 8, proj.plotH]);
      return out;
    }
    const left = 0, right = proj.plotW;
    const ey1 = y1 + (y2 - y1) * ((left - x1) / dx);
    const ey2 = y1 + (y2 - y1) * ((right - x1) / dx);
    // The anchored segment carries the weight; both wings say "this is infinite".
    mark(left, ey1, x1, y1, { dash: S.DASH_INFINITE, width: S.LINE_SECOND, alpha: S.ALPHA_INFINITE });
    mark(x2, y2, right, ey2, { dash: S.DASH_INFINITE, width: S.LINE_SECOND, alpha: S.ALPHA_INFINITE });
    line(x1, y1, x2, y2);
    out.hit.lines.push([left, ey1, right, ey2]);
    if (state !== "rest") {
      for (const [x, y] of [[x1, y1], [x2, y2]] as const) {
        out.dots.push({ x, y, r: S.ANCHOR_R, kind: "anchor", alpha: A(1) });
      }
    }
    return out;
  }

  if (d.type === "parallelChannel" && p2 && p3) {
    const x1 = proj.xOf(p1.time), y1 = proj.yOf(p1.price);
    const x2 = proj.xOf(p2.time), y2 = proj.yOf(p2.price);
    const x3 = proj.xOf(p3.time), y3 = proj.yOf(p3.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null || x3 == null || y3 == null) return null;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const offset = nx * (x3 - x1) + ny * (y3 - y1);
    const x1b = x1 + nx * offset, y1b = y1 + ny * offset;
    const x2b = x2 + nx * offset, y2b = y2 + ny * offset;
    // The channel is the shape, so the space between the rails is filled and the
    // rails themselves are solid; the old dashed pair read as two loose lines.
    out.polys.push({
      pts: [[x1, y1], [x2, y2], [x2b, y2b], [x1b, y1b]],
      color, alpha: (style.hovered || style.selected ? S.FILL_ACTIVE : S.FILL_REST) * shapeAlpha,
    });
    line(x1, y1, x2, y2, { width: S.LINE_EDGE });
    line(x1b, y1b, x2b, y2b, { width: S.LINE_EDGE });
    mark((x1 + x1b) / 2, (y1 + y1b) / 2, (x2 + x2b) / 2, (y2 + y2b) / 2, { dash: S.DASH_DOTTED, width: S.LINE_SECOND, alpha: 0.4 });
    out.hit.lines.push([x1, y1, x1b, y1b]);
    out.hit.lines.push([x2, y2, x2b, y2b]);
    out.hit.bands.push([Math.min(x1, x2, x1b, x2b) - 4, Math.min(y1, y2, y1b, y2b) - 4, Math.abs(x2 - x1) + 8, Math.abs(y2 - y1) + 8]);
    return out;
  }

  if (d.type === "rectangle" && p2) {
    const x1 = proj.xOf(p1.time), y1 = proj.yOf(p1.price);
    const x2 = proj.xOf(p2.time), y2 = proj.yOf(p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
    const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
    const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    if (rw < 2 && rh < 2) return null;
    out.hit.bands.push([rx, ry, rw, rh]);
    fill(rx, ry, rw, rh, d.fillOpacity ?? (style.hovered || style.selected ? S.FILL_ACTIVE : S.FILL_REST));
    mark(rx, ry, rx + rw, ry, { width: S.LINE_EDGE });
    mark(rx + rw, ry, rx + rw, ry + rh, { width: S.LINE_EDGE });
    mark(rx + rw, ry + rh, rx, ry + rh, { width: S.LINE_EDGE });
    mark(rx, ry + rh, rx, ry, { width: S.LINE_EDGE });
    out.hit.lines.push([rx, ry, rx + rw, ry]);
    out.hit.lines.push([rx + rw, ry, rx + rw, ry + rh]);
    out.hit.lines.push([rx + rw, ry + rh, rx, ry + rh]);
    out.hit.lines.push([rx, ry + rh, rx, ry]);
    return out;
  }

  if (d.type === "circle" && p2) {
    const x1 = proj.xOf(p1.time), y1 = proj.yOf(p1.price);
    const x2 = proj.xOf(p2.time), y2 = proj.yOf(p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
    const r = Math.hypot(x2 - x1, y2 - y1);
    if (r < 2) return null;
    out.discs.push({ cx: x1, cy: y1, r, color, alpha: (d.fillOpacity ?? (style.hovered || style.selected ? S.FILL_ACTIVE : S.FILL_REST)) * shapeAlpha });
    out.arcs.push({ cx: x1, cy: y1, r, startAngle: 0, endAngle: Math.PI * 2, color, width: S.LINE_EDGE, alpha: A(1) });
    out.hit.bands.push([x1 - r - 4, y1 - r - 4, r * 2 + 8, r * 2 + 8]);
    out.hit.lines.push([x1 + r, y1, x1 - r, y1]);
    // The centre is an anchor the user drags, and the radius is the shape's
    // size: showing both makes the tool's model visible instead of guessed.
    out.dots.push({ x: x1, y: y1, r: S.CENTER_R, kind: "center", alpha: A(1) });
    mark(x1, y1, x2, y2, { dash: S.DASH_DOTTED, width: S.LINE_SECOND, alpha: 0.35 });
    return out;
  }

  if (d.type === "priceLabel") {
    const y = proj.yOf(p1.price);
    if (y == null) return null;
    const x = proj.xOf(p1.time);
    const px = x ?? 0;
    const text = fmtPrice(p1.price);
    const label = d.text ? `${d.text}  ${text}` : text;
    line(px, y, Math.min(px + 36, proj.plotW), y, { width: S.LINE_EDGE });
    out.hit.bands.push([px - 2, y - 6, 80, 12]);
    out.hit.lines.push([px, y, Math.min(px + 36, proj.plotW), y]);
    out.tags.push({ x: Math.min(px + 36, proj.plotW) + S.TAG_GAP, y, text: label, color, align: "left", chip: "solid" });
    return out;
  }

  if (d.type === "text") {
    const x = proj.xOf(p1.time), y = proj.yOf(p1.price);
    if (x == null || y == null) return null;
    const text = d.text || "Text";
    const size = d.fontSize ?? 13;
    out.texts.push({ x: x + 2, y, text, size, color, align: "left", alpha: A(1) });
    out.hit.bands.push([x - 2, y - 14, 220, 24]);
    if (style.selected) {
      mark(x - 6, y - size - 4, x - 6 + Math.max(60, text.length * size * 0.58) + 12, y - size - 4, { dash: S.DASH_DOTTED, width: 1, alpha: 0.5 });
      mark(x - 6, y + 6, x - 6 + Math.max(60, text.length * size * 0.58) + 12, y + 6, { dash: S.DASH_DOTTED, width: 1, alpha: 0.5 });
    }
    return out;
  }

  if (d.type === "arrow" && p2) {
    const x1 = proj.xOf(p1.time), y1 = proj.yOf(p1.price);
    const x2 = proj.xOf(p2.time), y2 = proj.yOf(p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux;
    const head = Math.max(7, Math.min(15, len * 0.28));
    const bx = x2 - ux * head, by = y2 - uy * head;
    line(x1, y1, bx, by);
    // A filled head, not two hairlines: the direction has to survive being 9px.
    out.polys.push({
      pts: [[x2, y2], [bx + px * head * 0.42, by + py * head * 0.42], [bx - px * head * 0.42, by - py * head * 0.42]],
      color, alpha: A(1), edge: Math.max(1, width * 0.6),
    });
    out.hit.lines.push([x1, y1, x2, y2]);
    out.hit.bands.push([Math.min(x1, x2) - 4, Math.min(y1, y2) - 4, Math.abs(x2 - x1) + 8, Math.abs(y2 - y1) + 8]);
    if (d.text) {
      out.tags.push({ x: x2 + px * 10, y: y2 + py * 10, text: d.text, color, align: "left" });
    }
    return out;
  }

  if ((d.type === "longPosition" || d.type === "shortPosition") && p2 && p3) {
    const m = positionMetrics(d.points);
    const x1 = proj.xOf(p1.time);
    const x2r = proj.xOf(p2.time), x3 = proj.xOf(p3.time);
    const yEntry = proj.yOf(p1.price), yTarget = proj.yOf(p2.price), yStop = proj.yOf(p3.price);
    if (x1 == null || x2r == null || x3 == null || yEntry == null || yTarget == null || yStop == null || !m) return null;
    const left = Math.min(x1, x2r, x3);
    const right = Math.max(x1, x2r, x3, left + 8);
    const isLong = d.type === "longPosition";
    const profit: ShapeColor = isLong ? "up" : "down";
    const loss: ShapeColor = isLong ? "down" : "up";
    const hProfit = Math.abs(yTarget - yEntry);
    const hLoss = Math.abs(yStop - yEntry);
    const strong = (style.hovered || style.selected ? S.POSITION_FILL_ACTIVE : S.POSITION_FILL) * shapeAlpha;
    out.hit.bands.push([left, Math.min(yEntry, yTarget, yStop), right - left, Math.max(hProfit, hLoss)]);
    fill(left, Math.min(yEntry, yTarget), right - left, hProfit, strong, profit);
    fill(left, Math.min(yEntry, yStop), right - left, hLoss, strong, loss);

    // Entry is the reference, so it is the only line drawn in the chart's own
    // ink; TP and SL belong to their side of the trade.
    line(left, yEntry, right, yEntry, { color: "text", width: S.LINE_EDGE });
    line(left, yTarget, right, yTarget, { color: profit, width: S.LINE_SECOND });
    line(left, yStop, right, yStop, { color: loss, width: S.LINE_SECOND });

    out.tags.push({
      x: left + S.TAG_GAP, y: Math.min(yEntry, yTarget, yStop) - S.TAG_GAP - S.TAG_LINE,
      text: isLong ? "LONG" : "SHORT",
      sub: `R:R ${m.rr == null ? "—" : `1:${m.rr.toFixed(2)}`}`,
      color: profit, align: "left",
    });
    out.tags.push({ x: right + S.TAG_GAP, y: yTarget, text: fmtPrice(m.target), sub: pct(m.rewardPct), color: profit, align: "left" });
    out.tags.push({ x: right + S.TAG_GAP, y: yStop, text: fmtPrice(m.stop), sub: pct(m.riskPct), color: loss, align: "left" });
    return out;
  }

  return null;
}

/** Every price a shape wants on the chart's price axis, in draw order. */
export function axisPriceTags(d: Drawing, fmtPrice: (p: number) => string): { price: number; text: string; color: ShapeColor }[] {
  const p1 = d.points[0];
  if (!p1) return [];
  if (d.type === "horizontal") return [{ price: p1.price, text: fmtPrice(p1.price), color: d.color }];
  if (d.type === "priceLabel") return [{ price: p1.price, text: fmtPrice(p1.price), color: d.color }];
  if (d.type === "longPosition" || d.type === "shortPosition") {
    const m = positionMetrics(d.points);
    if (!m) return [];
    const isLong = d.type === "longPosition";
    const profit: ShapeColor = isLong ? "up" : "down";
    const loss: ShapeColor = isLong ? "down" : "up";
    return [
      { price: m.entry, text: `Entry ${fmtPrice(m.entry)}`, color: "text" },
      { price: m.target, text: `TP ${fmtPrice(m.target)}`, color: profit },
      { price: m.stop, text: `SL ${fmtPrice(m.stop)}`, color: loss },
    ];
  }
  return [];
}

/** Ink that stays readable on top of `bg`: the label colour of a filled chip is
 *  decided by the chip, not by the theme. */
function inkOn(bg: string, p: ChartPalette): string {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(bg.trim());
  if (!m) return p.text;
  let body = m[1]!.length === 3 ? m[1]!.replace(/./g, (c) => c + c) : m[1]!;
  const r = parseInt(body.slice(0, 2), 16) / 255;
  const g = parseInt(body.slice(2, 4), 16) / 255;
  const b = parseInt(body.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? "#101418" : "#f4f6f8";
}

class DrawingsRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly primitive: DrawingsPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const src = this.primitive.source;
    const palette = src.palette();
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const rx = scope.horizontalPixelRatio;
      const ry = scope.verticalPixelRatio;
      // Draw in CSS pixels; the bitmap scale keeps it crisp on hi-dpi screens.
      ctx.save();
      ctx.scale(rx, ry);
      const shapes = this.primitive.shapes();

      for (const s of shapes) this.paintFills(ctx, s, palette);
      for (const s of shapes) this.paintHalo(ctx, s, palette);
      for (const s of shapes) this.paintGeometry(ctx, s, palette, rx, ry);
      this.paintTags(ctx, shapes, palette);
      this.paintTexts(ctx, shapes, palette);
      for (const s of shapes) this.paintDots(ctx, s, palette);

      ctx.globalAlpha = 1;
      ctx.restore();
    });
  }

  private paintFills(ctx: CanvasRenderingContext2D, s: Shape, p: ChartPalette): void {
    for (const b of s.bands) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = withAlpha(resolveColor(b.color, p), b.alpha);
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    for (const d of s.discs) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = withAlpha(resolveColor(d.color, p), d.alpha);
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const poly of s.polys) {
      ctx.globalAlpha = 1;
      ctx.beginPath();
      this.tracePoly(ctx, poly.pts);
      ctx.fillStyle = withAlpha(resolveColor(poly.color, p), poly.alpha);
      ctx.fill();
      if (poly.edge) {
        ctx.strokeStyle = withAlpha(resolveColor(poly.color, p), Math.min(1, poly.alpha * 8));
        ctx.lineWidth = poly.edge;
        ctx.stroke();
      }
    }
  }

  /** The interface's own mark on a shape: a soft ring in the selection colour
   *  under the stroke. Hover and selection are the same gesture at two
   *  strengths, which is what makes the state readable without a legend. */
  private paintHalo(ctx: CanvasRenderingContext2D, s: Shape, p: ChartPalette): void {
    const alpha = s.state === "select" ? S.HALO_ALPHA_SELECTED : s.state === "hover" ? S.HALO_ALPHA_HOVERED : 0;
    if (!alpha) return;
    ctx.lineCap = "round";
    ctx.setLineDash([]);
    ctx.strokeStyle = withAlpha(p.selection, alpha);
    for (const l of s.lines) {
      if (l.dash || l.halo === false) continue;
      ctx.lineWidth = l.width + S.HALO_SPREAD;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
    for (const a of s.arcs) {
      ctx.lineWidth = a.width + S.HALO_SPREAD;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(a.cx, a.cy, a.r, a.startAngle, a.endAngle);
      ctx.stroke();
    }
    // One ring around the whole filled figure, not one per band: the retracement
    // and the position tools are built from several stacked regions, and outlining
    // each of them reads as a cage of interface colour over the shape.
    if (s.bands.length) {
      const l = Math.min(...s.bands.map((b) => b.x));
      const t = Math.min(...s.bands.map((b) => b.y));
      const r = Math.max(...s.bands.map((b) => b.x + b.w));
      const b = Math.max(...s.bands.map((b) => b.y + b.h));
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = withAlpha(p.selection, alpha * 2.4);
      ctx.strokeRect(l + 0.5, t + 0.5, r - l - 1, b - t - 1);
    }
    ctx.setLineDash([]);
  }

  private paintGeometry(ctx: CanvasRenderingContext2D, s: Shape, p: ChartPalette, rx: number, ry: number): void {
    for (const a of s.arcs) {
      ctx.globalAlpha = a.alpha ?? 1;
      ctx.strokeStyle = resolveColor(a.color, p);
      ctx.lineWidth = a.width;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(a.cx, a.cy, a.r, a.startAngle, a.endAngle);
      ctx.stroke();
    }
    for (const l of s.lines) {
      const alpha = l.alpha ?? 1;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = resolveColor(l.color, p);
      ctx.lineWidth = l.width;
      ctx.setLineDash(l.dash ?? []);
      ctx.lineCap = l.dash ? "butt" : "round";
      // A straight stroke lands on whole device pixels, so a 1.5px line stays a
      // line instead of a two-pixel smudge; diagonals keep round caps instead.
      const flat = l.y1 === l.y2;
      const upright = l.x1 === l.x2;
      const x1 = upright ? S.snapAxis(l.x1, rx, l.width) : l.x1;
      const x2 = upright ? x1 : l.x2;
      const y1 = flat ? S.snapAxis(l.y1, ry, l.width) : l.y1;
      const y2 = flat ? y1 : l.y2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  /** Text chips: the ratio/label in the shape's colour, the value beside it in
   *  the theme's muted ink, on a solid chip so it never fights the candles. */
  private paintTags(ctx: CanvasRenderingContext2D, shapes: readonly Shape[], p: ChartPalette): void {
    ctx.globalAlpha = 1;
    ctx.textBaseline = "middle";
    for (const s of shapes) {
      for (const tag of s.tags) {
        const color = resolveColor(tag.color, p);
        ctx.font = `500 ${S.TAG_FONT}px ${p.fontFamily}`;
        const mainW = ctx.measureText(tag.text).width;
        let subW = 0;
        if (tag.sub) {
          ctx.font = `${S.TAG_FONT_SUB}px ${p.fontFamily}`;
          subW = ctx.measureText(tag.sub).width + 4;
        }
        const w = mainW + subW + S.TAG_PAD_X * 2;
        const h = S.TAG_LINE;
        const left = tag.align === "center" ? tag.x - w / 2 : tag.x;
        const top = tag.y - h / 2;
        const alpha = tag.alpha ?? 1;
        const solid = tag.chip === "solid";
        ctx.beginPath();
        ctx.roundRect(left, top, w, h, S.TAG_RADIUS);
        ctx.fillStyle = solid ? withAlpha(color, S.TAG_BG_ALPHA * alpha) : withAlpha(p.labelBg, S.TAG_BG_ALPHA * alpha);
        ctx.fill();
        if (!solid) {
          ctx.strokeStyle = withAlpha(color, S.TAG_BORDER_ALPHA * alpha);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.font = `500 ${S.TAG_FONT}px ${p.fontFamily}`;
        ctx.fillStyle = solid ? inkOn(color, p) : withAlpha(color, alpha);
        ctx.fillText(tag.text, left + S.TAG_PAD_X, tag.y);
        if (tag.sub) {
          ctx.font = `${S.TAG_FONT_SUB}px ${p.fontFamily}`;
          ctx.fillStyle = solid ? withAlpha(inkOn(color, p), 0.8) : withAlpha(p.labelText, alpha);
          ctx.fillText(tag.sub, left + S.TAG_PAD_X + mainW + 4, tag.y);
        }
      }
    }
  }

  /** Bare annotation text: no chip, but a background-coloured outline so the
   *  glyphs stay legible over a dense candle field in both themes. */
  private paintTexts(ctx: CanvasRenderingContext2D, shapes: readonly Shape[], p: ChartPalette): void {
    ctx.textBaseline = "middle";
    for (const s of shapes) {
      for (const t of s.texts) {
        ctx.globalAlpha = t.alpha ?? 1;
        ctx.font = `500 ${t.size}px ${p.fontFamily}`;
        ctx.textAlign = t.align;
        ctx.lineWidth = Math.max(2.5, t.size * 0.22);
        ctx.strokeStyle = withAlpha(p.bg, 0.85);
        ctx.strokeText(t.text, t.x, t.y);
        ctx.fillStyle = resolveColor(t.color, p);
        ctx.fillText(t.text, t.x, t.y);
      }
      ctx.textAlign = "left";
    }
  }

  /** Anchors, handles and the pending dot. All of them are drawn from the theme,
   *  never from the shape's colour, so "grab here" looks the same everywhere. */
  private paintDots(ctx: CanvasRenderingContext2D, s: Shape, p: ChartPalette): void {
    for (const dot of s.dots) {
      ctx.globalAlpha = dot.alpha ?? 1;
      const stroke = p.selection;
      if (dot.kind === "handle" || dot.kind === "locked") {
        const size = S.HANDLE_SIZE;
        const half = size / 2;
        ctx.beginPath();
        ctx.roundRect(dot.x - half, dot.y - half, size, size, S.HANDLE_RADIUS);
        if (dot.kind === "locked") {
          ctx.fillStyle = withAlpha(p.bg, 0.6);
          ctx.fill();
          ctx.strokeStyle = withAlpha(stroke, 0.7);
          ctx.lineWidth = S.HANDLE_LOCKED_BORDER;
          ctx.setLineDash([2, 2]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = p.bg;
          ctx.fill();
          ctx.strokeStyle = stroke;
          ctx.lineWidth = S.HANDLE_BORDER;
          ctx.stroke();
        }
        continue;
      }
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
      if (dot.kind === "center") {
        ctx.fillStyle = withAlpha(stroke, 0.9);
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = p.bg;
        ctx.stroke();
      } else if (dot.kind === "pending") {
        ctx.fillStyle = p.bg;
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = stroke;
        ctx.stroke();
      } else {
        ctx.fillStyle = p.bg;
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }
    }
  }

  private tracePoly(ctx: CanvasRenderingContext2D, pts: readonly [number, number][]): void {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  }
}

class AxisTag implements ISeriesPrimitiveAxisView {
  constructor(
    private readonly price: number,
    private readonly label: string,
    private readonly color: ShapeColor,
    private readonly src: DrawingsSource,
    private readonly yOf: (p: number) => number | null,
  ) {}
  coordinate(): number { return this.yOf(this.price) ?? -1e6; }
  text(): string { return this.label; }
  /** A filled tag in the level's own colour with contrast ink — the same
   *  treatment the in-plot chips get, so a level looks identical on the scale
   *  and on the shape. */
  textColor(): string { return inkOn(this.backColor(), this.src.palette()); }
  backColor(): string { return resolveColor(this.color, this.src.palette()); }
  visible(): boolean { return this.yOf(this.price) != null; }
}

class TimeTag implements ISeriesPrimitiveAxisView {
  constructor(
    private readonly time: number,
    private readonly label: string,
    private readonly color: ShapeColor,
    private readonly src: DrawingsSource,
    private readonly xOf: (t: number) => number | null,
  ) {}
  coordinate(): number { return this.xOf(this.time) ?? -1e6; }
  text(): string { return this.label; }
  textColor(): string { return inkOn(this.backColor(), this.src.palette()); }
  backColor(): string { return resolveColor(this.color, this.src.palette()); }
  visible(): boolean { return this.xOf(this.time) != null; }
}

/**
 * One primitive paints every annotation. That is what lets a single `hitTest`
 * pick the top-most shape, lets the chart own the cursor, and keeps the price
 * axis free to lay its own labels out. It is attached to the series that drives
 * the right-hand price scale, so it follows that series' pane.
 */
export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private paneIndex: number | null = null;
  private readonly views: IPrimitivePaneView[];
  /** Geometry is rebuilt per paint; this caches it for the axis + hit-test calls
   *  that happen in the same frame. */
  private cached: { key: string; shapes: Shape[] } | null = null;
  private axisKey = "";
  private axisViews: readonly ISeriesPrimitiveAxisView[] = [];
  private timeKey = "";
  private timeViews: readonly ISeriesPrimitiveAxisView[] = [];

  constructor(
    private readonly getChart: () => IChartApi | null,
    public source: DrawingsSource,
  ) {
    const self = this;
    this.views = [{ renderer: () => new DrawingsRenderer(self) }];
  }

  attached(params: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = params.chart as unknown as IChartApi;
    this.series = params.series;
    this.requestUpdate = params.requestUpdate;
  }

  setSource(source: DrawingsSource): void {
    this.source = source;
    this.cached = null;
    this.axisKey = "";
    this.timeKey = "";
    this.requestUpdate?.();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
    this.paneIndex = null;
    this.cached = null;
  }

  /** The chart calls this whenever the viewport changes; anything we memoized by
   *  screen position is then void. */
  updateAllViews(): void {
    this.cached = null;
  }

  /** Which pane the annotations live in, so the pointer controller can ignore
   *  crosshair moves made over an oscillator. */
  paneIndexOf(): number {
    const chart = this.chart ?? this.getChart();
    if (chart) this.paneHeight(chart);
    return this.paneIndex ?? 0;
  }

  /** Ask the chart to repaint the primitive (hover, selection, a drag). */
  invalidate(): void {
    this.cached = null;
    this.requestUpdate?.();
  }

  projector(): Projector | null {
    const chart = this.chart ?? this.getChart();
    const series = this.series;
    if (!chart || !series) return null;
    const ts = chart.timeScale();
    const data = series.data();
    const spacing = ts.options().barSpacing;
    const barSeconds = this.source.barSeconds();
    return {
      xOf: (t) => {
        const logical = logicalIndexOfTime(data, t, barSeconds);
        return logical == null ? null : coordinateOfLogical(ts, logical, spacing);
      },
      yOf: (p) => {
        const v = series.priceToCoordinate(p);
        if (v != null && Number.isFinite(Number(v))) return Number(v);
        return this.priceAsCoordinate(chart, p);
      },
      plotW: ts.width(),
      plotH: this.paneHeight(chart),
    };
  }

  /** `series.priceToCoordinate` returns null above/below the visible band. This
   *  stretches the pixel from the nearest edge of the current price range, so an
   *  anchor dragged past the top or bottom of the chart keeps moving instead of
   *  snapping back to the nearest candle. */
  private priceAsCoordinate(chart: IChartApi, p: number): number | null {
    const series = this.series;
    if (!series) return null;
    const ps = chart.priceScale("right");
    const visible = ps.getVisibleRange();
    if (!visible) return null;
    const minY = series.priceToCoordinate(visible.from);
    const maxY = series.priceToCoordinate(visible.to);
    if (minY == null || maxY == null || minY === maxY) return null;
    return minY + (p - visible.from) * (maxY - minY) / (visible.to - visible.from);
  }

  /** ISeriesApi does not expose its pane, so the owning pane is found once and
   *  kept until the series moves or the chart is rebuilt. */
  private paneHeight(chart: IChartApi): number {
    const panes = chart.panes();
    if (this.paneIndex != null && panes[this.paneIndex]) {
      const cached = panes[this.paneIndex]!;
      if (cached.getSeries().includes(this.series as never)) return cached.getHeight();
    }
    for (let i = 0; i < panes.length; i++) {
      if (panes[i]!.getSeries().includes(this.series as never)) {
        this.paneIndex = i;
        return panes[i]!.getHeight();
      }
    }
    return panes[0]?.getHeight() ?? 0;
  }

  project(point: DrawingPoint): { x: number; y: number } | null {
    const proj = this.projector();
    if (!proj) return null;
    const x = proj.xOf(point.time);
    const y = proj.yOf(point.price);
    return x == null || y == null ? null : { x, y };
  }

  unproject(x: number, y: number): DrawingPoint | null {
    const chart = this.chart ?? this.getChart();
    const series = this.series;
    if (!chart || !series) return null;
    const ts = chart.timeScale();
    const spacing = ts.options().barSpacing;
    const barSeconds = this.source.barSeconds();
    const logical = logicalOfCoordinate(ts, x, spacing);
    if (logical == null) return null;
    const time = timeAtLogical(series.data(), logical, barSeconds);
    if (time == null || !Number.isFinite(time)) return null;
    let price = series.coordinateToPrice(y);
    if (price == null || !Number.isFinite(Number(price))) {
      // The cursor is above/below the visible price band: stretch the price
      // back from the nearest edge of the current range so a drag keeps going
      // past the top/bottom of the chart instead of snapping.
      const visible = chart.priceScale("right").getVisibleRange();
      if (!visible) return null;
      const minPrice = series.priceToCoordinate(visible.from);
      const maxPrice = series.priceToCoordinate(visible.to);
      if (minPrice == null || maxPrice == null || minPrice === maxPrice) return null;
      const frac = (y - minPrice) / (maxPrice - minPrice);
      price = (minPrice + frac * (maxPrice - minPrice)) as BarPrice;
    }
    return { time: Math.round(time), price: Number(price) };
  }

  /** Shapes for the current frame, including the selection handles. */
  shapes(): Shape[] {
    const proj = this.projector();
    if (!proj) return [];
    const src = this.source;
    const selectedId = src.selectedId();
    const hoverId = src.hoverId();
    const drawings = src.drawings();
    const interactive = src.interactive();
    // A cheap identity key: the same inputs on the same viewport give the same
    // geometry, so the axis and hit-test calls in this frame reuse the work.
    const key = `${proj.plotW}x${proj.plotH}|${selectedId}|${hoverId}|${interactive}|${drawings.length}|${src.ghost() ? 1 : 0}|${src.pending().length}`;
    if (this.cached?.key === key) return this.cached.shapes;

    const shapes: Shape[] = [];
    for (const d of drawings) {
      if (d.visible === false) continue;
      const s = buildShape(d, proj, {
        color: d.color,
        selected: d.id === selectedId,
        hovered: d.id === hoverId,
        ghost: false,
        locked: !!d.locked,
      }, src.fmtPrice);
      if (s) shapes.push(s);
    }
    const ghost = src.ghost();
    if (ghost) {
      const s = buildShape(ghost, proj, { color: ghost.color, selected: false, hovered: false, ghost: true }, src.fmtPrice);
      if (s) shapes.push(s);
    }

    const selected = interactive ? drawings.find((d) => d.id === selectedId && d.visible !== false) : undefined;
    if (selected) {
      // One synthetic shape per anchor: the hit id carries the anchor index, which
      // is what tells a drag "move point 2" from "move the whole body". A locked
      // shape gets the same marks drawn hollow, and no hit area — it cannot be
      // edited, and it should not look like it can.
      selected.points.forEach((p, i) => {
        const xy = this.project(p);
        if (!xy) return;
        const locked = !!selected.locked;
        shapes.push({
          id: hitPointId(selected.id, i),
          type: selected.type,
          state: "rest",
          lines: [], bands: [], tags: [], texts: [], arcs: [], discs: [], polys: [],
          dots: [{ x: xy.x, y: xy.y, r: S.HANDLE_SIZE / 2, kind: locked ? "locked" : "handle", alpha: 1 }],
          hit: { lines: [], bands: [], points: locked ? [] : [[xy.x, xy.y]] },
        });
      });
    }
    // Every click must leave a mark: the first anchor of a 3-click tool paints no
    // shape on its own, so it shows as a dot.
    const pending = src.pending();
    if (pending.length) {
      const dots: ShapeDot[] = [];
      for (const p of pending) {
        const xy = this.project(p);
        if (xy) dots.push({ x: xy.x, y: xy.y, r: S.PENDING_R, kind: "pending", alpha: 1 });
      }
      if (dots.length) {
        shapes.push({
          id: "__pending", type: "horizontal", state: "rest",
          lines: [], bands: [], arcs: [], discs: [], polys: [], tags: [], texts: [], dots,
          hit: { lines: [], bands: [], points: [] },
        });
      }
    }

    this.cached = { key, shapes };
    return shapes;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /**
   * Prices of the live shapes go to the chart's own price axis. Horizontal lines
   * always tag the axis; the richer shapes only while selected, so the scale
   * never fills up with 24 labels.
   */
  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    const proj = this.projector();
    if (!proj) return [];
    const src = this.source;
    const selectedId = src.selectedId();
    const rows: string[] = [];
    const views: ISeriesPrimitiveAxisView[] = [];
    for (const d of src.drawings()) {
      if (d.visible === false) continue;
      const isKey = d.type === "horizontal" || d.type === "priceLabel" || d.id === selectedId;
      if (!isKey) continue;
      for (const t of axisPriceTags(d, src.fmtPrice)) {
        rows.push(`${d.id}:${t.price}:${t.text}`);
        views.push(new AxisTag(t.price, t.text, t.color, src, proj.yOf));
      }
    }
    const key = rows.join(",");
    if (key !== this.axisKey) {
      this.axisKey = key;
      this.axisViews = views;
    }
    return this.axisViews;
  }

  timeAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    const proj = this.projector();
    if (!proj) return [];
    const src = this.source;
    const rows: string[] = [];
    const views: ISeriesPrimitiveAxisView[] = [];
    for (const d of src.drawings()) {
      if (d.visible === false || d.type !== "vertical") continue;
      const p = d.points[0];
      if (!p) continue;
      const text = src.fmtTime(p.time);
      rows.push(`${d.id}:${p.time}:${text}`);
      views.push(new TimeTag(p.time, text, d.color, src, proj.xOf));
    }
    const key = rows.join(",");
    if (key !== this.timeKey) {
      this.timeKey = key;
      this.timeViews = views;
    }
    return this.timeViews;
  }

  /** Top-most shape under the cursor, or null. The chart turns the returned
   *  cursorStyle into the real mouse cursor and reports externalId on click. */
  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    if (!this.source.interactive()) return null;
    let best: PrimitiveHoveredItem | null = null;
    for (const shape of this.shapes()) {
      // Anchor shapes already carry an encoded hit id ("id|p2"); a plain shape
      // must be reported as a body hit, or parseHit finds no "|" and the press
      // that should move the drawing is discarded.
      const hitId = shape.id.includes("|") ? shape.id : hitBodyId(shape.id);
      for (const [px, py] of shape.hit.points) {
        const d = Math.hypot(x - px, y - py);
        if (d <= 7) {
          return { externalId: hitId, zOrder: "top", distance: d, hitTestPriority: 2, cursorStyle: "grab", itemType: "primitive" };
        }
      }
      for (const [bx, by, bw, bh] of shape.hit.bands) {
        if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
          return { externalId: hitId, zOrder: "top", distance: 0, hitTestPriority: 0, cursorStyle: "move", itemType: "primitive" };
        }
      }
      for (const [x1, y1, x2, y2] of shape.hit.lines) {
        const d = distToSegment(x, y, x1, y1, x2, y2);
        if (d <= 6 && (!best || d < (best.distance ?? Infinity))) {
          best = { externalId: hitId, zOrder: "top", distance: d, hitTestPriority: 1, cursorStyle: "move", itemType: "primitive" };
        }
      }
    }
    return best;
  }
}
