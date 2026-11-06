import type { ChartTool, Drawing, DrawingPoint, DrawingType } from "@/lib/types";

let seq = 0;
/** Collision-free id: a base-36 timestamp alone repeats for shapes created in
 *  the same millisecond, so a per-session monotonic counter is appended. */
export function newDrawingId(): string {
  return `d-${Date.now().toString(36)}-${++seq}`;
}

/** Standard retracement grid. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export interface ToolDef {
  id: ChartTool;
  label: string;
  /** Keyboard shortcut (lower-case). */
  key?: string;
  /** Clicks needed to place the shape (0 = not a placement tool). */
  points: number;
  /** Rail grouping: tools sharing a family sit under one flyout. */
  group: "cursor" | "line" | "analysis" | "risk";
  /** One-line "how do I actually use this", shown in the tooltip and the label
   *  that follows the cursor. Without it the rail is a row of guessing icons. */
  hint: string;
}

/** The toolbar and the keyboard map share this one definition list.
 *  F and R stay bound to fullscreen / reset view, so the tool letters avoid them. */
export const TOOLS: ToolDef[] = [
  { id: "crosshair", label: "Cursor", key: "v", points: 0, group: "cursor", hint: "Select, move and edit drawings" },
  { id: "horizontal", label: "Horizontal line", key: "h", points: 1, group: "line", hint: "Click once at a price" },
  { id: "vertical", label: "Vertical line", key: "b", points: 1, group: "line", hint: "Click once at a time" },
  { id: "trendline", label: "Trend line", key: "t", points: 2, group: "line", hint: "Click the start, then the end" },
  { id: "extendedLine", label: "Extended line", key: "e", points: 2, group: "line", hint: "Click start, then end — extends both ways" },
  { id: "ray", label: "Ray", key: "j", points: 2, group: "line", hint: "Click the origin, then a direction" },
  { id: "parallelChannel", label: "Parallel line", key: "p", points: 3, group: "line", hint: "Click line 1 start, line 1 end, then a point on line 2" },
  { id: "fibonacci", label: "Fib Retracement", key: "g", points: 2, group: "analysis", hint: "Click the swing low, then the swing high" },
  { id: "fibExtension", label: "Fib Extension", key: "x", points: 3, group: "analysis", hint: "Click swing low, swing high, then extension point" },
  { id: "measure", label: "Measure", key: "m", points: 2, group: "analysis", hint: "Click the start, then the end" },
  { id: "rectangle", label: "Rectangle", key: "r", points: 2, group: "analysis", hint: "Click one corner, then the opposite corner" },
  { id: "circle", label: "Circle", key: "c", points: 2, group: "analysis", hint: "Click centre, then a point on the circumference" },
  { id: "text", label: "Text", key: "n", points: 1, group: "analysis", hint: "Click to place a text label" },
  { id: "arrow", label: "Arrow", key: "a", points: 2, group: "analysis", hint: "Click start, then tip of the arrow" },
  { id: "priceLabel", label: "Price label", key: "d", points: 1, group: "analysis", hint: "Click once at a price" },
  { id: "longPosition", label: "Long position", key: "l", points: 3, group: "risk", hint: "Click entry, then take-profit, then stop-loss" },
  { id: "shortPosition", label: "Short position", key: "k", points: 3, group: "risk", hint: "Click entry, then take-profit, then stop-loss" },
];

export const TOOL_BY_ID: Record<ChartTool, ToolDef> = Object.fromEntries(
  TOOLS.map((t) => [t.id, t]),
) as Record<ChartTool, ToolDef>;

/** Rail families, in display order. Each one is a flyout of labelled tools, so
 *  the rail stays four buttons wide instead of nine unlabeled glyphs. */
export const TOOL_GROUPS: { id: ToolDef["group"]; label: string }[] = [
  { id: "cursor", label: "Cursor" },
  { id: "line", label: "Lines" },
  { id: "analysis", label: "Analysis" },
  { id: "risk", label: "Positions" },
];

export function toolsInGroup(group: ToolDef["group"]): ToolDef[] {
  return TOOLS.filter((t) => t.group === group);
}

/** Tool ids keyed by their shortcut letter, shared by the rail and the help. */
export const TOOL_BY_KEY: Record<string, ChartTool> = Object.fromEntries(
  TOOLS.filter((t) => t.key).map((t) => [t.key as string, t.id]),
);

const PLACEMENT_TOOLS = new Map<ChartTool, number>(TOOLS.map((t) => [t.id, t.points]));

/** True for tools that drop geometry on click; crosshair (0 points) is excluded
 *  so the cursor keeps normal pan/select behavior instead of a place gesture. */
export function isPlacementTool(tool: ChartTool): boolean {
  return (PLACEMENT_TOOLS.get(tool) ?? 0) > 0;
}

/** Number of clicks a drawing tool needs to complete a shape. */
export function pointsRequired(tool: ChartTool): number {
  return PLACEMENT_TOOLS.get(tool) ?? 0;
}

/** Human label for a drawing type (the drawings list and the tool hint). */
export const TYPE_LABEL: Record<DrawingType, string> = {
  horizontal: "Horizontal line",
  vertical: "Vertical line",
  trendline: "Trend line",
  ray: "Ray",
  extendedLine: "Extended line",
  parallelChannel: "Parallel line",
  fibonacci: "Fib retracement",
  fibExtension: "Fib extension",
  measure: "Measure",
  rectangle: "Rectangle",
  circle: "Circle",
  text: "Text",
  arrow: "Arrow",
  priceLabel: "Price label",
  longPosition: "Long position",
  shortPosition: "Short position",
};

