import { create } from "zustand";
import type { Timeframe, ChartType, IndicatorConfig, Drawing, DrawingPoint, ChartTool, ChartSettings } from "@/lib/types";
import { loadPersisted, persist, isRecord } from "@/lib/store/persist";
import { TIMEFRAMES } from "@/lib/utils/klines";
import { COLORS } from "@/lib/utils/drawings";

/** One undo step: the whole drawing list of one symbol. */
interface Snapshot { symbol: string; list: Drawing[] }

interface ChartState {
  timeframe: Timeframe;
  chartType: ChartType;
  indicators: IndicatorConfig[];
  /** symbol -> drawings (persisted, so annotations survive reloads). */
  drawingsBySymbol: Record<string, Drawing[]>;
  past: Snapshot[];
  future: Snapshot[];
  selectedId: string | null;
  crosshairData: { time: number; open: number; high: number; low: number; close: number; volume: number; changePct: number | null } | null;
  activeTool: ChartTool;
  /** Keeps a placement tool armed after a shape finishes (double-click the rail
   *  button). Off by default: the familiar behaviour is finish -> the new shape
   *  is handed to the cursor with its handles showing. */
  stickyTool: boolean;
  settings: ChartSettings;
  fullscreen: boolean;

  setTimeframe: (tf: Timeframe) => void;
  setChartType: (ct: ChartType) => void;
  toggleIndicator: (id: string) => void;
  addIndicator: (ind: IndicatorConfig) => void;
  updateIndicator: (id: string, patch: Partial<IndicatorConfig>) => void;
  removeIndicator: (id: string) => void;
  setCrosshairData: (d: ChartState["crosshairData"]) => void;
  setActiveTool: (t: ChartTool, sticky?: boolean) => void;
  setStickyTool: (sticky: boolean) => void;
  setFullscreen: (f: boolean) => void;
  updateSettings: (partial: Partial<ChartSettings>) => void;
  selectDrawing: (id: string | null) => void;
  beginDrawingHistory: (symbol: string) => void;
  addDrawing: (symbol: string, d: Drawing) => void;
  updateDrawingPoints: (symbol: string, id: string, points: DrawingPoint[]) => void;
  updateDrawing: (symbol: string, id: string, patch: Partial<Drawing>) => void;
  duplicateDrawing: (symbol: string, id: string) => void;
  removeDrawing: (symbol: string, id: string) => void;
  clearDrawings: (symbol: string) => void;
  undoDrawings: () => void;
  redoDrawings: () => void;
}

/** A cached value we can't type-check is worse than no cache: it reaches code
 *  that assumes arrays and shapes, and the resulting render exception bricks
 *  every reload. These guards keep the usable part of a blob and drop the rest. */

const INDICATOR_TYPES = new Set<IndicatorConfig["type"]>(["sma", "ema", "rsi", "macd", "bb", "vol"]);
const CHART_TYPES = new Set<ChartType>(["candlestick", "line", "area"]);
const DRAWING_TYPES = new Set<Drawing["type"]>([
  "horizontal", "vertical", "trendline", "ray", "fibonacci", "measure", "longPosition", "shortPosition",
]);
const TF_SET = new Set<string>(TIMEFRAMES);

/** Default period per type, used only when a cached indicator lost its own. */
function defaultPeriod(type: IndicatorConfig["type"]): number {
  if (type === "rsi") return 14;
  if (type === "ema") return 50;
  return 20;
}

/** Kept: `type` picks the series and `id` keys every later update, so an item
 *  missing either cannot be rendered or toggled. */
export function sanitizeIndicators(value: unknown): IndicatorConfig[] {
  if (!Array.isArray(value)) return DEFAULT_INDICATORS;
  const out: IndicatorConfig[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) continue;
    const type = item.type;
    if (typeof type !== "string" || !INDICATOR_TYPES.has(type as IndicatorConfig["type"])) continue;
    if (out.some((i) => i.id === item.id)) continue;
    const period = typeof item.period === "number" && Number.isFinite(item.period) && item.period > 0
      ? Math.round(item.period)
      : defaultPeriod(type as IndicatorConfig["type"]);
    out.push({
      id: item.id,
      type: type as IndicatorConfig["type"],
      period,
      visible: item.visible !== false,
      ...(typeof item.color === "string" && item.color ? { color: item.color } : {}),
    });
  }
  return out;
}

