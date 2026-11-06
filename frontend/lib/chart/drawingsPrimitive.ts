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
 */
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { Drawing, DrawingPoint, DrawingType } from "@/lib/types";
import { FIB_LEVELS, positionMetrics } from "@/lib/utils/drawings";
import type { ChartPalette } from "./theme";

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

/** A theme keyword resolves at paint time, so parts of a shape that mean "green"
 *  rather than "#10b981" follow the theme. Anything else is a literal colour. */
export type ShapeColor = "up" | "down" | "text" | "muted" | "accent" | (string & {});

export function resolveColor(color: ShapeColor, p: ChartPalette): string {
  switch (color) {
    case "up": return p.up;
    case "down": return p.down;
    case "text": return p.text;
    case "muted": return p.labelText;
    case "accent": return p.accent;
    default: return color;
  }
}

export interface ShapeLine {
  x1: number; y1: number; x2: number; y2: number;
  color: ShapeColor;
  width: number;
  dash?: number[];
  alpha?: number;
}
export interface ShapeBand { x: number; y: number; w: number; h: number; color: ShapeColor; alpha: number }
export interface ShapeArc { cx: number; cy: number; r: number; startAngle: number; endAngle: number; color: ShapeColor; width: number; alpha?: number }
export interface ShapeTag { x: number; y: number; text: string; color: ShapeColor; align: "left" | "center" }
export interface ShapeDot { x: number; y: number; r: number; fill: string; stroke: string }

