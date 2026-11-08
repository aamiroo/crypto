"use client";
import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  HistogramSeries,
  type IChartApi,
  type IPaneApi,
  type ISeriesApi,
  type SeriesType,
  type Time,
} from "lightweight-charts";
import { useMarketStore, selectKlines, type KlineStatus } from "@/lib/store/marketStore";
import { useChartStore } from "@/lib/store/chartStore";
import { sma, ema, rsi, macd, bollinger, klineCloses } from "@/lib/utils/indicators";
import { fmtPrice, fmtVolume, fmtDateTime } from "@/lib/utils/format";
import { getPriceDecimals } from "@/lib/utils/symbol";
import { useThemeStore } from "@/lib/store/themeStore";
import { chartPalette, withAlpha } from "@/lib/chart/theme";
import { DrawingsPrimitive, type DrawingsSource } from "@/lib/chart/drawingsPrimitive";
import { DrawingController } from "@/components/DrawingLayer";
import { DrawingsPanel } from "@/components/DrawingsPanel";
import {
  EMPTY_KLINES, RECENT_TAIL_MS, TIMEFRAME_SPAN_MS, buildTimeIndex, diffKlines, gapHoles, klineKey, missingHistory,
  slotCount, switchVisibleRange, toCandleBars, toIndicatorBars, toLineBars, toVolumeBars,
} from "@/lib/utils/klines";
import { loadHistoricalKlines, loadOlderKlines, refreshRecentKlines } from "@/lib/api/klines";
import { RESET_VIEW_EVENT } from "@/lib/hooks/useKeyboardShortcuts";
import type { ChartType, IndicatorConfig, KlineData, Timeframe } from "@/lib/types";

/** Indicator series are recomputed at most this often while candles tick. */
const INDICATOR_REFRESH_MS = 1000;
/** Share of the chart height an oscillator pane asks for, relative to the price pane. */
const OSC_STRETCH = 0.22;
const VOLUME_BAND = 0.18;
/** Start fetching older history once the left edge gets within this many bars. */
const LOAD_MORE_THRESHOLD = 5;
/** Re-pull a gapped window while the gateway may still be healing it. */
const GAP_HEAL_POLL_MS = 30_000;

type AltKind = "line" | "area";
type AltSeries = ISeriesApi<"Line" | "Area">;

function isOscillator(t: IndicatorConfig["type"]): boolean {
  return t === "rsi" || t === "macd";
}

/** Price scale precision comes from the venue's tick size. Sub-cent coins are
 *  registered with 9-13 decimals, so the axis must not be capped at 8 — at that
 *  point `minMove` rounds every price to one flat line. */
function pricePrecision(decimals: number): number {
  return Math.min(13, Math.max(0, decimals));
}

function priceFormat(decimals: number) {
  const precision = pricePrecision(decimals);
  return { type: "price" as const, precision, minMove: 10 ** -precision };
}