/** What the armed tool expects right now, worded as an instruction: "Click the
 *  2nd point" says where to click, a click countdown does not. Empty string when
 *  the tool needs no clicks, so the caller can hide the label. */
export function toolHint(tool: ChartTool, placed: number): string {
  const need = pointsRequired(tool);
  if (need === 0) return "";
  if (placed <= 0) return TOOL_BY_ID[tool]?.hint ?? "Click the chart";
  const left = need - placed;
  if (left <= 0) return "Click to finish · Esc to cancel";
  return `Click the ${ordinal(placed + 1)} point · Esc to cancel`;
}

/** 1st / 2nd / 3rd, everything else "Nth" — the position tools reach the third
 *  point, and "3th" is the kind of detail that makes a tool feel unfinished. */
function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

const TOOL_TYPE: Partial<Record<ChartTool, DrawingType>> = {
  horizontal: "horizontal",
  vertical: "vertical",
  trendline: "trendline",
  ray: "ray",
  extendedLine: "extendedLine",
  parallelChannel: "parallelChannel",
  fibonacci: "fibonacci",
  fibExtension: "fibExtension",
  measure: "measure",
  rectangle: "rectangle",
  circle: "circle",
  text: "text",
  arrow: "arrow",
  priceLabel: "priceLabel",
  longPosition: "longPosition",
  shortPosition: "shortPosition",
};

/** Maps a toolbar tool to its drawing type. null for crosshair, which has no
 *  geometry, so callers must guard before creating a shape. */
export function drawingTypeForTool(tool: ChartTool): DrawingType | null {
  return TOOL_TYPE[tool] ?? null;
}

export const COLORS: Record<DrawingType, string> = {
  horizontal: "#f59e0b",
  vertical: "#8b5cf6",
  // Not #e2e8f0: a near-white trendline was invisible on the light theme, which
  // made trendlines look broken there. This grey has contrast in both.
  trendline: "#8f9bb3",
  ray: "#38bdf8",
  extendedLine: "#8f9bb3",
  parallelChannel: "#38bdf8",
  fibonacci: "#f59e0b",
  fibExtension: "#f59e0b",
  measure: "#38bdf8",
  rectangle: "#8b5cf6",
  circle: "#8b5cf6",
  text: "#f59e0b",
  arrow: "#38bdf8",
  priceLabel: "#f59e0b",
  longPosition: "#10b981",
  shortPosition: "#f43f5e",
};

/** Swatches offered on the selected shape. Small set on purpose: recoloring is
 *  a quick tidy-up, not a paint app, and every extra swatch costs toolbar width. */
export const PALETTE = ["#8f9bb3", "#f59e0b", "#38bdf8", "#10b981", "#f43f5e", "#8b5cf6"];

/**
 * Third click of a position tool: mirror the risk distance so the shape is
 * usable immediately, then the user drags the take-profit edge.
 */
function completePoints(type: DrawingType, points: DrawingPoint[]): DrawingPoint[] {
  if (type !== "longPosition" && type !== "shortPosition") return points;
  if (points.length >= 3) return points.slice(0, 3);
  const [entry, tp] = points;
  if (!entry || !tp) return points;
  const risk = entry.price - tp.price;
  const sl = { time: tp.time, price: entry.price + risk };
  return [entry, tp, sl];
}

/** Builds a persisted Drawing: stamps the owning symbol, picks the type's color,
 *  and runs points through completePoints so a 2-click position still gets its
 *  derived stop-loss anchor. */
export function makeDrawing(symbol: string, type: DrawingType, points: DrawingPoint[]): Drawing {
  const d: Drawing = {
    id: newDrawingId(),
    type,
    symbol,
    points: completePoints(type, points),
    color: COLORS[type],
    visible: true,
    locked: false,
  };
  // Text and arrow carry a label — default to empty so the shape is still
  // editable after creation.
  if (type === "text" || type === "arrow" || type === "priceLabel") d.text = "";
  return d;
}

/** Tool-aware wrapper around makeDrawing: returns null for crosshair so the
 *  chart can call it for any finished gesture without pre-checking the tool. */
export function drawingForTool(symbol: string, tool: ChartTool, points: DrawingPoint[]): Drawing | null {
  const type = drawingTypeForTool(tool);
  if (!type) return null;
  return makeDrawing(symbol, type, points);
}

export interface PositionMetrics {
  isLong: boolean;
  entry: number;
  stop: number;
  target: number;
  risk: number;
  reward: number;
  /** Reward per unit of risk; 0 risk yields null. */
  rr: number | null;
  riskPct: number;
  rewardPct: number;
}

/** Pure arithmetic for the long/short risk-reward tool — no order execution. */
export function positionMetrics(points: DrawingPoint[]): PositionMetrics | null {
  const [entry, target, stop] = points;
  if (!entry || !target || !stop) return null;
  const risk = Math.abs(entry.price - stop.price);
  const reward = Math.abs(target.price - entry.price);
  const isLong = target.price >= stop.price;
  return {
    isLong,
    entry: entry.price,
    stop: stop.price,
    target: target.price,
    risk,
    reward,
    rr: risk > 0 ? reward / risk : null,
    riskPct: entry.price > 0 ? (risk / entry.price) * 100 : 0,
    rewardPct: entry.price > 0 ? (reward / entry.price) * 100 : 0,
  };
}
