"use client";
import { useEffect, useRef, useCallback, useMemo, useState, type ReactNode } from "react";
import { createChart, ColorType, CrosshairMode, type IChartApi, type ISeriesApi, type SeriesType, type Time } from "lightweight-charts";
import { useMarketStore, selectKlines, type KlineStatus } from "@/lib/store/marketStore";
import { useChartStore } from "@/lib/store/chartStore";
import { sma, ema, rsi, macd, bollinger, klineCloses } from "@/lib/utils/indicators";
import { fmtPrice, fmtVolume, fmtTime } from "@/lib/utils/format";
import { getPriceDecimals } from "@/lib/utils/symbol";
import { useThemeStore } from "@/lib/store/themeStore";
import type { ThemeName } from "@/lib/types";
import {
  EMPTY_KLINES, buildTimeIndex, diffKlines, klineKey, switchVisibleRange,
  toCandleBars, toLineBars, toVolumeBars,
} from "@/lib/utils/klines";
import { loadHistoricalKlines, loadOlderKlines } from "@/lib/api/klines";
import { RESET_VIEW_EVENT } from "@/lib/hooks/useKeyboardShortcuts";
import { DrawingLayer } from "@/components/DrawingLayer";
import { DrawingsPanel } from "@/components/DrawingsPanel";
import type { ChartType, IndicatorConfig, KlineData, Timeframe } from "@/lib/types";

/** Literal colors, not CSS variables: lightweight-charts paints on a canvas and
 *  cannot resolve `var(...)`, so the theme has to be flattened before it is set. */
function getTc(t: string) {
  return t === "light"
    ? { bg: "#fff", tx: "#6c757d", gr: "#e9ecef", bd: "#dee2e6", cr: "#868e96", up: "#12b886", dn: "#e03131", uv: "rgba(18,184,134,0.3)", dv: "rgba(224,49,49,0.3)" }
    : { bg: "#0b0e11", tx: "#71717a", gr: "#1a1d23", bd: "#1c1f26", cr: "#3f3f46", up: "#10b981", dn: "#f43f5e", uv: "rgba(16,185,129,0.3)", dv: "rgba(244,63,94,0.3)" };
}

/** Start fetching older history once the left edge gets within this many bars. */
const LOAD_MORE_THRESHOLD = 5;
/** Indicator series are recomputed at most this often while candles tick. */
const INDICATOR_REFRESH_MS = 1000;
/** Vertical band each oscillator gets, as a fraction of chart height. */
const OSC_BAND = 0.16;
const VOLUME_BAND = 0.18;
const PRICE_PAD = 0.04;

type AltKind = "line" | "area";
type AltSeries = ISeriesApi<"Line" | "Area">;

/** Oscillators cross zero or run 0-100, so they must not share the price scale:
 *  they get a band at the bottom instead (see OSC_BAND). */
function isOscillator(t: IndicatorConfig["type"]) {
  return t === "rsi" || t === "macd";
}