export function ChartPanel({ symbol }: { symbol: string }) {
  const chartHostRef = useRef<HTMLDivElement>(null);
  const chRef = useRef<IChartApi | null>(null);
  const csRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vsRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const altRef = useRef<Partial<Record<AltKind, AltSeries>>>({});
  /** id -> series, for every indicator currently on the chart. */
  const indRef = useRef<Map<string, ISeriesApi<SeriesType>[]>>(new Map());
  /** id -> pane, for the oscillator panes currently open. */
  const paneRef = useRef<Map<string, IPaneApi<Time>>>(new Map());
  /** The series driving the right price scale for the active chart type. */
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const primRef = useRef<DrawingsPrimitive | null>(null);
  // Only one drawing gesture layer per panel: DrawingController owns the
  // pointer gestures and the menu for this chart. Its props are fresh every
  // render, and `epoch` is bumped inside the chart lifecycle effect below
  // whenever the chart is recreated (new `chRef`), so a new DrawingController
  // can start over with the fresh refs.
  // Naming kept for readability; only one drawing gesture layer per panel.
  /** Klines last pushed to the rendered series — drives incremental updates. */
  const lastRef = useRef<KlineData[]>(EMPTY_KLINES);
  const klinesRef = useRef<KlineData[]>(EMPTY_KLINES);
  const themeApplied = useRef<string | null>(null);
  const timeIdxRef = useRef<Map<Time, KlineData>>(new Map());
  const idxRef = useRef<Map<Time, number>>(new Map());
  const loadOlderRef = useRef<(() => void) | null>(null);
  const ctRef = useRef<ChartType | null>(null);
  /** The timeframe the rendered viewport was fitted for. */
  const tfRef = useRef<Timeframe | null>(null);
  /** Set by a timeframe switch; cleared once the switched-to window has landed. */
  const fitPendingRef = useRef(false);
  /** The symbol whose candles are currently painted. A switch away from it must
   *  repaint from scratch; a timeframe switch may keep the frame. */
  const paintedSymRef = useRef<string>(symbol);
  /** True while the painted frame belongs to the timeframe the user left, and the
   *  new one is still arriving. It is what lets the chart stay drawn instead of
   *  blanking for the length of a history load. */
  const staleViewRef = useRef(false);
  const [staleView, setStaleView] = useState(false);
  const visRef = useRef<string>("");
  const [chartEpoch, setChartEpoch] = useState(0);
  const [indRefresh, setIndRefresh] = useState(0);
  const indDirty = useRef(false);

  const tf = useChartStore((s) => s.timeframe);
  const ct = useChartStore((s) => s.chartType);
  const klines = useMarketStore((s) => selectKlines(s, symbol, tf));
  const inds = useChartStore((s) => s.indicators);
  const st = useChartStore((s) => s.settings);
  const drawingsBySymbol = useChartStore((s) => s.drawingsBySymbol);
  const selectedId = useChartStore((s) => s.selectedId);
  const activeTool = useChartStore((s) => s.activeTool);
  const setCD = useChartStore((s) => s.setCrosshairData);
  const theme = useThemeStore((s) => s.theme);
  const status = useMarketStore((s) => s.klineStatus[klineKey(symbol, tf)]);
  const connected = useMarketStore((s) => s.connected);
  /** Absent bars inside the series being painted. Computed on a delay rather than
   *  per tick: it walks the whole array, and ticks arrive several times a second. */
  const [holes, setHoles] = useState<{ bars: number; lagMs: number }>({ bars: 0, lagMs: 0 });

  // ── Refs for the pointer-layer (must be created before `DrawingController`,
  //     which is a component and reads them via its props) ──────────
  const hoverIdRef = useRef<string | null>(null);
  const ghostRef = useRef<import("@/lib/types").Drawing | null>(null);
  const pendingRef = useRef<import("@/lib/types").DrawingPoint[]>([]);

  /** `DrawingController` is mounted once per lifetime of this chart panel.
   *  Its props are fresh every render, so `epoch` is bumped by the chart
   *  lifecycle effect below whenever the chart is recreated — or whenever a
   *  new symbol/timeframe forces a completely new chart instance. */
  const drawingController = DrawingController({
    chartRef: chRef,
    primitiveRef: primRef,
    hostRef: chartHostRef,
    symbol,
    epoch: chartEpoch,
    hoverIdRef,
    ghostRef,
    pendingRef,
    seriesRef: mainRef,
  });

  /** What the primitive may look at. Everything is a getter so the primitive
   *  never holds a stale snapshot of the store. `drawingsBySymbol` /
   *  `selectedId` / `activeTool` are kept separately (they live on the whole
   *  chart state — ChartState, not ChartSettings) because the primitive reads
   *  them through getters that `DrawingsPrimitive` re-evaluates on every paint.
   */
  const drawingsSource = useMemo<DrawingsSource>(() => ({
    drawings: () => drawingsBySymbol[symbol] ?? [],
    selectedId: () => selectedId,
    hoverId: () => hoverIdRef.current,
    ghost: () => ghostRef.current,
    pending: () => pendingRef.current,
    interactive: () => activeTool === "crosshair",
    palette: () => chartPalette(theme),
    fmtPrice: (p) => fmtPrice(p, symbol),
    fmtTime: (t) => fmtDateTime(t * 1000),
    barSeconds: () => TIMEFRAME_SPAN_MS[tf] / 1000,
  }), [drawingsBySymbol, selectedId, activeTool, symbol, theme, tf]);

  // ── Chart lifecycle (created once; theme is applied as options) ──────
  useEffect(() => {
    const el = chartHostRef.current;
    if (!el) return;
    const c = chartPalette(theme);
    const ch = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: c.bg },
        textColor: c.text,
        fontSize: c.fontSize,
        fontFamily: c.fontFamily,
        attributionLogo: false,
      },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: c.crosshair, width: 1, style: 2, labelBackgroundColor: c.labelBg },
        horzLine: { color: c.crosshair, width: 1, style: 2, labelBackgroundColor: c.labelBg },
      },
      rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.05, bottom: 0.05 } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: c.border, rightOffset: 6, barSpacing: 8 },
      autoSize: true,
    });
    const cs = ch.addSeries(CandlestickSeries, {
      upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down,
    });
    const vs = ch.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume" });
    ch.priceScale("volume").applyOptions({ scaleMargins: { top: 1 - VOLUME_BAND, bottom: 0 } });

    // `drawingsSource` is a store getter — available before this effect runs.
    const primitive = new DrawingsPrimitive(() => ch, drawingsSource);
    cs.attachPrimitive(primitive);

    chRef.current = ch;
    csRef.current = cs;
    vsRef.current = vs;
    altRef.current = {};
    indRef.current = new Map();
    paneRef.current = new Map();
    mainRef.current = cs as unknown as ISeriesApi<SeriesType>;
    primRef.current = primitive;
    themeApplied.current = theme;
    // The previous chart instance is gone — force a full re-push of data.
    lastRef.current = EMPTY_KLINES;
    staleViewRef.current = false;
    timeIdxRef.current = new Map();
    idxRef.current = new Map();

    ch.subscribeCrosshairMove((p) => {
      if (!p.time) { setCD(null); return; }
      const k = timeIdxRef.current.get(p.time);
      if (!k) { setCD(null); return; }
      const i = idxRef.current.get(p.time);
      const prev = i !== undefined && i > 0 ? lastRef.current[i - 1] : undefined;
      const close = +k.close;
      const base = prev ? +prev.close : +k.open;
      const changePct = base > 0 ? ((close - base) / base) * 100 : null;
      setCD({ time: k.openTime, open: +k.open, high: +k.high, low: +k.low, close, volume: +k.volume, changePct });
    });
    ch.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || range.from > LOAD_MORE_THRESHOLD) return;
      loadOlderRef.current?.();
    });

    setChartEpoch((e) => e + 1);
    return () => {
      ch.remove();
      if (chRef.current === ch) {
        chRef.current = null;
        csRef.current = null;
        vsRef.current = null;
        mainRef.current = null;
        primRef.current = null;
      }
    };
    // `theme` is read for the initial palette only; switching is its own effect.
    // The primitive is rebuilt with the chart, so its source identity is fixed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setCD]);

  // ── Theme: recolour in place so zoom/scroll never resets ─────────────
  useEffect(() => {
    const ch = chRef.current;
    if (!ch || themeApplied.current === theme) return;
    themeApplied.current = theme;
    const c = chartPalette(theme);
    ch.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      crosshair: { vertLine: { color: c.crosshair, labelBackgroundColor: c.labelBg }, horzLine: { color: c.crosshair, labelBackgroundColor: c.labelBg } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    });
    csRef.current?.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
    altRef.current.line?.applyOptions({ color: c.up });
    altRef.current.area?.applyOptions({ lineColor: c.up, topColor: withAlpha(c.up, 0.3), bottomColor: withAlpha(c.up, 0.05) });
    primRef.current?.invalidate();
    // Volume bar colours are baked into the data, so re-push them.
    lastRef.current = EMPTY_KLINES;
    setChartEpoch((e) => e + 1);
  }, [theme]);

  // ── Price format from the venue's tick size ──────────────────────────
  // Re-runs when the instrument registry fills in, which happens after the first
  // candles on a cold boot: without it a 8-decimal coin keeps a 4-decimal axis.
  const decimals = useMarketStore((s) => s.instrumentDecimals[symbol]?.price);
  useEffect(() => {
    const format = priceFormat(decimals ?? getPriceDecimals(symbol));
    csRef.current?.applyOptions({ priceFormat: format });
    altRef.current.line?.applyOptions({ priceFormat: format });
    altRef.current.area?.applyOptions({ priceFormat: format });
  }, [symbol, decimals, chartEpoch]);

  // ── Data → series (incremental when possible) ────────────────────────
  useEffect(() => {
    const ch = chRef.current;
    const cs = csRef.current;
    const vs = vsRef.current;
    if (!ch || !cs || !vs) return;

    // Chart type switch: the target series must receive the full series.
    if (ctRef.current !== ct) {
      if (ctRef.current !== null) lastRef.current = EMPTY_KLINES;
      ctRef.current = ct;
    }

    const prev = lastRef.current;
    const plan = diffKlines(prev, klines);
    if (plan.kind === "noop") return;

    const markStale = (v: boolean) => {
      if (staleViewRef.current === v) return;
      staleViewRef.current = v;
      setStaleView(v);
    };
    const switchedSymbol = paintedSymRef.current !== symbol;
    paintedSymRef.current = symbol;

    const colors = chartPalette(theme);
    const ensureAlt = (kind: AltKind): AltSeries => {
      const store = altRef.current;
      let s = store[kind];
      if (!s) {
        s = kind === "line"
          ? ch.addSeries(LineSeries, { color: colors.up, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceScaleId: "right" })
          : ch.addSeries(AreaSeries, { lineColor: colors.up, topColor: withAlpha(colors.up, 0.3), bottomColor: withAlpha(colors.up, 0.05), lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceScaleId: "right" });
        store[kind] = s;
      }
      return s;
    };

    const visKey = `${chartEpoch}:${ct}:${decimals ?? "d"}`;
    if (visKey !== visRef.current) {
      visRef.current = visKey;
      cs.applyOptions({ visible: ct === "candlestick" });
      altRef.current.line?.applyOptions({ visible: ct === "line" });
      altRef.current.area?.applyOptions({ visible: ct === "area" });
    }
    const active: ISeriesApi<SeriesType> = ct === "candlestick"
      ? (cs as unknown as ISeriesApi<SeriesType>)
      : (ensureAlt(ct === "line" ? "line" : "area") as unknown as ISeriesApi<SeriesType>);

    // Annotations are painted through the series that owns the price scale, so
    // switching chart type moves the primitive with it.
    if (mainRef.current !== active) {
      const prim = primRef.current;
      const previous = mainRef.current;
      if (prim && previous) { try { previous.detachPrimitive(prim); } catch { /* already gone */ } }
      if (prim) { try { active.attachPrimitive(prim); } catch { /* series detached */ } }
      mainRef.current = active;
    }

    const timeScale = ch.timeScale();
    const logicalRange = timeScale.getVisibleLogicalRange();
    const timeRange = timeScale.getVisibleRange();

    const applyFull = () => {
      if (ct === "candlestick") active.setData(toCandleBars(klines));
      else active.setData(toLineBars(klines));
      vs.setData(toVolumeBars(klines, colors.volumeUp, colors.volumeDown));
    };

    if (plan.kind === "empty") {
      if (!switchedSymbol && prev.length > 0) {
        // Timeframe switch with the new window still in flight: keep the previous
        // candles painted and let the badge say what is loading. A blank chart
        // reads as a failed load; a drawn one with a hint does not.
        markStale(true);
        return;
      }
      markStale(false);
      cs.setData([]);
      vs.setData([]);
      altRef.current.line?.setData([]);
      altRef.current.area?.setData([]);
      lastRef.current = EMPTY_KLINES;
      timeIdxRef.current = new Map();
      primRef.current?.invalidate();
      return;
    }
    markStale(false);

    /** A timeframe switch invalidates the current zoom: the visible window was
     *  measured in the *old* bar size, so reusing it on 4h candles after being
     *  zoomed in on 1m leaves one or two bars on screen — indistinguishable from
     *  a chart that failed to load. */
    const refitForTimeframe = (): boolean => {
      if (klines.length === 0) return false;
      if (tfRef.current !== tf) {
        tfRef.current = tf;
        fitPendingRef.current = true;
      }
      if (!fitPendingRef.current) return false;
      if (status?.state === "ready") fitPendingRef.current = false;
      try { timeScale.setVisibleLogicalRange(switchVisibleRange(klines)); }
      catch { timeScale.scrollToRealTime(); }
      return true;
    };

    if (plan.kind === "tail") {
      // Only the newest bars changed: cheap incremental update, viewport untouched.
      // The push is only safe while the run is unbroken — `update` cannot say "the
      // bars before this one never came", so a candle landing after a hole would
      // be drawn as its predecessor's neighbour and the gap would vanish.
      let broken = false;
      for (let i = Math.max(1, plan.from); i < klines.length; i++) {
        if (gapHoles(klines[i - 1]!, klines[i]!) > 0) { broken = true; break; }
      }
      if (!broken) {
        for (let i = plan.from; i < klines.length; i++) {
          const k = klines[i]!;
          const t = Math.floor(k.openTime / 1000) as Time;
          if (ct === "candlestick") active.update({ time: t, open: +k.open, high: +k.high, low: +k.low, close: +k.close });
          else active.update({ time: t, value: +k.close });
          vs.update({ time: t, value: +k.volume, color: +k.close >= +k.open ? colors.volumeUp : colors.volumeDown });
        }
        const idx = timeIdxRef.current;
        const order = idxRef.current;
        for (let i = plan.from; i < klines.length; i++) {
          const k = klines[i]!;
          const t = Math.floor(k.openTime / 1000) as Time;
          idx.set(t, k);
          order.set(t, i);
        }
        lastRef.current = klines;
        refitForTimeframe();
        primRef.current?.invalidate();
        return;
      }
    }

    applyFull();
    const bars = klines;
    const prevLastIndex = prev.length > 0 ? slotCount(prev) - 1 : null;
    const followingEdge = !switchedSymbol && logicalRange != null && prevLastIndex != null && logicalRange.to >= prevLastIndex - 1;
    const tailAdvanced = prev.length > 0 && bars[bars.length - 1]!.openTime > prev[prev.length - 1]!.openTime;
    const barsAdded = bars.length > prev.length;
    if (!refitForTimeframe()) {
      if (followingEdge && (tailAdvanced || barsAdded)) {
        // A live-edge viewer must not stay parked on the old side of a gap that
        // just healed (or that a new candle just jumped across).
        try { timeScale.setVisibleLogicalRange(switchVisibleRange(bars)); }
        catch { timeScale.scrollToRealTime(); }
      } else if (plan.kind === "full" && plan.shift > 0 && logicalRange) {
        const shift = slotCount(klines) - slotCount(prev);
        timeScale.setVisibleLogicalRange({ from: logicalRange.from + shift, to: logicalRange.to + shift });
      } else if (timeRange && bars.length > 0) {
        const rangeFrom = Number(timeRange.from);
        const rangeTo = Number(timeRange.to);
        const first = Math.floor(bars[0]!.openTime / 1000);
        const last = Math.floor(bars[bars.length - 1]!.openTime / 1000);
        if (first <= rangeFrom && last >= rangeTo) {
          try { timeScale.setVisibleRange(timeRange); } catch { timeScale.scrollToRealTime(); }
        } else {
          timeScale.scrollToRealTime();
        }
      } else if (bars.length > 0) {
        timeScale.scrollToRealTime();
      }
    }

    lastRef.current = bars;
    timeIdxRef.current = buildTimeIndex(bars);
    const order = new Map<Time, number>();
    for (let i = 0; i < bars.length; i++) order.set(Math.floor(bars[i]!.openTime / 1000) as Time, i);
    idxRef.current = order;
    primRef.current?.invalidate();
  }, [klines, symbol, tf, status, ct, theme, chartEpoch, decimals]);

  // ── Honesty badge: how much of the series is missing, and how stale ──
  useEffect(() => {
    const id = setTimeout(() => setHoles(missingHistory(klines, tf)), 400);
    return () => clearTimeout(id);
  }, [klines, tf]);

  // The gateway can heal an interior gap after the page that painted this window
  // was served. A current live tail alone is not a reason to re-pull, so ask
  // again while the badge still reports absent bars and the crawl is not settled.
  useEffect(() => {
    if (holes.bars === 0 || status?.state !== "ready") return;
    const historyStatus = status.historyStatus;
    if (historyStatus === "complete" || historyStatus === "exhausted") return;
    const id = setInterval(() => { void refreshRecentKlines(symbol, tf); }, GAP_HEAL_POLL_MS);
    return () => clearInterval(id);
  }, [holes.bars, status?.state, status?.historyStatus, symbol, tf]);

  // ── Indicators: stable series registry, refreshed at most 1×/s ───────
  useEffect(() => {
    klinesRef.current = klines;
    indDirty.current = true;
  }, [klines]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!indDirty.current) return;
      indDirty.current = false;
      setIndRefresh((v) => v + 1);
    }, INDICATOR_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const ch = chRef.current;
    if (!ch) return;
    const bars = klinesRef.current;
    const palette = chartPalette(theme);
    const wanted = new Map<string, ISeriesApi<SeriesType>[]>();
    const wantedPanes = new Map<string, IPaneApi<Time>>();

    if (st.showIndicators && bars.length > 0) {
      const closes = klineCloses(bars);

      const addLine = (
        pane: IPaneApi<Time> | null,
        vals: (number | null)[],
        color: string,
        priceScaleId: string,
        fixedRange?: { min: number; max: number },
      ): ISeriesApi<SeriesType> => {
        const options = {
          color,
          lineWidth: 1 as const,
          priceLineVisible: false,
          lastValueVisible: false,
          priceScaleId,
          ...(fixedRange
            ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: fixedRange.min, maxValue: fixedRange.max } }) }
            : {}),
        };
        const line = pane ? pane.addSeries(LineSeries, options) : ch.addSeries(LineSeries, options);
        line.setData(toIndicatorBars(bars, vals));
        return line as unknown as ISeriesApi<SeriesType>;
      };
      const addHistogram = (
        pane: IPaneApi<Time>,
        vals: (number | null)[],
        colorFor: (v: number) => string,
        priceScaleId: string,
      ) => {
        const hist = pane.addSeries(HistogramSeries, { priceScaleId, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } });
        hist.setData(toIndicatorBars(bars, vals).map((b) => ("value" in b ? { ...b, color: colorFor(b.value) } : b)));
        return hist as unknown as ISeriesApi<SeriesType>;
      };

      for (const ind of inds) {
        if (!ind.visible) continue;
        const oscillator = isOscillator(ind.type);
        // Each oscillator gets its own pane, so panes never share a range.
        let pane: IPaneApi<Time> | null = null;
        if (oscillator) {
          pane = paneRef.current.get(ind.id) ?? null;
          if (!pane) {
            pane = ch.addPane();
            pane.setStretchFactor(OSC_STRETCH);
            paneRef.current.set(ind.id, pane);
          }
          wantedPanes.set(ind.id, pane);
        }
        const scaleId = oscillator ? ind.id : "right";
        const reused = indRef.current.get(ind.id);
        let series: ISeriesApi<SeriesType>[];
        if (ind.type === "sma" || ind.type === "ema") {
          const vals = ind.type === "ema" ? ema(closes, ind.period) : sma(closes, ind.period);
          series = reused ?? [addLine(pane, vals, ind.color || palette.accent, scaleId)];
          if (reused) (reused[0] as ISeriesApi<"Line">).setData(toIndicatorBars(bars, vals));
        } else if (ind.type === "bb") {
          const { upper, middle, lower } = bollinger(closes, ind.period || 20, 2);
          const source = [upper, middle, lower];
          series = reused ?? source.map((vals, idx) => addLine(pane, vals, idx === 1 ? withAlpha(palette.accent, 0.5) : palette.accent, scaleId));
          if (reused) reused.forEach((s, idx) => (s as ISeriesApi<"Line">).setData(toIndicatorBars(bars, source[idx]!)));
        } else if (ind.type === "rsi") {
          const vals = rsi(closes, ind.period || 14);
          series = reused ?? [addLine(pane, vals, ind.color || "#8b5cf6", scaleId, { min: 0, max: 100 })];
          if (reused) (reused[0] as ISeriesApi<"Line">).setData(toIndicatorBars(bars, vals));
        } else if (ind.type === "macd") {
          const { macdLine, signalLine, histogram } = macd(closes);
          const histColor = (v: number) => (v >= 0 ? palette.volumeUp : palette.volumeDown);
          if (!reused && pane) {
            const line1 = addLine(pane, macdLine, "#2196f3", scaleId);
            const line2 = addLine(pane, signalLine, "#ff9800", scaleId);
            series = [line1, line2, addHistogram(pane, histogram, histColor, scaleId)];
          } else if (reused) {
            (reused[0] as ISeriesApi<"Line">).setData(toIndicatorBars(bars, macdLine));
            (reused[1] as ISeriesApi<"Line">).setData(toIndicatorBars(bars, signalLine));
            (reused[2] as ISeriesApi<"Histogram">).setData(
              toIndicatorBars(bars, histogram).map((b) => ("value" in b ? { ...b, color: histColor(b.value) } : b)),
            );
            series = reused;
          } else {
            continue;
          }
        } else {
          continue;
        }
        wanted.set(ind.id, series);
      }
    }

    for (const [id, series] of indRef.current) {
      if (wanted.has(id)) continue;
      for (const s of series) { try { ch.removeSeries(s); } catch { /* series already gone */ } }
    }
    indRef.current = wanted;
    // A pane survives only as long as the oscillator that owns it.
    for (const [id, pane] of paneRef.current) {
      if (wantedPanes.has(id)) continue;
      paneRef.current.delete(id);
      try { ch.removePane(pane.paneIndex()); } catch { /* already removed */ }
    }
  }, [indRefresh, inds, st.showIndicators, symbol, tf, chartEpoch, theme]);

  // ── Price scale layout: volume band under the price pane ─────────────
  useEffect(() => {
    const ch = chRef.current;
    if (!ch) return;
    const showVolume = st.showVolume;
    ch.priceScale("right").applyOptions({ scaleMargins: { top: 0.05, bottom: showVolume ? VOLUME_BAND : 0.05 } });
    if (showVolume) ch.priceScale("volume").applyOptions({ scaleMargins: { top: 1 - VOLUME_BAND, bottom: 0 } });
    vsRef.current?.applyOptions({ visible: showVolume });
  }, [st.showVolume, chartEpoch]);

  // ── Grid toggle (re-applied after chart recreation) ───────────────────
  useEffect(() => {
    chRef.current?.applyOptions({ grid: { vertLines: { visible: st.showGrid }, horzLines: { visible: st.showGrid } } });
  }, [st.showGrid, chartEpoch]);

  // ── Auto-scale price axis ─────────────────────────────────────────────
  useEffect(() => {
    try { chRef.current?.priceScale("right").applyOptions({ autoScale: st.autoScale }); } catch { /* not ready */ }
  }, [st.autoScale, chartEpoch]);

  // ── Scroll-back wiring ───────────────────────────────────────────────
  const loadOlder = useCallback(() => { void loadOlderKlines(symbol, tf); }, [symbol, tf]);
  useEffect(() => { loadOlderRef.current = loadOlder; }, [loadOlder]);

  const retry = useCallback(() => { void loadHistoricalKlines(symbol, tf); }, [symbol, tf]);

  // ── Reset view / jump back to the latest candle ──────────────────────
  useEffect(() => {
    const onReset = () => {
      const ch = chRef.current;
      if (!ch) return;
      try {
        const bars = lastRef.current;
        if (bars.length > 0) ch.timeScale().setVisibleLogicalRange(switchVisibleRange(bars));
        else {
          ch.timeScale().resetTimeScale();
          ch.timeScale().scrollToRealTime();
        }
      } catch { /* time scale not ready */ }
      try { mainRef.current?.priceScale().applyOptions({ autoScale: true }); } catch { /* noop */ }
    };
    window.addEventListener(RESET_VIEW_EVENT, onReset);
    return () => window.removeEventListener(RESET_VIEW_EVENT, onReset);
  }, []);

  // `DrawingController` is called here, at the top level of the component, so
  // its own hooks are safe. It is intentionally mounted once per lifetime of
  // this panel: the same controller instance is reused across normal chart
  // model changes (candles, timeframe, indicators) because the gesture layer
  // Anchor the pointer-layer refs (created above) on the component that actually
  // owns the gestures: DrawingController is a hook component whose props point at
  // these refs, so rendering it here lets the pointer layer resolve the correct
  // chart, primitive and series even while the chart instance is being rebuilt
  // (epoch bump) or the symbol changes.
  return (
    <div className="relative h-full w-full">
      <div ref={chartHostRef} className="h-full w-full" />
      <DrawingController
        chartRef={chRef}
        primitiveRef={primRef}
        hostRef={chartHostRef}
        symbol={symbol}
        epoch={chartEpoch}
        hoverIdRef={hoverIdRef}
        ghostRef={ghostRef}
        pendingRef={pendingRef}
        seriesRef={mainRef}
      />
      <CrossInfo />
      <ChartStateOverlay symbol={symbol} timeframe={tf} status={status} count={klines.length} staleView={staleView} missing={holes.bars} lagMs={holes.lagMs} connected={connected} onRetry={retry} />
      <DrawingsPanel symbol={symbol} />
    </div>
  );
}

