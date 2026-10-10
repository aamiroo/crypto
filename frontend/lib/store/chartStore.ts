import { create } from "zustand";
import type { Timeframe, ChartType, IndicatorConfig, Drawing, ChartTool, ChartSettings } from "@/lib/types";

interface ChartState {
  timeframe: Timeframe;
  chartType: ChartType;
  indicators: IndicatorConfig[];
  drawings: Drawing[];
  drawingHistory: Drawing[][];
  drawingRedo: Drawing[][];
  crosshairData: { time: number; open: number; high: number; low: number; close: number; volume: number } | null;
  activeTool: ChartTool;
  settings: ChartSettings;
  fullscreen: boolean;

  setTimeframe: (tf: Timeframe) => void;
  setChartType: (ct: ChartType) => void;
  toggleIndicator: (id: string) => void;
  addIndicator: (ind: IndicatorConfig) => void;
  removeIndicator: (id: string) => void;
  setCrosshairData: (d: ChartState["crosshairData"]) => void;
  setActiveTool: (t: ChartTool) => void;
  setFullscreen: (f: boolean) => void;
  updateSettings: (partial: Partial<ChartSettings>) => void;
  addDrawing: (d: Drawing) => void;
  removeDrawing: (id: string) => void;
  clearDrawings: () => void;
  undoDrawing: () => void;
  redoDrawing: () => void;
}

function loadPersisted<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {}
  return fallback;
}

function persist(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const DEFAULT_INDICATORS: IndicatorConfig[] = [
  { id: "sma20", type: "sma", period: 20, visible: true, color: "#f59e0b" },
  { id: "ema50", type: "ema", period: 50, visible: false, color: "#8b5cf6" },
];

export const useChartStore = create<ChartState>((set) => ({
  timeframe: loadPersisted("ct_tf", "1m") as Timeframe,
  chartType: loadPersisted("ct_ct", "candlestick") as ChartType,
  indicators: loadPersisted("ct_inds", DEFAULT_INDICATORS),
  drawings: [],
  drawingHistory: [[]],
  drawingRedo: [],
  crosshairData: null,
  activeTool: "crosshair",
  fullscreen: false,
  settings: loadPersisted("ct_settings", {
    chartType: "candlestick",
    showGrid: true,
    showVolume: true,
    showDrawings: true,
    showIndicators: true,
    autoScale: true,
    magnetMode: false,
    lockDrawings: false,
  } as ChartSettings),

  setTimeframe: (timeframe) => { persist("ct_tf", timeframe); set({ timeframe }); },
  setChartType: (chartType) => { persist("ct_ct", chartType); set((s) => ({ chartType, settings: { ...s.settings, chartType } })); },

  toggleIndicator: (id) =>
    set((s) => {
      const indicators = s.indicators.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i));
      persist("ct_inds", indicators);
      return { indicators };
    }),
  addIndicator: (ind) => set((s) => { const indicators = [...s.indicators, ind]; persist("ct_inds", indicators); return { indicators }; }),
  removeIndicator: (id) =>
    set((s) => {
      const indicators = s.indicators.filter((i) => i.id !== id);
      persist("ct_inds", indicators);
      return { indicators };
    }),

  setCrosshairData: (crosshairData) => set({ crosshairData }),
  setActiveTool: (activeTool) => set({ activeTool }),
  setFullscreen: (fullscreen) => set({ fullscreen }),
  updateSettings: (partial) =>
    set((s) => {
      const settings = { ...s.settings, ...partial };
      persist("ct_settings", settings);
      return { settings };
    }),

  addDrawing: (d) =>
    set((s) => ({
      drawings: [...s.drawings, d],
      drawingHistory: [...s.drawingHistory, [...s.drawings, d]],
      drawingRedo: [],
    })),
  removeDrawing: (id) =>
    set((s) => {
      const next = s.drawings.filter((d) => d.id !== id);
      return { drawings: next, drawingHistory: [...s.drawingHistory, next], drawingRedo: [] };
    }),
  clearDrawings: () =>
    set((s) => ({
      drawings: [],
      drawingHistory: [...s.drawingHistory, []],
      drawingRedo: [],
    })),
  undoDrawing: () =>
    set((s) => {
      if (s.drawingHistory.length <= 1) return {};
      const hist = [...s.drawingHistory];
      hist.pop();
      const drawings = hist[hist.length - 1]!;
      return { drawings, drawingHistory: hist, drawingRedo: [...s.drawingRedo, s.drawings] };
    }),
  redoDrawing: () =>
    set((s) => {
      if (s.drawingRedo.length === 0) return {};
      const redo = [...s.drawingRedo];
      const next = redo.pop()!;
      return { drawings: next, drawingHistory: [...s.drawingHistory, next], drawingRedo: redo };
    }),
}));