export function ChartPanel({ symbol }: { symbol: string }) {
  const chartHostRef = useRef<HTMLDivElement>(null);
  const chRef = useRef<IChartApi | null>(null);
  const csRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vsRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const altRef = useRef<Partial<Record<AltKind, AltSeries>>>({});
  const indRef = useRef<Map<string, ISeriesApi<SeriesType>[]>>(new Map());
  /** Oscillator scale ids that currently have a series on the chart. */
  const liveOscRef = useRef<string[]>([]);
  /** The series driving the right price scale for the active chart type. */
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  /** Klines last pushed to the rendered series — drives incremental updates. */
  const lastRef = useRef<KlineData[]>(EMPTY_KLINES);
  const klinesRef = useRef<KlineData[]>(EMPTY_KLINES);
  const indDirty = useRef(false);
  const themeApplied = useRef<ThemeName | null>(null);
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

  const tf = useChartStore((s) => s.timeframe);
  const ct = useChartStore((s) => s.chartType);
  const klines = useMarketStore((s) => selectKlines(s, symbol, tf));
  const inds = useChartStore((s) => s.indicators);
  const st = useChartStore((s) => s.settings);
  const setCD = useChartStore((s) => s.setCrosshairData);
  const theme = useThemeStore((s) => s.theme);
  const status = useMarketStore((s) => s.klineStatus[klineKey(symbol, tf)]);
  const connected = useMarketStore((s) => s.connected);
  const oscIds = useMemo(
    () => (st.showIndicators ? inds.filter((i) => i.visible && isOscillator(i.type)).map((i) => i.id) : []),
    [inds, st.showIndicators],
  );

  // ── Chart lifecycle (created once; theme is applied as options) ──────
  useEffect(() => {
    const el = chartHostRef.current;
    if (!el) return;
    const c = getTc(theme);
    const ch = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.tx, fontSize: 11 },
      grid: { vertLines: { color: c.gr }, horzLines: { color: c.gr } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: c.cr, width: 1, style: 2, labelBackgroundColor: c.bd }, horzLine: { color: c.cr, width: 1, style: 2, labelBackgroundColor: c.bd } },
      rightPriceScale: { borderColor: c.bd, scaleMargins: { top: 0.05, bottom: 0.05 } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: c.bd, rightOffset: 10 },
      autoSize: true,
    });
    const cs = ch.addCandlestickSeries({ upColor: c.up, downColor: c.dn, borderVisible: false, wickUpColor: c.up, wickDownColor: c.dn });
    const vs = ch.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "volume" });
    ch.priceScale("volume").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    chRef.current = ch;
    csRef.current = cs;
    vsRef.current = vs;
    altRef.current = {};
    indRef.current = new Map();
    liveOscRef.current = [];
    themeApplied.current = theme;
    // The previous chart instance is gone — force a full re-push of data.
    lastRef.current = EMPTY_KLINES;
    // A fresh instance has nothing painted, so there is no stale frame to keep.
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
      }
    };
    // `theme` is read for the initial palette only; switching is its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setCD]);

  // ── Theme: recolour in place so zoom/scroll never resets ─────────────
  useEffect(() => {
    const ch = chRef.current;
    if (!ch || themeApplied.current === theme) return;
    themeApplied.current = theme;
    const c = getTc(theme);
    ch.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.tx },
      grid: { vertLines: { color: c.gr }, horzLines: { color: c.gr } },
      crosshair: { vertLine: { color: c.cr, labelBackgroundColor: c.bd }, horzLine: { color: c.cr, labelBackgroundColor: c.bd } },
      rightPriceScale: { borderColor: c.bd },
      timeScale: { borderColor: c.bd },
    });
    csRef.current?.applyOptions({ upColor: c.up, downColor: c.dn, wickUpColor: c.up, wickDownColor: c.dn });
    altRef.current.line?.applyOptions({ color: c.up });
    altRef.current.area?.applyOptions({ lineColor: c.up, topColor: "rgba(16,185,129,0.3)" });
    // Volume bar colours are baked into the data, so re-push them.
    lastRef.current = EMPTY_KLINES;
    setChartEpoch((e) => e + 1);
  }, [theme]);

  // ── Price format from the venue's tick size ──────────────────────────
  useEffect(() => {
    const precision = Math.min(8, Math.max(0, getPriceDecimals(symbol)));
    const priceFormat = { type: "price" as const, precision, minMove: 10 ** -precision };
    csRef.current?.applyOptions({ priceFormat });
    altRef.current.line?.applyOptions({ priceFormat });
    altRef.current.area?.applyOptions({ priceFormat });
  }, [symbol, chartEpoch]);

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

    /** Painted-frame bookkeeping: notifying React only when the flag actually
     *  flips, so a per-tick effect run never re-renders the panel. */
    const markStale = (v: boolean) => {
      if (staleViewRef.current === v) return;
      staleViewRef.current = v;
      setStaleView(v);
    };
    // Recorded before the empty branch below, which keeps the old frame painted.
    const switchedSymbol = paintedSymRef.current !== symbol;
    paintedSymRef.current = symbol;

    const colors = getTc(theme);
    const ensureAlt = (kind: AltKind): AltSeries => {
      const store = altRef.current;
      let s = store[kind];
      if (!s) {
        s = (kind === "line"
          ? ch.addLineSeries({ color: colors.up, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceScaleId: "right" })
          : ch.addAreaSeries({ lineColor: colors.up, topColor: "rgba(16,185,129,0.3)", bottomColor: "rgba(16,185,129,0.05)", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceScaleId: "right" })) as AltSeries;
        store[kind] = s;
      }
      return s;
    };

    // Exactly one main series visible for the active chart type
    // (re-applied whenever the chart instance or the type changes).
    const visKey = `${chartEpoch}:${ct}`;
    if (visKey !== visRef.current) {
      visRef.current = visKey;
      cs.applyOptions({ visible: ct === "candlestick" });
      altRef.current.line?.applyOptions({ visible: ct === "line" });
      altRef.current.area?.applyOptions({ visible: ct === "area" });
    }
    const active: ISeriesApi<SeriesType> = ct === "candlestick"
      ? cs
      : (ensureAlt(ct === "line" ? "line" : "area") as unknown as ISeriesApi<SeriesType>);
    mainRef.current = active;

    const timeScale = ch.timeScale();
    const logicalRange = plan.kind === "full" ? timeScale.getVisibleLogicalRange() : null;
    const timeRange = timeScale.getVisibleRange();

    const applyFull = () => {
      if (ct === "candlestick") active.setData(toCandleBars(klines));
      else active.setData(toLineBars(klines));
      vs.setData(toVolumeBars(klines, colors.uv, colors.dv));
    };

    if (plan.kind === "empty") {
      if (!switchedSymbol && prev.length > 0) {
        // Timeframe switch with the new window still in flight: keep the previous
        // candles painted and let the overlay say what is loading. A blank chart
        // reads as a failed load; a drawn one with a hint does not.
        markStale(true);
        return;
      }
      markStale(false);
      // Clear every series so a symbol switch never shows the old pair's bars.
      cs.setData([]);
      vs.setData([]);
      altRef.current.line?.setData([]);
      altRef.current.area?.setData([]);
      lastRef.current = EMPTY_KLINES;
      timeIdxRef.current = new Map();
      return;
    }
    markStale(false);

    // A timeframe switch invalidates the current zoom: the visible window was
    // measured in the *old* bar size, so reusing it on 4h candles after being
    // zoomed in on 1m leaves one or two bars on screen — indistinguishable from
    // a chart that failed to load. The REST page normally lands *after* the live
    // tail, so keep re-fitting on structural changes until this timeframe's load
    // settles; `tail` updates never touch the viewport, so panning stays put.
    const refitForTimeframe = (): boolean => {
      if (klines.length === 0) return false;
      if (tfRef.current !== tf) {
        tfRef.current = tf;
        fitPendingRef.current = true;
      }
      if (!fitPendingRef.current) return false;
      // Stay pending while the switch's window is still arriving: the live tail
      // lands first, and fitting to it alone would strand the view on a handful
      // of candles once the 500-bar page merges in.
      if (status?.state === "ready") fitPendingRef.current = false;
      try { timeScale.setVisibleLogicalRange(switchVisibleRange(klines.length)); }
      catch { timeScale.scrollToRealTime(); }
      return true;
    };

    if (plan.kind === "tail") {
      // Same window, only the newest bars changed: cheap incremental update,
      // viewport left alone so panning/zooming never jumps (a timeframe switch
      // is the one case that must re-fit, handled below).
      for (let i = plan.from; i < klines.length; i++) {
        const k = klines[i]!;
        const t = Math.floor(k.openTime / 1000) as Time;
        if (ct === "candlestick") active.update({ time: t, open: +k.open, high: +k.high, low: +k.low, close: +k.close });
        else active.update({ time: t, value: +k.close });
        vs.update({ time: t, value: +k.volume, color: +k.close >= +k.open ? colors.uv : colors.dv });
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
      return;
    }

    // full / first: structural change — restore the viewport where possible.
    applyFull();
    const bars = klines;
    if (!refitForTimeframe()) {
      if (plan.kind === "full" && plan.shift > 0 && logicalRange) {
        // Older history was prepended: shift indexes so the view stays put.
        timeScale.setVisibleLogicalRange({ from: logicalRange.from + plan.shift, to: logicalRange.to + plan.shift });
      } else if (timeRange && bars.length > 0) {
        // Our times are always UTCTimestamp (seconds) — compare as numbers.
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
  }, [klines, symbol, tf, status, ct, theme, chartEpoch]);

  // ── Indicators: stable series registry, refreshed at most 1×/s ───────
  useEffect(() => {
    klinesRef.current = klines;
    indDirty.current = true;
  }, [klines]);

  // Candles tick several times a second; recomputing every indicator on each
  // frame made the chart the hottest thing on the page.
  useEffect(() => {
    const id = setInterval(() => {
      if (!indDirty.current) return;
      indDirty.current = false;
      setIndRefresh((v) => v + 1);
    }, INDICATOR_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // Config changes must be visible immediately, not on the next tick.
  useEffect(() => {
    setIndRefresh((v) => v + 1);
  }, [inds, st.showIndicators, symbol, tf, chartEpoch]);

  useEffect(() => {
    const ch = chRef.current;
    if (!ch) return;
    const bars = klinesRef.current;

    const wanted = new Map<string, ISeriesApi<SeriesType>[]>();
    if (st.showIndicators && bars.length > 0) {
      const closes = klineCloses(bars);
      const times = bars.map((k) => Math.floor(k.openTime / 1000) as Time);

      const points = (vals: (number | null)[]) => {
        const out: { time: Time; value: number }[] = [];
        for (let j = 0; j < vals.length; j++) {
          const v = vals[j];
          if (v != null && Number.isFinite(v) && times[j] !== undefined) out.push({ time: times[j]!, value: v });
        }
        return out;
      };
      const addLine = (
        vals: (number | null)[],
        color: string,
        priceScaleId: string,
        fixedRange?: { min: number; max: number },
      ) => {
        const line = ch.addLineSeries({
          color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          priceScaleId,
          // Bounded indicators (RSI) keep a meaningful pane even when the data
          // only covers 45–55; the scale is pinned instead of autoscaled.
          ...(fixedRange
            ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: fixedRange.min, maxValue: fixedRange.max } }) }
            : {}),
        });
        line.setData(points(vals));
        return line as ISeriesApi<SeriesType>;
      };

      for (const ind of inds) {
        if (!ind.visible) continue;
        // Each oscillator gets its own scale so panes never share a range.
        const scaleId = isOscillator(ind.type) ? ind.id : "right";
        const reused = indRef.current.get(ind.id);
        let series: ISeriesApi<SeriesType>[];
        if (ind.type === "sma" || ind.type === "ema") {
          const vals = ind.type === "ema" ? ema(closes, ind.period) : sma(closes, ind.period);
          series = reused ?? [addLine(vals, ind.color || "#f59e0b", scaleId)];
          if (reused) (reused[0] as ISeriesApi<"Line">).setData(points(vals));
        } else if (ind.type === "bb") {
          const { upper, middle, lower } = bollinger(closes, ind.period || 20, 2);
          const source = [upper, middle, lower];
          series = reused ?? source.map((vals, idx) => addLine(vals, idx === 1 ? "rgba(245,158,11,0.5)" : "#f59e0b", scaleId));
          if (reused) reused.forEach((s, idx) => (s as ISeriesApi<"Line">).setData(points(source[idx]!)));
        } else if (ind.type === "rsi") {
          const vals = rsi(closes, ind.period || 14);
          series = reused ?? [addLine(vals, ind.color || "#8b5cf6", scaleId, { min: 0, max: 100 })];
          if (reused) (reused[0] as ISeriesApi<"Line">).setData(points(vals));
        } else if (ind.type === "macd") {
          const { macdLine, signalLine, histogram } = macd(closes);
          const histData = points(histogram).map((p) => ({ ...p, color: p.value >= 0 ? "rgba(16,185,129,0.6)" : "rgba(244,63,94,0.6)" }));
          if (!reused) {
            const line1 = addLine(macdLine, "#2196f3", scaleId);
            const line2 = addLine(signalLine, "#ff9800", scaleId);
            const hist = ch.addHistogramSeries({ priceScaleId: scaleId });
            hist.setData(histData);
            series = [line1, line2, hist as ISeriesApi<SeriesType>];
          } else {
            (reused[0] as ISeriesApi<"Line">).setData(points(macdLine));
            (reused[1] as ISeriesApi<"Line">).setData(points(signalLine));
            (reused[2] as ISeriesApi<"Histogram">).setData(histData);
            series = reused;
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
    liveOscRef.current = oscIds.filter((id) => wanted.has(id));
  }, [indRefresh, inds, st.showIndicators, symbol, tf, chartEpoch, oscIds]);

  // ── Price scale layout: price, volume and one band per oscillator ────
  useEffect(() => {
    const ch = chRef.current;
    if (!ch) return;
    const showVolume = st.showVolume;
    const volH = showVolume ? VOLUME_BAND : 0;
    const oscTotal = Math.min(OSC_BAND * oscIds.length, 0.4);

    // Reserve pane space: volume band at the bottom, oscillator bands above it.
    const bottom = PRICE_PAD + volH + oscTotal;
    ch.priceScale("right").applyOptions({ scaleMargins: { top: 0.05, bottom } });
    if (showVolume) ch.priceScale("volume").applyOptions({ scaleMargins: { top: 1 - volH, bottom: 0 } });

    const n = oscIds.length;
    const band = n > 0 ? oscTotal / n : 0;
    // Only scales that actually own a series: before the first candles arrive
    // (boot, new symbol) no oscillator series exists, and configuring a scale
    // with no series throws and takes the whole page down.
    oscIds.forEach((id, i) => {
      if (!liveOscRef.current.includes(id)) return;
      const from = volH + i * band;
      ch.priceScale(id).applyOptions({
        scaleMargins: { top: Math.max(0.02, 1 - from - band), bottom: from },
        borderVisible: false,
      });
    });
    vsRef.current?.applyOptions({ visible: showVolume });
  }, [st.showVolume, oscIds, chartEpoch, indRefresh]);

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
        ch.timeScale().resetTimeScale();
        ch.timeScale().scrollToRealTime();
      } catch { /* time scale not ready */ }
      try { mainRef.current?.priceScale().applyOptions({ autoScale: true }); } catch { /* noop */ }
    };
    window.addEventListener(RESET_VIEW_EVENT, onReset);
    return () => window.removeEventListener(RESET_VIEW_EVENT, onReset);
  }, []);

  return (
    <div className="relative h-full w-full">
      <CrossInfo />
      <ChartStateOverlay symbol={symbol} timeframe={tf} status={status} count={klines.length} staleView={staleView} connected={connected} onRetry={retry} />
      <div ref={chartHostRef} className="h-full w-full" />
      <DrawingLayer chartRef={chRef} mainRef={mainRef} hostRef={chartHostRef} symbol={symbol} epoch={chartEpoch} />
      <DrawingsPanel symbol={symbol} />
    </div>
  );
}