/** Its own component so a crosshair move re-renders just this OHLC strip; if it
 *  lived inline, every pointer event would re-render the whole panel. */
function CrossInfo() {
  const d = useChartStore((s) => s.crosshairData);
  const sym = useMarketStore((s) => s.symbol);
  const tf = useChartStore((s) => s.timeframe);
  return (
    <div className="pointer-events-none absolute top-1.5 left-2.5 z-20 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[11px] tabular-nums">
      <span className="text-[12px] font-semibold" style={{ color: "var(--text-primary)" }}>
        {baseOf(sym)}<span className="font-normal" style={{ color: "var(--text-muted)" }}> · {tf} · {venueOf(sym)}</span>
      </span>
      {d && (<>
        <span style={{ color: "var(--text-muted)" }}>O<span style={{ color: "var(--text-secondary)" }}> {fmtPrice(d.open, sym)}</span></span>
        <span style={{ color: "var(--text-muted)" }}>H<span style={{ color: "var(--text-secondary)" }}> {fmtPrice(d.high, sym)}</span></span>
        <span style={{ color: "var(--text-muted)" }}>L<span style={{ color: "var(--text-secondary)" }}> {fmtPrice(d.low, sym)}</span></span>
        <span style={{ color: "var(--text-muted)" }}>C<span style={{ color: d.close >= d.open ? "var(--success)" : "var(--danger)" }}> {fmtPrice(d.close, sym)}</span></span>
        {d.changePct != null && (
          <span style={{ color: d.changePct >= 0 ? "var(--success)" : "var(--danger)" }}>
            {d.changePct >= 0 ? "+" : ""}{d.changePct.toFixed(2)}%
          </span>
        )}
        {d.volume > 0 && (<span style={{ color: "var(--text-muted)" }}>V<span style={{ color: "var(--text-secondary)" }}> {fmtVolume(d.volume)}</span></span>)}
        <span style={{ color: "var(--text-muted)" }}>{fmtDateTime(d.time)}</span>
      </>)}
    </div>
  );
}

