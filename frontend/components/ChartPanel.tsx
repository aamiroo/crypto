"use client";
import { useEffect, useRef, useCallback, useMemo, useState, type ReactNode } from "react";
import { createChart, ColorType, CrosshairMode, type IChartApi, type ISeriesApi, type SeriesType, type Time } from "lightweight-charts";
import { useMarketStore, selectKlines, type KlineStatus } from "@/lib/store/marketStore";
import { useChartStore } from "@/lib/store/chartStore";
import { sma, ema, rsi, macd, bollinger, klineCloses } from "@/lib/utils/indicators";
import { fmtPrice, fmtVolume } from "@/lib/utils/format";
import { useThemeStore } from "@/lib/store/themeStore";
import {
  EMPTY_KLINES, buildTimeIndex, diffKlines, hasOscillator, klineKey,
  toCandleBars, toLineBars, toVolumeBars,
} from "@/lib/utils/klines";
import { loadHistoricalKlines, loadOlderKlines } from "@/lib/api/klines";
import type { ChartType, KlineData } from "@/lib/types";

function getTc(t: string) {
  return t === "light"
    ? { bg: "#fff", tx: "#6c757d", gr: "#e9ecef", bd: "#dee2e6", cr: "#868e96", up: "#12b886", dn: "#e03131", uv: "rgba(18,184,134,0.3)", dv: "rgba(224,49,49,0.3)" }
    : { bg: "#0b0e11", tx: "#71717a", gr: "#1a1d23", bd: "#1c1f26", cr: "#3f3f46", up: "#10b981", dn: "#f43f5e", uv: "rgba(16,185,129,0.3)", dv: "rgba(244,63,94,0.3)" };
}

/** Start fetching older history once the left edge gets within this many bars. */
const LOAD_MORE_THRESHOLD = 5;

type AltKind = "line" | "area";
type AltSeries = ISeriesApi<"Line" | "Area">;