/** Its own component so a crosshair move re-renders just this OHLC strip; if it
 *  lived inline, every pointer event would re-render the whole panel. */
function CrossInfo() {
  const d = useChartStore((s) => s.crosshairData);
  const sym = useMarketStore((s) => s.symbol);
  return (
    <div className="pointer-events-none absolute top-1 left-2 z-20 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
      {d && (<>
        <span style={{ color: "var(--text-muted)" }}>O <span style={{ color: "var(--text-secondary)" }}>{fmtPrice(d.open, sym)}</span></span>
        <span style={{ color: "var(--text-muted)" }}>H <span style={{ color: "var(--text-secondary)" }}>{fmtPrice(d.high, sym)}</span></span>
        <span style={{ color: "var(--text-muted)" }}>L <span style={{ color: "var(--text-secondary)" }}>{fmtPrice(d.low, sym)}</span></span>
        <span style={{ color: "var(--text-muted)" }}>C <span style={{ color: d.close >= d.open ? "var(--success)" : "var(--danger)" }}>{fmtPrice(d.close, sym)}</span></span>
        {d.changePct != null && (
          <span style={{ color: d.changePct >= 0 ? "var(--success)" : "var(--danger)" }}>
            {d.changePct >= 0 ? "+" : ""}{d.changePct.toFixed(2)}%
          </span>
        )}
        {d.volume > 0 && (<span style={{ color: "var(--text-muted)" }}>V <span style={{ color: "var(--text-secondary)" }}>{fmtVolume(d.volume)}</span></span>)}
        <span style={{ color: "var(--text-muted)" }}>{fmtTime(d.time)}</span>
      </>)}
    </div>
  );
}