/** One annotation, already in CSS pixels relative to the pane's plot area. */
export interface Shape {
  /** Drawing id for a real shape, or a hit id for a synthetic one (a handle). */
  id: string;
  type: DrawingType;
  lines: ShapeLine[];
  bands: ShapeBand[];
  arcs: ShapeArc[];
  tags: ShapeTag[];
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

export interface ShapeStyle {
  color: ShapeColor;
  selected: boolean;
  hovered: boolean;
  ghost: boolean;
}

/** `toPrecision(4)` on a price difference without the exponent notation a bare
 *  `toPrecision` produces for the sub-cent values low-cap coins trade at. */
export function trimDiff(v: number): string {
  const s = v.toPrecision(4);
  if (!s.includes("e")) return s;
  const mag = Math.abs(v) > 0 ? Math.floor(Math.log10(Math.abs(v))) : 0;
  return v.toFixed(Math.min(12, Math.max(0, 3 - mag)));
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
 */
export function buildShape(d: Drawing, proj: Projector, style: ShapeStyle, fmtPrice: (p: number) => string): Shape | null {
  const [p1, p2, p3] = d.points;
  if (!p1) return null;
  const color = style.color;
  const width = (d.lineWidth ?? (style.selected ? 2.6 : style.hovered ? 2.0 : 1.6));
  const alpha = style.ghost ? 0.45 : 1;
  const dash = d.dash;
  const out: Shape = { id: d.id, type: d.type, lines: [], bands: [], arcs: [], tags: [], dots: [], hit: { lines: [], bands: [], points: [] } };

  const line = (x1: number, y1: number, x2: number, y2: number, opts?: { color?: ShapeColor; width?: number; dash?: number[] }) => {
    const l: ShapeLine = { x1, y1, x2, y2, color: opts?.color ?? color, width: opts?.width ?? width, dash: opts?.dash ?? dash, alpha };
    out.lines.push(l);
    out.hit.lines.push([x1, y1, x2, y2]);
  };

  const arc = (cx: number, cy: number, r: number, startAngle: number, endAngle: number, opts?: { color?: ShapeColor; width?: number }) => {
    const a: ShapeArc = { cx, cy, r, startAngle, endAngle, color: opts?.color ?? color, width: opts?.width ?? width, alpha };
    out.arcs.push(a);
    out.hit.lines.push([cx + r * Math.cos(startAngle), cy + r * Math.sin(startAngle), cx + r * Math.cos(endAngle), cy + r * Math.sin(endAngle)]);
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
    line(x, 0, x, proj.plotH, { dash: [4, 2] });
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
    line(x1, y1, ex, ey, { dash: d.type === "measure" ? [3, 3] : undefined });
    if (d.type === "measure") {
      const diff = p2.price - p1.price;
      const pct = p1.price !== 0 ? (diff / p1.price) * 100 : 0;
      const minutes = Math.round(Math.abs(p2.time - p1.time) / 60);
      const span = minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
      out.tags.push({
        x: (x1 + x2) / 2,
        y: (y1 + y2) / 2 - 12,
        text: `${diff >= 0 ? "+" : ""}${trimDiff(diff)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) · ${span}`,
        color: diff >= 0 ? "up" : "down",
        align: "center",
      });
    }
    return out;
  }

  if (d.type === "fibonacci" && p2) {
    const x1 = proj.xOf(p1.time), x2 = proj.xOf(p2.time);
    if (x1 == null || x2 == null) return null;
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2, left + 8);
    const rows: { lvl: number; price: number; y: number }[] = [];
    for (const lvl of FIB_LEVELS) {
      const price = p1.price + (p2.price - p1.price) * lvl;
      const y = proj.yOf(price);
      if (y != null) rows.push({ lvl, price, y });
    }
    if (rows.length === 0) return null;
    const ys = rows.map((r) => r.y);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    const boxH = Math.max(bottom - top, 8);
    out.bands.push({ x: left, y: top, w: right - left, h: boxH, color, alpha: style.hovered || style.selected ? 0.14 : 0.09 });
    out.hit.bands.push([left, top, right - left, boxH]);
    for (const r of rows) {
      out.lines.push({ x1: left, y1: r.y, x2: right, y2: r.y, color, width: r.lvl === 0 || r.lvl === 1 ? width + 0.3 : width * 0.9, alpha });
      out.hit.lines.push([left, r.y, right, r.y]);
      out.tags.push({ x: right + 6, y: r.y + 3, text: `${r.lvl.toFixed(3)}  ${fmtPrice(r.price)}`, color, align: "left" });
    }
    return out;
  }

  if (d.type === "fibExtension" && p2 && p3) {
    const x1 = proj.xOf(p1.time), x2 = proj.xOf(p2.time), x3 = proj.xOf(p3.time);
    if (x1 == null || x2 == null || x3 == null) return null;
    const left = Math.min(x1, x2, x3);
    const right = Math.max(x1, x2, x3, left + 8);
    const rows: { lvl: number; price: number; y: number }[] = [];
    const EXT_LEVELS = [1.618, 2.618, 4.236];
    for (const lvl of [...FIB_LEVELS, ...EXT_LEVELS]) {
      const price = p1.price + (p2.price - p1.price) * lvl;
      const y = proj.yOf(price);
      if (y != null) rows.push({ lvl, price, y });
    }
    if (rows.length === 0) return null;
    const ys = rows.map((r) => r.y);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    const boxH = Math.max(bottom - top, 8);
    out.bands.push({ x: left, y: top, w: right - left, h: boxH, color, alpha: style.hovered || style.selected ? 0.14 : 0.09 });
    out.hit.bands.push([left, top, right - left, boxH]);
    for (const r of rows) {
      const isExt = EXT_LEVELS.includes(r.lvl);
      out.lines.push({ x1: left, y1: r.y, x2: right, y2: r.y, color, width: r.lvl === 0 || r.lvl === 1 || isExt ? width + 0.3 : width * 0.9, dash: isExt ? [2, 2] : undefined, alpha });
      out.hit.lines.push([left, r.y, right, r.y]);
      out.tags.push({ x: right + 6, y: r.y + 3, text: `${r.lvl.toFixed(3)}  ${fmtPrice(r.price)}`, color, align: "left" });
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
    line(left, ey1, right, ey2, { dash: [6, 4] });
    line(x1, y1, x2, y2, { width: width * 1.6 });
    out.hit.lines.push([x1, y1, x2, y2]);
    out.hit.lines.push([left, ey1, right, ey2]);
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
    const shiftX = x3 - x1, shiftY = y3 - y1;
    const offset = nx * shiftX + ny * shiftY;
    const x1b = x1 + nx * offset, y1b = y1 + ny * offset;
    const x2b = x2 + nx * offset, y2b = y2 + ny * offset;
    line(x1, y1, x2, y2, { dash: [6, 3] });
    line(x1b, y1b, x2b, y2b, { dash: [6, 3] });
    line(x1, y1, x1b, y1b, { width: 1 });
    line(x2, y2, x2b, y2b, { width: 1 });
    out.hit.lines.push([x1, y1, x2, y2]);
    out.hit.lines.push([x1b, y1b, x2b, y2b]);
    out.hit.bands.push([Math.min(x1,x2,x1b,x2b)-4, Math.min(y1,y2,y1b,y2b)-4, Math.abs(x2-x1)+8, Math.abs(y2-y1)+8]);
    return out;
  }

  if (d.type === "rectangle" && p2) {
    const x1 = proj.xOf(p1.time), y1 = proj.yOf(p1.price);
    const x2 = proj.xOf(p2.time), y2 = proj.yOf(p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
    const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
    const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    if (rw < 2 && rh < 2) return null;
    out.bands.push({ x: rx, y: ry, w: rw, h: rh, color, alpha: style.hovered || style.selected ? 0.16 : 0.1 });
    out.hit.bands.push([rx, ry, rw, rh]);
    line(rx, ry, rx + rw, ry);
    line(rx + rw, ry, rx + rw, ry + rh);
    line(rx + rw, ry + rh, rx, ry + rh);
    line(rx, ry + rh, rx, ry);
    return out;
  }

  if (d.type === "circle" && p2) {
    const x1 = proj.xOf(p1.time), y1 = proj.yOf(p1.price);
    const x2 = proj.xOf(p2.time), y2 = proj.yOf(p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
    const r = Math.hypot(x2 - x1, y2 - y1);
    if (r < 2) return null;
    out.arcs.push({ cx: x1, cy: y1, r, startAngle: 0, endAngle: Math.PI * 2, color, width, alpha });
    out.hit.bands.push([x1 - r - 4, y1 - r - 4, r * 2 + 8, r * 2 + 8]);
    out.hit.lines.push([x1 + r, y1, x1 - r, y1]);
    return out;
  }

  if (d.type === "priceLabel" && p1) {
    const y = proj.yOf(p1.price);
    if (y == null) return null;
    const x = proj.xOf(p1.time);
    const px = x ?? 0;
    const text = d.text || fmtPrice(p1.price);
    out.tags.push({ x: px + 8, y: y - 4, text, color, align: "left" });
    line(px, y, Math.min(px + 36, proj.plotW), y, { width: 1.6 });
    out.hit.bands.push([px - 2, y - 6, 80, 12]);
    out.hit.lines.push([px, y, Math.min(px + 36, proj.plotW), y]);
    return out;
  }

  if (d.type === "text" && p1) {
    const x = proj.xOf(p1.time), y = proj.yOf(p1.price);
    if (x == null || y == null) return null;
    const text = d.text || "Text";
    out.tags.push({ x: x + 6, y: y - 4, text, color, align: "left" });
    out.hit.bands.push([x - 2, y - 14, 220, 24]);
    return out;
  }

  if (d.type === "arrow" && p2) {
    const x1 = proj.xOf(p1.time), y1 = proj.yOf(p1.price);
    const x2 = proj.xOf(p2.time), y2 = proj.yOf(p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const arrowLen = Math.min(14, len * 0.35);
    const bx = x2 - ux * arrowLen, by = y2 - uy * arrowLen;
    const px = -uy, py = ux;
    line(x1, y1, x2, y2, { width: width * 1.6 });
    line(bx + px * 4, by + py * 4, x2, y2);
    line(bx - px * 4, by - py * 4, x2, y2);
    out.hit.lines.push([x1, y1, x2, y2]);
    out.hit.bands.push([Math.min(x1,x2)-4, Math.min(y1,y2)-4, Math.abs(x2-x1)+8, Math.abs(y2-y1)+8]);
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
    const strong = style.hovered || style.selected ? 0.24 : 0.16;
    out.bands.push({ x: left, y: Math.min(yEntry, yTarget), w: right - left, h: hProfit, color: profit, alpha: strong });
    out.bands.push({ x: left, y: Math.min(yEntry, yStop), w: right - left, h: hLoss, color: loss, alpha: strong });
    out.hit.bands.push([left, Math.min(yEntry, yTarget, yStop), right - left, Math.max(hProfit, hLoss)]);
    line(left, yEntry, right, yEntry, { color: "text" });
    line(left, yTarget, right, yTarget, { color: profit, width: 1 });
    line(left, yStop, right, yStop, { color: loss, width: 1 });
    out.tags.push({
      x: left + 6,
      y: Math.min(yEntry, yTarget, yStop) - 6,
      text: `${isLong ? "LONG" : "SHORT"}  risk ${m.riskPct.toFixed(2)}%  reward ${m.rewardPct.toFixed(2)}%  R:R ${m.rr == null ? "—" : `1:${m.rr.toFixed(2)}`}`,
      color: "text",
      align: "left",
    });
    return out;
  }

  return null;
}

/** Every price a shape wants on the chart's price axis, in draw order. */
export function axisPriceTags(d: Drawing, fmtPrice: (p: number) => string): { price: number; text: string; color: ShapeColor }[] {
  const p1 = d.points[0];
  if (!p1) return [];
  if (d.type === "horizontal") return [{ price: p1.price, text: fmtPrice(p1.price), color: d.color }];
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

const TAG_FONT_PX = 10;

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

      for (const s of shapes) {
        for (const b of s.bands) {
          ctx.globalAlpha = b.alpha * 0.85;
          ctx.fillStyle = resolveColor(b.color, palette);
          ctx.fillRect(b.x, b.y, b.w, b.h);
        }
      }
      for (const s of shapes) {
        for (const a of s.arcs) {
          ctx.globalAlpha = a.alpha ?? 1;
          ctx.strokeStyle = resolveColor(a.color, palette);
          ctx.lineWidth = a.width;
          ctx.beginPath();
          ctx.arc(a.cx, a.cy, a.r, a.startAngle, a.endAngle);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      for (const s of shapes) {
        for (const l of s.lines) {
          ctx.globalAlpha = l.alpha ?? 1;
          ctx.strokeStyle = resolveColor(l.color, palette);
          ctx.lineWidth = l.width;
          ctx.setLineDash(l.dash ?? []);
          ctx.beginPath();
          ctx.moveTo(l.x1 + 0.5, l.y1 + 0.5);
          ctx.lineTo(l.x2 + 0.5, l.y2 + 0.5);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      this.paintTags(ctx, shapes, palette);
      for (const s of shapes) {
        for (const dot of s.dots) {
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
          ctx.fillStyle = dot.fill;
          ctx.fill();
          ctx.strokeStyle = palette.selection;
          ctx.lineWidth = 1.8;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    });
  }

  /** Text chips inside the plot (fib levels, measure readout, position summary),
   *  painted with the chart's own font so they read as chart text. */
  private paintTags(ctx: CanvasRenderingContext2D, shapes: readonly Shape[], palette: ChartPalette): void {
    ctx.font = `${TAG_FONT_PX}px ${palette.fontFamily}`;
    ctx.textBaseline = "alphabetic";
    const padX = 4;
    const h = TAG_FONT_PX + 5;
    for (const s of shapes) {
      for (const tag of s.tags) {
        const w = ctx.measureText(tag.text).width + padX * 2;
        const left = tag.align === "center" ? tag.x - w / 2 : tag.x;
        ctx.globalAlpha = 0.96;
        ctx.fillStyle = palette.labelBg;
        ctx.beginPath();
        ctx.roundRect(left, tag.y - h + 4, w, h, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = resolveColor(tag.color, palette);
        ctx.fillText(tag.text, left + padX, tag.y);
      }
    }
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
  textColor(): string { return resolveColor(this.color, this.src.palette()); }
  backColor(): string { return this.src.palette().labelBg; }
  visible(): boolean { return this.yOf(this.price) != null; }
}

class TimeTag implements ISeriesPrimitiveAxisView {
  constructor(
    private readonly time: number,
    private readonly label: string,
    private readonly src: DrawingsSource,
    private readonly xOf: (t: number) => number | null,
  ) {}
  coordinate(): number { return this.xOf(this.time) ?? -1e6; }
  text(): string { return this.label; }
  textColor(): string { return this.src.palette().bg; }
  backColor(): string { return this.src.palette().selection; }
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
    readonly source: DrawingsSource,
  ) {
    const self = this;
    this.views = [{ renderer: () => new DrawingsRenderer(self) }];
  }

  attached(params: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = params.chart as unknown as IChartApi;
    this.series = params.series;
    this.requestUpdate = params.requestUpdate;
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
    return {
      xOf: (t) => { const v = ts.timeToCoordinate(t as Time); return v == null ? null : v; },
      yOf: (p) => { const v = series.priceToCoordinate(p); return v == null ? null : v; },
      plotW: ts.width(),
      plotH: this.paneHeight(chart),
    };
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
    let time = ts.coordinateToTime(x);
    if (typeof time !== "number") {
      // Extrapolate beyond candle range using visible range
      const range = ts.getVisibleRange();
      const lr = ts.getVisibleLogicalRange();
      if (range && lr && typeof lr.from === "number" && typeof lr.to === "number") {
        const t1 = typeof range.from === "number" ? range.from : Number(range.from);
        const t2 = typeof range.to === "number" ? range.to : Number(range.to);
        const ratio = (x - ts.width() * 0) / ts.width();
        // Better: use logical range
        const span = t2 - t1;
        const lspan = lr.to - lr.from;
        if (lspan > 0 && span > 0) {
          const logicalPos = lr.from + (x / ts.width()) * lspan;
          time = Math.round(t1 + (logicalPos - lr.from) / lspan * span) as Time;
        }
      }
    }
    if (typeof time !== "number" || !Number.isFinite(time)) return null;
    const zero = series.priceToCoordinate(0);
    const price = series.coordinateToPrice(zero != null && y > zero - 2 ? zero - 2 : y);
    if (price == null) return null;
    return { time, price: Number(price) };
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

    const palette = src.palette();
    const shapes: Shape[] = [];
    for (const d of drawings) {
      if (d.visible === false) continue;
      const s = buildShape(d, proj, {
        color: d.color,
        selected: d.id === selectedId,
        hovered: d.id === hoverId,
        ghost: false,
      }, src.fmtPrice);
      if (s) shapes.push(s);
    }
    const ghost = src.ghost();
    if (ghost) {
      const s = buildShape(ghost, proj, { color: ghost.color, selected: false, hovered: false, ghost: true }, src.fmtPrice);
      if (s) shapes.push(s);
    }

    const selected = interactive ? drawings.find((d) => d.id === selectedId && d.visible !== false) : undefined;
    if (selected && !selected.locked) {
      // One synthetic shape per handle: the hit id carries the anchor index, which
      // is what tells a drag "move point 2" from "move the whole body".
      selected.points.forEach((p, i) => {
        const xy = this.project(p);
        if (!xy) return;
        shapes.push({
          id: hitPointId(selected.id, i),
          type: selected.type,
          lines: [],
          bands: [],
          tags: [],
          arcs: [],
          dots: [{ x: xy.x, y: xy.y, r: 5, fill: palette.labelBg, stroke: palette.selection }],
          hit: { lines: [], bands: [], points: [[xy.x, xy.y]] },
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
        if (xy) dots.push({ x: xy.x, y: xy.y, r: 3.5, fill: palette.labelBg, stroke: palette.selection });
      }
      if (dots.length) {
        shapes.push({ id: "__pending", type: "horizontal", lines: [], bands: [], arcs: [], tags: [], dots, hit: { lines: [], bands: [], points: [] } });
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
      const isKey = d.type === "horizontal" || d.id === selectedId;
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
      views.push(new TimeTag(p.time, text, src, proj.xOf));
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
      for (const [px, py] of shape.hit.points) {
        const d = Math.hypot(x - px, y - py);
        if (d <= 7) {
          return { externalId: shape.id, zOrder: "top", distance: d, hitTestPriority: 2, cursorStyle: "grab", itemType: "primitive" };
        }
      }
      for (const [bx, by, bw, bh] of shape.hit.bands) {
        if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
          return { externalId: shape.id, zOrder: "top", distance: 0, hitTestPriority: 0, cursorStyle: "move", itemType: "primitive" };
        }
      }
      for (const [x1, y1, x2, y2] of shape.hit.lines) {
        const d = distToSegment(x, y, x1, y1, x2, y2);
        if (d <= 6 && (!best || d < (best.distance ?? Infinity))) {
          best = { externalId: shape.id, zOrder: "top", distance: d, hitTestPriority: 1, cursorStyle: "move", itemType: "primitive" };
        }
      }
    }
    return best;
  }
}