export function ChartPanel({ symbol }: { symbol: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chRef = useRef<IChartApi | null>(null);
  const csRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vsRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const altRef = useRef<Partial<Record<AltKind, AltSeries>>>({});
  const indRef = useRef<Map<string, ISeriesApi<SeriesType>[]>>(new Map());
  /** Klines last pushed to the rendered series — drives incremental updates. */
  const lastRef = useRef<KlineData[]>(EMPTY_KLINES);
  const timeIdxRef = useRef<Map<Time, KlineData>>(new Map());
  const loadOlderRef = useRef<(() => void) | null>(null);
  const ctRef = useRef<ChartType | null>(null);
  const visRef = useRef<string>("");
  const [chartEpoch, setChartEpoch] = useState(0);

  const tf = useChartStore((s) => s.timeframe);
  const ct = useChartStore((s) => s.chartType);
  const klines = useMarketStore((s) => selectKlines(s, symbol, tf));
  const inds = useChartStore((s) => s.indicators);
  const st = useChartStore((s) => s.settings);
  const setCD = useChartStore((s) => s.setCrosshairData);
  const theme = useThemeStore((s) => s.theme);
  const status = useMarketStore((s) => s.klineStatus[klineKey(symbol, tf)]);
  const connected = useMarketStore((s) => s.connected);
  const osc = useMemo(() => hasOscillator(inds, st.showIndicators), [inds, st.showIndicators]);

  // ── Chart lifecycle (created once per theme) ─────────────────────────
  useEffect(() => {
    const el = ref.current;
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
    // The previous chart instance is gone — force a full re-push of data.
    lastRef.current = EMPTY_KLINES;
    timeIdxRef.current = new Map();

    ch.subscribeCrosshairMove((p) => {
      if (!p.time) { setCD(null); return; }
      const k = timeIdxRef.current.get(p.time);
      if (!k) { setCD(null); return; }
      setCD({ time: k.openTime, open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: +k.volume });
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
      }
    };
  }, [theme, setCD]);

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

    const timeScale = ch.timeScale();
    const logicalRange = plan.kind === "full" ? timeScale.getVisibleLogicalRange() : null;
    const timeRange = timeScale.getVisibleRange();

    const applyFull = () => {
      if (ct === "candlestick") active.setData(toCandleBars(klines));
      else active.setData(toLineBars(klines));
      vs.setData(toVolumeBars(klines, colors.uv, colors.dv));
    };

    if (plan.kind === "empty") {
      // Clear every series so a symbol/timeframe switch never shows stale bars.
      cs.setData([]);
      vs.setData([]);
      altRef.current.line?.setData([]);
      altRef.current.area?.setData([]);
      lastRef.current = EMPTY_KLINES;
      timeIdxRef.current = new Map();
      return;
    }

    if (plan.kind === "tail") {
      // Same window, only the newest bars changed: cheap incremental update,
      // viewport untouched so panning/zooming never jumps.
      for (let i = plan.from; i < klines.length; i++) {
        const k = klines[i]!;
        const t = Math.floor(k.openTime / 1000) as Time;
        if (ct === "candlestick") active.update({ time: t, open: +k.open, high: +k.high, low: +k.low, close: +k.close });
        else active.update({ time: t, value: +k.close });
        vs.update({ time: t, value: +k.volume, color: +k.close >= +k.open ? colors.uv : colors.dv });
      }
      const idx = timeIdxRef.current;
      for (let i = plan.from; i < klines.length; i++) {
        const k = klines[i]!;
        idx.set(Math.floor(k.openTime / 1000) as Time, k);
      }
      lastRef.current = klines;
      return;
    }

    // full / first: structural change — restore the viewport where possible.
    applyFull();

    const bars = klines;
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

    lastRef.current = bars;
    timeIdxRef.current = buildTimeIndex(bars);
  }, [klines, ct, theme, chartEpoch]);

  // ── Indicators: stable series registry (create once, refresh data) ──
  useEffect(() => {
    const ch = chRef.current;
    if (!ch) return;

    const wanted = new Map<string, ISeriesApi<SeriesType>[]>();
    if (st.showIndicators && klines.length > 0) {
      const closes = klineCloses(klines);
      const times = klines.map((k) => Math.floor(k.openTime / 1000) as Time);

      const points = (vals: (number | null)[]) => {
        const out: { time: Time; value: number }[] = [];
        for (let j = 0; j < vals.length; j++) {
          const v = vals[j];
          if (v != null && Number.isFinite(v) && times[j] !== undefined) out.push({ time: times[j]!, value: v });
        }
        return out;
      };
      const addLine = (vals: (number | null)[], color: string, priceScaleId: string) => {
        const line = ch.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceScaleId });
        line.setData(points(vals));
        return line as ISeriesApi<SeriesType>;
      };

      for (const ind of inds) {
        if (!ind.visible) continue;
        const reused = indRef.current.get(ind.id);
        let series: ISeriesApi<SeriesType>[];
        if (ind.type === "sma" || ind.type === "ema") {
          const vals = ind.type === "ema" ? ema(closes, ind.period) : sma(closes, ind.period);
          series = reused ?? [addLine(vals, ind.color || "#f59e0b", "right")];
          if (reused) (reused[0] as ISeriesApi<"Line">).setData(points(vals));
        } else if (ind.type === "bb") {
          const { upper, middle, lower } = bollinger(closes, ind.period || 20, 2);
          const source = [upper, middle, lower];
          series = reused ?? source.map((vals, idx) => addLine(vals, idx === 1 ? "rgba(245,158,11,0.5)" : "#f59e0b", "right"));
          if (reused) reused.forEach((s, idx) => (s as ISeriesApi<"Line">).setData(points(source[idx]!)));
        } else if (ind.type === "rsi") {
          const vals = rsi(closes, ind.period || 14);
          series = reused ?? [addLine(vals, ind.color || "#8b5cf6", "rsi")];
          if (reused) (reused[0] as ISeriesApi<"Line">).setData(points(vals));
        } else if (ind.type === "macd") {
          const { macdLine, signalLine, histogram } = macd(closes);
          if (!reused) {
            const line1 = addLine(macdLine, "#2196f3", "macd");
            const line2 = addLine(signalLine, "#ff9800", "macd");
            const hist = ch.addHistogramSeries({ priceScaleId: "macd" });
            hist.setData(points(histogram).map((p) => ({ ...p, color: p.value >= 0 ? "rgba(16,185,129,0.6)" : "rgba(244,63,94,0.6)" })));
            series = [line1, line2, hist as ISeriesApi<SeriesType>];
          } else {
            (reused[0] as ISeriesApi<"Line">).setData(points(macdLine));
            (reused[1] as ISeriesApi<"Line">).setData(points(signalLine));
            (reused[2] as ISeriesApi<"Histogram">).setData(points(histogram).map((p) => ({ ...p, color: p.value >= 0 ? "rgba(16,185,129,0.6)" : "rgba(244,63,94,0.6)" })));
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
  }, [klines, inds, st.showIndicators, chartEpoch]);

  // ── Price scale layout + volume visibility (follows the toggles) ─────
  useEffect(() => {
    const ch = chRef.current;
    if (!ch) return;
    const showVolume = st.showVolume;
    // Reserve pane space: volume band at the bottom, oscillator band above it.
    const bottom = 0.05 + (showVolume ? 0.2 : 0) + (osc ? (showVolume ? 0.15 : 0.35) : 0);
    ch.priceScale("right").applyOptions({ scaleMargins: { top: 0.05, bottom } });
    if (osc) {
      const oscTop = Math.min(1 - bottom + 0.02, 0.9);
      const oscOpts = { scaleMargins: { top: oscTop, bottom: showVolume ? 0.17 : 0.03 } };
      ch.priceScale("rsi").applyOptions(oscOpts);
      ch.priceScale("macd").applyOptions(oscOpts);
    }
    vsRef.current?.applyOptions({ visible: showVolume });
  }, [st.showVolume, osc, chartEpoch]);

  // ── Grid toggle (re-applied after chart recreation) ───────────────────
  useEffect(() => {
    chRef.current?.applyOptions({ grid: { vertLines: { visible: st.showGrid }, horzLines: { visible: st.showGrid } } });
  }, [st.showGrid, chartEpoch]);

  // ── Scroll-back wiring ───────────────────────────────────────────────
  const loadOlder = useCallback(() => { void loadOlderKlines(symbol, tf); }, [symbol, tf]);
  useEffect(() => { loadOlderRef.current = loadOlder; }, [loadOlder]);

  const retry = useCallback(() => { void loadHistoricalKlines(symbol, tf); }, [symbol, tf]);

  return (
    <div className="relative h-full w-full">
      <CrossInfo />
      <ChartStateOverlay symbol={symbol} timeframe={tf} status={status} count={klines.length} connected={connected} onRetry={retry} />
      <div ref={ref} className="h-full w-full" />
    </div>
  );
}

function CrossInfo() {
  const d = useChartStore((s) => s.crosshairData);
  const sym = useMarketStore((s) => s.symbol);
  return (
    <div className="pointer-events-none absolute top-1 left-2 z-10 flex items-center gap-3 text-[11px] tabular-nums">
      {d && (<>
        <span style={{ color: "var(--text-muted)" }}>O <span style={{ color: "var(--text-secondary)" }}>{fmtPrice(d.open, sym)}</span></span>
        <span style={{ color: "var(--text-muted)" }}>H <span style={{ color: "var(--text-secondary)" }}>{fmtPrice(d.high, sym)}</span></span>
        <span style={{ color: "var(--text-muted)" }}>L <span style={{ color: "var(--text-secondary)" }}>{fmtPrice(d.low, sym)}</span></span>
        <span style={{ color: "var(--text-muted)" }}>C <span style={{ color: d.close >= d.open ? "var(--success)" : "var(--danger)" }}>{fmtPrice(d.close, sym)}</span></span>
        {d.volume > 0 && (<span style={{ color: "var(--text-muted)" }}>V <span style={{ color: "var(--text-secondary)" }}>{fmtVolume(d.volume)}</span></span>)}
      </>)}
    </div>
  );
}

/** Loading / empty / error states rendered above the (interactive) chart. */
function ChartStateOverlay({
  symbol, timeframe, status, count, connected, onRetry,
}: {
  symbol: string;
  timeframe: string;
  status: KlineStatus | undefined;
  count: number;
  connected: boolean;
  onRetry: () => void;
}) {
  const state = status?.state ?? "idle";

  if (count > 0) {
    if (state === "error") {
      return (
        <div className="pointer-events-none absolute top-1 right-16 z-10 rounded px-2 py-1 text-[10px]"
          style={{ background: "var(--bg-surface)", color: "var(--warning)", border: "1px solid var(--border)" }}>
          History unavailable — showing live data only
        </div>
      );
    }
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