/** Loading / empty / error states rendered above the (interactive) chart. */
function ChartStateOverlay({
  symbol, timeframe, status, count, staleView, connected, onRetry,
}: {
  symbol: string;
  timeframe: string;
  status: KlineStatus | undefined;
  count: number;
  /** The candles of the timeframe the user left are still painted. */
  staleView: boolean;
  connected: boolean;
  onRetry: () => void;
}) {
  const state = status?.state ?? "idle";

  /** Corner badge: used whenever there is something on the chart to look at, so a
   *  load in progress never hides the candles behind a full-face overlay. */
  const badge = (text: string) => (
    <div className="pointer-events-none absolute top-1 right-16 z-10 rounded px-2 py-1 text-[10px]"
      style={{ background: "var(--bg-surface)", color: "var(--warning)", border: "1px solid var(--border)" }}>
      {text}
    </div>
  );

  if (count > 0) {
    if (state === "error") return badge("History unavailable — showing live data only");
    return null;
  }

  if (staleView) {
    if (state === "loading") return badge(`Loading ${symbol} · ${timeframe} history…`);
    if (state === "error") return badge(`History unavailable for ${timeframe} — showing the previous candles`);
    return null;
  }

  let body: ReactNode;
  if (state === "loading") {
    body = (
      <div className="flex flex-col items-center gap-2">
        <div className="h-5 w-5 animate-spin rounded-full border-2" style={{ borderColor: "var(--border)", borderTopColor: "var(--accent)" }} />
        <span style={{ color: "var(--text-muted)" }}>Loading {symbol} · {timeframe} candles…</span>
      </div>
    );
  } else if (state === "error") {
    body = (
      <div className="flex flex-col items-center gap-2 text-center">
        <span style={{ color: "var(--danger)" }}>Failed to load historical data</span>
        {status?.error && <span className="max-w-[320px] text-[10px]" style={{ color: "var(--text-muted)" }}>{status.error}</span>}
        <div className="flex items-center gap-2">
          <button onClick={onRetry} className="pointer-events-auto rounded px-2 py-1 text-[11px]"
            style={{ background: "color-mix(in srgb, var(--accent) 15%, transparent)", color: "var(--accent)", border: "1px solid var(--border)" }}>
            Retry
          </button>
          {!connected && <span className="text-[10px]" style={{ color: "var(--warning)" }}>Waiting for connection…</span>}
        </div>
      </div>
    );
  } else if (!connected) {
    body = <span style={{ color: "var(--text-muted)" }}>Connecting…</span>;
  } else {
    body = (
      <div className="flex flex-col items-center gap-2 text-center">
        <span style={{ color: "var(--text-muted)" }}>No chart data for {symbol} · {timeframe}</span>
        <button onClick={onRetry} className="pointer-events-auto rounded px-2 py-1 text-[11px]"
          style={{ background: "color-mix(in srgb, var(--accent) 15%, transparent)", color: "var(--accent)", border: "1px solid var(--border)" }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center" style={{ background: "color-mix(in srgb, var(--bg-primary) 55%, transparent)" }}>
      {body}
    </div>
  );
}