function baseOf(symbol: string): string {
  return symbol.replace(/USDT$/, "") || symbol;
}
function venueOf(symbol: string): string {
  return symbol.endsWith("USDT") ? "USDT" : "spot";
}

/** A distance from now, coarse enough to read at 10px and honest enough not to
 *  round a four-day hole into "0m". */
function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** What a hole in the candles is actually doing. The gateway knows whether it is
 *  fetching, backed off after refusals, or at the end of the exchange's history,
 *  and the chart used to claim "refilling from the exchange" in all three cases —
 *  a blocked venue left that promise on screen for as long as the tab was open. */
function gapNote(historyStatus: string | undefined, lagMs: number): string {
  switch (historyStatus) {
    case "crawling":
      return lagMs > RECENT_TAIL_MS ? `history ends ${ago(lagMs)} ago · refilling` : "refilling from the exchange";
    case "waiting":
      return "the exchange is not answering";
    case "exhausted":
    case "complete":
      return "the exchange has no candles there";
    default:
      // No crawl state yet (the first page is still on its way): promise nothing.
      return "history incomplete";
  }
}

/** Loading / empty / error states, kept out of the middle of the plot: a chart
 *  with candles on it gets a corner note, never a full-face overlay. */
function ChartStateOverlay({
  symbol, timeframe, status, count, staleView, missing, lagMs, connected, onRetry,
}: {
  symbol: string;
  timeframe: string;
  status: KlineStatus | undefined;
  count: number;
  staleView: boolean;
  missing: number;
  lagMs: number;
  connected: boolean;
  onRetry: () => void;
}) {
  const state = status?.state ?? "idle";

  if (count > 0) {
    if (state === "error") return <CornerNote>History unavailable — showing live data only</CornerNote>;
    // A run of missing bars is invisible on a chart: the two candles either side
    // of an outage are drawn as neighbours, so the only way a reader finds out
    // that the axis is not continuous is if the frame says so.
    if (missing > 0) {
      const run = `${missing.toLocaleString("en-US")} candle${missing === 1 ? "" : "s"} missing`;
      return <CornerNote>{`${run} · ${gapNote(status?.historyStatus, lagMs)}`}</CornerNote>;
    }
    return null;
  }

  if (staleView) {
    if (state === "loading") return <CornerNote muted>Loading {symbol} · {timeframe} history…</CornerNote>;
    if (state === "error") return <CornerNote>History unavailable for {timeframe} — showing the previous candles</CornerNote>;
    return null;
  }

  if (state === "loading") return <CenterState><Spinner label={`Loading ${symbol} · ${timeframe} candles…`} /></CenterState>;
  if (state === "error") {
    return (
      <CenterState>
        <div className="flex flex-col items-center gap-2 text-center">
          <span style={{ color: "var(--danger)" }}>Failed to load historical data</span>
          {status?.error && <span className="max-w-[320px] text-[10px]" style={{ color: "var(--text-muted)" }}>{status.error}</span>}
          <div className="flex items-center gap-2">
            <button onClick={onRetry} className="btn btn-sm">Retry</button>
            {!connected && <span className="text-[10px]" style={{ color: "var(--warning)" }}>Waiting for connection…</span>}
          </div>
        </div>
      </CenterState>
    );
  }
  if (!connected) return <CenterState><span style={{ color: "var(--text-muted)" }}>Connecting…</span></CenterState>;
  return (
    <CenterState>
      <div className="flex flex-col items-center gap-2 text-center">
        <span style={{ color: "var(--text-muted)" }}>No chart data for {symbol} · {timeframe}</span>
        <button onClick={onRetry} className="btn btn-sm">Retry</button>
      </div>
    </CenterState>
  );
}

function CornerNote({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <div
      className="pointer-events-none absolute top-1.5 right-2 z-20 rounded-[3px] px-1.5 py-[3px] text-[10px]"
      style={{ background: "var(--bg-elevated)", color: muted ? "var(--text-muted)" : "var(--warning)", border: "1px solid var(--border)" }}
    >
      {children}
    </div>
  );
}

function CenterState({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center" style={{ background: "color-mix(in srgb, var(--chart-bg) 72%, transparent)" }}>
      {children}
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="h-5 w-5 animate-spin rounded-full border-2" style={{ borderColor: "var(--border-strong)", borderTopColor: "var(--accent)" }} />
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
    </div>
  );
}
