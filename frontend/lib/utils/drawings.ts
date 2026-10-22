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
  icon: string;
  label: string;
  /** Keyboard shortcut (lower-case). */
  key?: string;
  /** Clicks needed to place the shape (0 = not a placement tool). */
  points: number;
}

/** The toolbar and the keyboard map share this one definition list.
 *  F and R stay bound to fullscreen / reset view, so the tool letters avoid them. */
export const TOOLS: ToolDef[] = [
  { id: "crosshair", icon: "✛", label: "Cursor / Crosshair (V)", key: "v", points: 0 },
  { id: "horizontal", icon: "─", label: "Horizontal Line (H)", key: "h", points: 1 },
  { id: "vertical", icon: "│", label: "Vertical Line (B)", key: "b", points: 1 },
  { id: "trendline", icon: "╱", label: "Trend Line (T)", key: "t", points: 2 },
  { id: "ray", icon: "→", label: "Ray (J)", key: "j", points: 2 },
  { id: "fibonacci", icon: "ϝ", label: "Fibonacci Retracement (G)", key: "g", points: 2 },
  { id: "measure", icon: "⇔", label: "Measure (M)", key: "m", points: 2 },
  { id: "longPosition", icon: "▲", label: "Long Position (L)", key: "l", points: 3 },
  { id: "shortPosition", icon: "▼", label: "Short Position (K)", key: "k", points: 3 },
];

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

const TOOL_TYPE: Partial<Record<ChartTool, DrawingType>> = {
  horizontal: "horizontal",
  vertical: "vertical",
  trendline: "trendline",
  ray: "ray",
  fibonacci: "fibonacci",
  measure: "measure",
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
  trendline: "#e2e8f0",
  ray: "#38bdf8",
  fibonacci: "#f59e0b",
  measure: "#38bdf8",
  longPosition: "#10b981",
  shortPosition: "#f43f5e",
};

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
  return {
    id: newDrawingId(),
    type,
    symbol,
    points: completePoints(type, points),
    color: COLORS[type],
    visible: true,
    locked: false,
  };
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