function isDrawingPoint(value: unknown): value is DrawingPoint {
  if (!isRecord(value)) return false;
  const { time, price } = value;
  return (typeof time === "number" && Number.isFinite(time)) && (typeof price === "number" && Number.isFinite(price));
}

function asDrawing(value: unknown, symbol: string): Drawing | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  const type = value.type;
  if (typeof type !== "string" || !DRAWING_TYPES.has(type as Drawing["type"])) return null;
  if (typeof value.symbol === "string" && value.symbol !== symbol) return null;
  if (!Array.isArray(value.points)) return null;
  const points = value.points.filter(isDrawingPoint);
  if (points.length < 1) return null;
  return {
    id: value.id,
    type: type as Drawing["type"],
    symbol,
    points,
    color: typeof value.color === "string" && value.color ? value.color : COLORS[type as Drawing["type"]],
    ...(typeof value.locked === "boolean" ? { locked: value.locked } : {}),
    ...(typeof value.visible === "boolean" ? { visible: value.visible } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.fontSize === "number" && Number.isFinite(value.fontSize) ? { fontSize: value.fontSize } : {}),
    ...(typeof value.lineWidth === "number" && Number.isFinite(value.lineWidth) ? { lineWidth: value.lineWidth } : {}),
    ...(Array.isArray(value.dash) ? { dash: value.dash.filter((n) => typeof n === "number") } : {}),
    ...(typeof value.fillOpacity === "number" && Number.isFinite(value.fillOpacity) ? { fillOpacity: value.fillOpacity } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
  };
}

/** A wrong-shaped blob (older build, hand-edited, half-written) loses the
 *  affected entries instead of the whole annotation layer. */
export function sanitizeDrawings(value: unknown): Record<string, Drawing[]> {
  if (!isRecord(value)) return {};
  const out: Record<string, Drawing[]> = {};
  for (const [symbol, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    const kept: Drawing[] = [];
    for (const item of list) {
      const d = asDrawing(item, symbol);
      if (d && !kept.some((k) => k.id === d.id)) kept.push(d);
    }
    if (kept.length) out[symbol] = kept;
  }
  return out;
}

export function sanitizeSettings(value: unknown): ChartSettings {
  const base: ChartSettings = { ...DEFAULT_SETTINGS };
  if (!isRecord(value)) return base;
  for (const key of ["showGrid", "showVolume", "showDrawings", "showIndicators", "autoScale"] as const) {
    if (typeof value[key] === "boolean") base[key] = value[key] as boolean;
  }
  if (typeof value.chartType === "string" && CHART_TYPES.has(value.chartType as ChartType)) {
    base.chartType = value.chartType as ChartType;
  }
  return base;
}

let drawingsWrite: ReturnType<typeof setTimeout> | undefined;
/**
 * Drawings live in one localStorage blob, so a write costs a full JSON dump —
 * and dragging an anchor fires one per frame. The in-memory store stays
 * synchronous; only the disk write is deferred to the end of the gesture.
 */
function persistDrawings(value: Record<string, Drawing[]>) {
  if (typeof window === "undefined") return;
  clearTimeout(drawingsWrite);
  drawingsWrite = setTimeout(() => persist("ct_drawings", value), 150);
}

const MAX_HISTORY = 50;
const MAX_PER_SYMBOL = 300;

const DEFAULT_INDICATORS: IndicatorConfig[] = [
  { id: "sma20", type: "sma", period: 20, visible: true, color: "#f59e0b" },
  { id: "ema50", type: "ema", period: 50, visible: false, color: "#8b5cf6" },
];

const DEFAULT_SETTINGS: ChartSettings = {
  chartType: "candlestick",
  showGrid: true,
  showVolume: true,
  showDrawings: true,
  showIndicators: true,
  autoScale: true,
};

export const useChartStore = create<ChartState>((set, get) => ({
  timeframe: loadPersisted<Timeframe>("ct_tf", "1m", (v): v is Timeframe => typeof v === "string" && TF_SET.has(v)),
  chartType: loadPersisted<ChartType>("ct_ct", "candlestick", (v): v is ChartType => typeof v === "string" && CHART_TYPES.has(v as ChartType)),
  indicators: sanitizeIndicators(loadPersisted<unknown>("ct_inds", DEFAULT_INDICATORS)),
  drawingsBySymbol: sanitizeDrawings(loadPersisted<unknown>("ct_drawings", {})),
  past: [],
  future: [],
  selectedId: null,
  crosshairData: null,
  activeTool: "crosshair",
  stickyTool: false,
  fullscreen: false,
  settings: sanitizeSettings(loadPersisted<unknown>("ct_settings", DEFAULT_SETTINGS)),

  setTimeframe: (timeframe) => { persist("ct_tf", timeframe); set({ timeframe }); },
  setChartType: (chartType) => { persist("ct_ct", chartType); set((s) => ({ chartType, settings: { ...s.settings, chartType } })); },

  toggleIndicator: (id) =>
    set((s) => {
      const indicators = s.indicators.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i));
      persist("ct_inds", indicators);
      return { indicators };
    }),
  addIndicator: (ind) => set((s) => { const indicators = [...s.indicators, ind]; persist("ct_inds", indicators); return { indicators }; }),
  updateIndicator: (id, patch) =>
    set((s) => {
      const indicators = s.indicators.map((i) => (i.id === id ? { ...i, ...patch } : i));
      persist("ct_inds", indicators);
      return { indicators };
    }),
  removeIndicator: (id) =>
    set((s) => {
      const indicators = s.indicators.filter((i) => i.id !== id);
      persist("ct_inds", indicators);
      return { indicators };
    }),

  /**
   * Publishes the hovered OHLC. Called on every crosshair move — far more
   * often than the hovered bar (or its values) actually changes, so an
   * identical payload is dropped instead of re-rendering the legend.
   */
  setCrosshairData: (crosshairData) => {
    const cur = get().crosshairData;
    if (cur === crosshairData || (!cur && !crosshairData)) return;
    if (
      cur && crosshairData &&
      cur.time === crosshairData.time && cur.open === crosshairData.open &&
      cur.high === crosshairData.high && cur.low === crosshairData.low &&
      cur.close === crosshairData.close && cur.volume === crosshairData.volume &&
      cur.changePct === crosshairData.changePct
    ) return;
    set({ crosshairData });
  },
  setActiveTool: (activeTool, sticky = false) =>
    set({ activeTool, selectedId: null, stickyTool: activeTool !== "crosshair" && sticky }),
  setStickyTool: (stickyTool) => set({ stickyTool }),
  setFullscreen: (fullscreen) => set({ fullscreen }),
  updateSettings: (partial) =>
    set((s) => {
      const settings = { ...s.settings, ...partial };
      persist("ct_settings", settings);
      return { settings };
    }),

  selectDrawing: (selectedId) => set({ selectedId }),

  /** Snapshot the current list so a drag (many point updates) is one undo step. */
  beginDrawingHistory: (symbol) =>
    set((s) => ({ past: [...s.past, { symbol, list: s.drawingsBySymbol[symbol] ?? [] }].slice(-MAX_HISTORY), future: [] })),

  addDrawing: (symbol, d) =>
    set((s) => {
      const cur = s.drawingsBySymbol[symbol] ?? [];
      const next = [...cur, d].slice(-MAX_PER_SYMBOL);
      persistDrawings({ ...s.drawingsBySymbol, [symbol]: next });
      return {
        drawingsBySymbol: { ...s.drawingsBySymbol, [symbol]: next },
        past: [...s.past, { symbol, list: cur }].slice(-MAX_HISTORY),
        future: [],
        selectedId: d.id,
      };
    }),

  updateDrawingPoints: (symbol, id, points) =>
    set((s) => {
      const cur = s.drawingsBySymbol[symbol];
      if (!cur) return {};
      const target = cur.find((d) => d.id === id);
      if (!target || target.locked) return {};
      const next = cur.map((d) => (d.id === id ? { ...d, points } : d));
      persistDrawings({ ...s.drawingsBySymbol, [symbol]: next });
      return { drawingsBySymbol: { ...s.drawingsBySymbol, [symbol]: next } };
    }),

  updateDrawing: (symbol, id, patch) =>
    set((s) => {
      const cur = s.drawingsBySymbol[symbol];
      if (!cur) return {};
      const next = cur.map((d) => (d.id === id ? { ...d, ...patch } : d));
      persistDrawings({ ...s.drawingsBySymbol, [symbol]: next });
      return { drawingsBySymbol: { ...s.drawingsBySymbol, [symbol]: next } };
    }),

  /** Duplicate a drawing with a new id, keeping its geometry and colour. */
  duplicateDrawing: (symbol, id) =>
    set((s) => {
      const cur = s.drawingsBySymbol[symbol] ?? [];
      const src = cur.find((d) => d.id === id);
      if (!src) return {};
      const copy = { ...src, id: `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` };
      const next = [...cur, copy].slice(-MAX_PER_SYMBOL);
      persistDrawings({ ...s.drawingsBySymbol, [symbol]: next });
      return {
        drawingsBySymbol: { ...s.drawingsBySymbol, [symbol]: next },
        past: [...s.past, { symbol, list: cur }].slice(-MAX_HISTORY),
        future: [],
        selectedId: copy.id,
      };
    }),

  removeDrawing: (symbol, id) =>
    set((s) => {
      const cur = s.drawingsBySymbol[symbol] ?? [];
      const next = cur.filter((d) => d.id !== id);
      if (next.length === cur.length) return {};
      persistDrawings({ ...s.drawingsBySymbol, [symbol]: next });
      return {
        drawingsBySymbol: { ...s.drawingsBySymbol, [symbol]: next },
        past: [...s.past, { symbol, list: cur }].slice(-MAX_HISTORY),
        future: [],
        selectedId: s.selectedId === id ? null : s.selectedId,
      };
    }),

  clearDrawings: (symbol) =>
    set((s) => {
      const cur = s.drawingsBySymbol[symbol] ?? [];
      if (cur.length === 0) return {};
      const bySymbol = { ...s.drawingsBySymbol, [symbol]: [] };
      persistDrawings(bySymbol);
      return {
        drawingsBySymbol: bySymbol,
        past: [...s.past, { symbol, list: cur }].slice(-MAX_HISTORY),
        future: [],
        selectedId: null,
      };
    }),

  undoDrawings: () => {
    const s = get();
    const step = s.past[s.past.length - 1];
    if (!step) return;
    const current = s.drawingsBySymbol[step.symbol] ?? [];
    const bySymbol = { ...s.drawingsBySymbol, [step.symbol]: step.list };
    persistDrawings(bySymbol);
    set({
      drawingsBySymbol: bySymbol,
      past: s.past.slice(0, -1),
      future: [...s.future, { symbol: step.symbol, list: current }].slice(-MAX_HISTORY),
      selectedId: null,
    });
  },

  redoDrawings: () => {
    const s = get();
    const step = s.future[s.future.length - 1];
    if (!step) return;
    const current = s.drawingsBySymbol[step.symbol] ?? [];
    const bySymbol = { ...s.drawingsBySymbol, [step.symbol]: step.list };
    persistDrawings(bySymbol);
    set({
      drawingsBySymbol: bySymbol,
      future: s.future.slice(0, -1),
      past: [...s.past, { symbol: step.symbol, list: current }].slice(-MAX_HISTORY),
      selectedId: null,
    });
  },
}));

const EMPTY_DRAWINGS: Drawing[] = [];

/** Selector helper: returns the shared EMPTY_DRAWINGS constant when a symbol
 *  has none, so subscribers keep a stable reference across store updates. */
export function selectDrawings(state: ChartState, symbol: string): Drawing[] {
  return state.drawingsBySymbol[symbol] ?? EMPTY_DRAWINGS;
}
