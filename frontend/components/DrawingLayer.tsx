"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { IChartApi, ISeriesApi, MouseEventParams, SeriesType, Time } from "lightweight-charts";
import { useChartStore, selectDrawings } from "@/lib/store/chartStore";
import {
  FIB_LEVELS, drawingForTool, isPlacementTool, pointsRequired, positionMetrics,
} from "@/lib/utils/drawings";
import { fmtPrice } from "@/lib/utils/format";
import type { ChartTool, Drawing, DrawingPoint } from "@/lib/types";

interface Props {
  chartRef: RefObject<IChartApi | null>;
  mainRef: RefObject<ISeriesApi<SeriesType> | null>;
  symbol: string;
  /** Bumped whenever the chart instance is recreated. */
  epoch: number;
}

type Drag =
  | { kind: "body"; id: string; start: DrawingPoint[]; anchor: DrawingPoint }
  | { kind: "point"; id: string; index: number };

/**
 * SVG overlay for user drawings. Shapes are rendered through the chart's own
 * coordinate transforms (timeToCoordinate / priceToCoordinate) so they stay
 * glued to the candles while panning and zooming.
 *
 * Drawings belong to a symbol; with the cursor tool active they can be clicked
 * to select, then dragged (whole shape or individual anchors), locked or
 * deleted. Nothing here touches orders — these are chart annotations only.
 */
export function DrawingLayer({ chartRef, mainRef, symbol, epoch }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drawings = useChartStore((s) => selectDrawings(s, symbol));
  const showDrawings = useChartStore((s) => s.settings.showDrawings);
  const activeTool = useChartStore((s) => s.activeTool);
  const selectedId = useChartStore((s) => s.selectedId);
  const [tick, setTick] = useState(0);

  const pendingRef = useRef<DrawingPoint[]>([]);
  const cursorRef = useRef<DrawingPoint | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pressRef = useRef<{ x: number; y: number; pt: DrawingPoint } | null>(null);
  /** True while the first anchor of the current shape came from an active press. */
  const anchoredRef = useRef(false);

  // Half-finished shapes never survive a tool or symbol change.
  useEffect(() => {
    pendingRef.current = [];
    cursorRef.current = null;
    dragRef.current = null;
    pressRef.current = null;
    anchoredRef.current = false;
    setTick((t) => t + 1);
  }, [activeTool, symbol]);

  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      pendingRef.current = [];
      cursorRef.current = null;
      pressRef.current = null;
      anchoredRef.current = false;
      setTick((t) => t + 1);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);

  // Chart event wiring (re-bound after the chart instance is recreated).
  useEffect(() => {
    const chart = chartRef.current;
    // Only the chart is guaranteed to exist when this (child) effect runs; the
    // main series ref is assigned by the parent's data effect, which runs
    // *after* this one. So bind on the chart alone and resolve the series
    // lazily inside each callback — otherwise click placement never binds.
    if (!chart) return;

    // Redraw requests arrive per mouse-move/pan event; coalescing them to one
    // frame keeps the SVG overlay from re-rendering several times per frame.
    let raf = 0;
    const bump = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setTick((t) => t + 1);
      });
    };
    const state = useChartStore.getState;

    const pointOf = (p: MouseEventParams<Time>): DrawingPoint | null => {
      const main = mainRef.current;
      if (!main || !p.point || typeof p.time !== "number") return null;
      const price = main.coordinateToPrice(p.point.y);
      if (price == null) return null;
      return { time: p.time, price: Number(price) };
    };

    const onCrosshair = (p: MouseEventParams<Time>) => {
      if (!isPlacementTool(state().activeTool)) { cursorRef.current = null; return; }
      cursorRef.current = pointOf(p);
      bump();
    };

    const plotPointAt = (clientX: number, clientY: number): DrawingPoint | null => {
      const main = mainRef.current;
      const svg = svgRef.current;
      if (!main || !svg) return null;
      const rect = svg.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      // A click on the price axis still resolves to a (clamped) time, so bound
      // the horizontal side to the plot ourselves.
      if (x < 0 || y < 0 || x > chart.timeScale().width()) return null;
      const time = chart.timeScale().coordinateToTime(x);
      const price = main.coordinateToPrice(y);
      if (typeof time !== "number" || price == null) return null;
      return { time, price: Number(price) };
    };

    /** Screen distance between two anchors; null (off-scale) counts as far apart. */
    const distance = (a: DrawingPoint, b: DrawingPoint): number => {
      const main = mainRef.current;
      if (!main) return Infinity;
      const ax = chart.timeScale().timeToCoordinate(a.time as Time);
      const ay = main.priceToCoordinate(a.price);
      const bx = chart.timeScale().timeToCoordinate(b.time as Time);
      const by = main.priceToCoordinate(b.price);
      if (ax == null || ay == null || bx == null || by == null) return Infinity;
      return Math.hypot(ax - bx, ay - by);
    };

    /**
     * Append one anchor, completing (and persisting) the shape once the tool
     * has all of its points. Anchors closer than a few pixels are dropped:
     * they would build a zero-length shape that renders nothing and therefore
     * cannot be selected or removed.
     */
    const addPoint = (pt: DrawingPoint, tool: ChartTool) => {
      const pending = pendingRef.current;
      const last = pending[pending.length - 1];
      if (last && distance(last, pt) < 4) return;
      pending.push(pt);
      const need = pointsRequired(tool);
      if (pending.length < need) { bump(); return; }
      const d = drawingForTool(symbol, tool, pending.slice(0, need));
      pendingRef.current = [];
      cursorRef.current = null;
      anchoredRef.current = false;
      if (d) state().addDrawing(symbol, d);
      // Staying on the tool (like TradingView) would strand partial shapes;
      // drop back to the cursor so a stray click cannot start a new one.
      state().setActiveTool("crosshair");
      bump();
    };

    /*
     * Anchors come from raw mouse events, not chart.subscribeClick: that
     * delegate suppresses any second press within 500ms of the first
     * (double-click detection), which silently drops an anchor and leaves a
     * stale half-shape behind that a later click then completes in the wrong
     * place.
     *
     * Two gestures are supported: click-click (one anchor per press/release
     * pair) and press-drag-release, where multi-point tools anchor on press so
     * the rubber-band preview follows the drag and the release point closes it.
     */
    const onDown = (e: MouseEvent) => {
      pressRef.current = null;
      anchoredRef.current = false;
      if (e.button !== 0 || isUiControl(e.target)) return;
      const tool = state().activeTool;
      if (!isPlacementTool(tool)) return;
      const pt = plotPointAt(e.clientX, e.clientY);
      if (!pt) return;
      pressRef.current = { x: e.clientX, y: e.clientY, pt };
      if (pointsRequired(tool) >= 2 && pendingRef.current.length === 0) {
        pendingRef.current = [pt];
        anchoredRef.current = true;
        bump();
      }
    };

    const onUp = (e: MouseEvent) => {
      const press = pressRef.current;
      pressRef.current = null;
      if (!press || e.button !== 0 || isUiControl(e.target)) return;
      const tool = state().activeTool;
      if (!isPlacementTool(tool)) { anchoredRef.current = false; return; }
      const moved = Math.abs(e.clientX - press.x) > 4 || Math.abs(e.clientY - press.y) > 4;
      if (moved) {
        // Only a press that anchored a shape may close it on release;
        // otherwise the gesture was a pan.
        if (anchoredRef.current) addPoint(plotPointAt(e.clientX, e.clientY) ?? press.pt, tool);
        anchoredRef.current = false;
        return;
      }
      anchoredRef.current = false;
      // Click-click: the press anchor is already pending, so this adds the
      // next point (and is rejected as degenerate if it is the same one).
      addPoint(press.pt, tool);
    };

    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(bump);
    chart.subscribeCrosshairMove(onCrosshair);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("mouseup", onUp, true);

    const ro = new ResizeObserver(bump);
    if (svgRef.current?.parentElement) ro.observe(svgRef.current.parentElement);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(bump);
      chart.unsubscribeCrosshairMove(onCrosshair);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", onUp, true);
      ro.disconnect();
    };
  }, [chartRef, mainRef, symbol, epoch]);

  // ── Drag editing ────────────────────────────────────────────────────
  // Applied per move (not on an animation frame): a frame callback can be
  // skipped entirely, which would silently drop the drag. The expensive part —
  // writing the drawing blob to localStorage — is debounced inside the store.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      const chart = chartRef.current;
      const main = mainRef.current;
      const svg = svgRef.current;
      if (!drag || !chart || !main || !svg) return;
      const rect = svg.getBoundingClientRect();
      const t = chart.timeScale().coordinateToTime(e.clientX - rect.left);
      const price = main.coordinateToPrice(e.clientY - rect.top);
      if (typeof t !== "number" || price == null) return;
      const state = useChartStore.getState();
      const cur = selectDrawings(state, symbol).find((d) => d.id === drag.id);
      if (!cur || cur.locked) return;

      if (drag.kind === "point") {
        const next = cur.points.map((p, i) => {
          if (i !== drag.index) return p;
          if (cur.type === "horizontal") return { ...p, price: Number(price) };
          if (cur.type === "vertical") return { ...p, time: t };
          return { time: t, price: Number(price) };
        });
        state.updateDrawingPoints(symbol, drag.id, next);
        return;
      }

      const dx = t - drag.anchor.time;
      const dy = Number(price) - drag.anchor.price;
      const next = drag.start.map((p) => {
        if (cur.type === "horizontal") return { ...p, price: p.price + dy };
        if (cur.type === "vertical") return { ...p, time: p.time + dx };
        return { time: p.time + dx, price: p.price + dy };
      });
      state.updateDrawingPoints(symbol, drag.id, next);
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [chartRef, mainRef, symbol]);

  const chart = chartRef.current;
  const main = mainRef.current;
  const W = svgRef.current?.clientWidth ?? 0;
  const H = svgRef.current?.clientHeight ?? 0;

  const xOf = (time: number) => (chart ? chart.timeScale().timeToCoordinate(time as Time) : null);
  const yOf = (price: number) => (main ? main.priceToCoordinate(price) : null);

  const nodes: React.ReactNode[] = [];
  const interactive = activeTool === "crosshair";

  const startBodyDrag = (d: Drawing, e: React.MouseEvent) => {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    const st = useChartStore.getState();
    // A locked drawing still has to be selectable, or the lock could never be
    // turned off again — it just refuses to move.
    st.selectDrawing(d.id);
    if (d.locked) return;
    st.beginDrawingHistory(symbol);
    const anchor = anchorOf(e, chartRef, mainRef, svgRef);
    if (!anchor) return;
    dragRef.current = { kind: "body", id: d.id, start: d.points.map((p) => ({ ...p })), anchor };
  };

  const startPointDrag = (d: Drawing, index: number, e: React.MouseEvent) => {
    if (!interactive || d.locked) return;
    e.stopPropagation();
    e.preventDefault();
    useChartStore.getState().beginDrawingHistory(symbol);
    dragRef.current = { kind: "point", id: d.id, index };
  };

  if (chart && main && showDrawings && W > 0 && H > 0) {
    for (const d of drawings) {
      nodes.push(renderDrawing(d, {
        symbol, xOf, yOf, W, H,
        selected: d.id === selectedId,
        interactive,
        onBody: (e) => startBodyDrag(d, e),
        onHandle: (i, e) => startPointDrag(d, i, e),
      }));
    }
    const preview = previewNodes(pendingRef.current.concat(cursorRef.current ?? []), activeTool, xOf, yOf, W, H);
    if (preview) nodes.push(preview);
  }

  const selected = drawings.find((d) => d.id === selectedId);
  const actions = selected && showDrawings
    ? actionBar(selected, svgRef, xOf, yOf)
    : null;

  // `tick` participates only as a redraw trigger for the imperative transforms.
  return (
    <>
      <svg
        ref={svgRef}
        data-tick={tick}
        className="pointer-events-none absolute inset-0 z-10 h-full w-full"
        style={{ cursor: isPlacementTool(activeTool) ? "crosshair" : "default" }}
      >
        {nodes}
      </svg>
      {actions}
    </>
  );
}

/** Presses on a control (the action bar, toolbar) must never place an anchor. */
function isUiControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button,a,input,select") !== null;
}

/** Screen point -> chart coordinates. Both axes have to resolve, so a press
 *  over an axis area (outside the scales) places nothing. */
function anchorOf(
  e: React.MouseEvent,
  chartRef: RefObject<IChartApi | null>,
  mainRef: RefObject<ISeriesApi<SeriesType> | null>,
  svgRef: RefObject<SVGSVGElement | null>,
): DrawingPoint | null {
  const chart = chartRef.current;
  const main = mainRef.current;
  const svg = svgRef.current;
  if (!chart || !main || !svg) return null;
  const rect = svg.getBoundingClientRect();
  const t = chart.timeScale().coordinateToTime(e.clientX - rect.left);
  const price = main.coordinateToPrice(e.clientY - rect.top);
  if (typeof t !== "number" || price == null) return null;
  return { time: t, price: Number(price) };
}

/** Small floating control strip next to the selected shape. */
function actionBar(
  d: Drawing,
  svgRef: RefObject<SVGSVGElement | null>,
  xOf: (t: number) => number | null,
  yOf: (p: number) => number | null,
) {
  const el = svgRef.current;
  if (!el) return null;
  const xs = d.points.map((p) => xOf(p.time)).filter((v): v is number => v != null);
  const ys = d.points.map((p) => yOf(p.price)).filter((v): v is number => v != null);
  const x = xs.length ? Math.max(4, Math.min(Math.min(...xs), el.clientWidth - 96)) : 8;
  const y = ys.length ? Math.max(4, Math.min(...ys) - 30) : 8;
  const st = useChartStore.getState();
  const btn = "pointer-events-auto flex h-6 w-6 items-center justify-center rounded text-[12px]";
  const style = { background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", color: "var(--text-secondary)" };
  return (
    <div className="absolute z-20 flex gap-1" style={{ left: x, top: y }}>
      <button
        className={btn}
        style={style}
        title={d.locked ? "Unlock drawing" : "Lock drawing"}
        aria-label={d.locked ? "Unlock drawing" : "Lock drawing"}
        onClick={() => st.updateDrawing(d.symbol, d.id, { locked: !d.locked })}
      >
        {d.locked ? "🔒" : "🔓"}
      </button>
      <button
        className={btn}
        style={style}
        title="Delete drawing"
        aria-label="Delete drawing"
        onClick={() => st.removeDrawing(d.symbol, d.id)}
      >
        ✕
      </button>
    </div>
  );
}

interface Geom {
  symbol: string;
  xOf: (t: number) => number | null;
  yOf: (p: number) => number | null;
  W: number;
  H: number;
  selected: boolean;
  interactive: boolean;
  onBody: (e: React.MouseEvent) => void;
  onHandle: (index: number, e: React.MouseEvent) => void;
}

/**
 * A locked drawing must stay clickable: it still has to be selectable,
 * otherwise the lock could never be removed. The drag handlers refuse locked
 * shapes, so clicking only selects.
 */
function hitProps(g: Geom, d: Drawing) {
  return {
    stroke: "transparent",
    strokeWidth: 12,
    fill: "none",
    style: {
      pointerEvents: g.interactive ? ("stroke" as const) : ("none" as const),
      cursor: d.locked ? "default" : "move",
    },
    onMouseDown: g.onBody,
  };
}

/** Anchor dots for the selected drawing. Hidden while locked — a locked
 *  drawing must not be re-anchored, only viewed. */
function Handles({ g, d }: { g: Geom; d: Drawing }) {
  if (!g.selected || !g.interactive || d.locked) return null;
  const points = d.points;
  return (
    <>
      {points.map((p, i) => {
        const x = g.xOf(p.time);
        const y = g.yOf(p.price);
        if (x == null || y == null) return null;
        return (
          <circle
            key={`h-${i}`}
            cx={x}
            cy={y}
            r={4}
            fill="var(--bg-elevated)"
            stroke="var(--accent)"
            strokeWidth={1.5}
            style={{ pointerEvents: "all", cursor: "grab" }}
            onMouseDown={(e) => g.onHandle(i, e)}
          />
        );
      })}
    </>
  );
}

/** The one shape switch: every drawing type paints from `g`'s live transforms,
 *  so an unknown coordinate off-screen returns null instead of a stray shape. */
function renderDrawing(d: Drawing, g: Geom): React.ReactNode {
  if (d.visible === false) return null;
  const [p1, p2, p3] = d.points;
  if (!p1) return null;
  const width = g.selected ? 2 : 1.5;
  const key = d.id;

  if (d.type === "horizontal") {
    const y = g.yOf(p1.price);
    if (y == null) return null;
    return (
      <g key={key} style={{ color: d.color }}>
        <line x1={0} y1={y} x2={g.W} y2={y} {...hitProps(g, d)} />
        <line x1={0} y1={y} x2={g.W} y2={y} stroke={d.color} strokeWidth={width} pointerEvents="none" />
        <g pointerEvents="none">
          <rect x={3} y={y - 8} width={72} height={15} rx={2} fill="var(--bg-elevated)" stroke="var(--border-strong)" />
          <text x={7} y={y + 3} fontSize={10} fill={d.color}>{fmtPrice(p1.price, g.symbol)}</text>
        </g>
        <Handles g={g} d={d} />
      </g>
    );
  }

  if (d.type === "vertical") {
    const x = g.xOf(p1.time);
    if (x == null) return null;
    return (
      <g key={key}>
        <line x1={x} y1={0} x2={x} y2={g.H} {...hitProps(g, d)} />
        <line x1={x} y1={0} x2={x} y2={g.H} stroke={d.color} strokeWidth={width} strokeDasharray="4 3" pointerEvents="none" />
        <Handles g={g} d={d} />
      </g>
    );
  }

  if ((d.type === "trendline" || d.type === "ray" || d.type === "measure") && p2) {
    const x1 = g.xOf(p1.time), y1 = g.yOf(p1.price);
    const x2 = g.xOf(p2.time), y2 = g.yOf(p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
    // A ray keeps going past its second anchor to the edge of the plot.
    let ex = x2, ey = y2;
    if (d.type === "ray") {
      const dx = x2 - x1, dy = y2 - y1;
      if (dx !== 0 || dy !== 0) {
        const target = dx >= 0 ? g.W : 0;
        const k = (target - x1) / (dx || 1e-9);
        ex = target;
        ey = y1 + dy * k;
      }
    }
    const dashed = d.type === "measure";
    return (
      <g key={key}>
        <line x1={x1} y1={y1} x2={ex} y2={ey} {...hitProps(g, d)} />
        <line x1={x1} y1={y1} x2={ex} y2={ey} stroke={d.color} strokeWidth={width} strokeDasharray={dashed ? "5 4" : undefined} pointerEvents="none" />
        <Handles g={g} d={d} />
        {dashed && measureLabel(d, g, (x1 + x2) / 2, (y1 + y2) / 2)}
      </g>
    );
  }

  if (d.type === "fibonacci" && p2) {
    const x1 = g.xOf(p1.time), x2 = g.xOf(p2.time);
    if (x1 == null || x2 == null) return null;
    // Minimum box size: a shape squashed onto one point would otherwise be
    // invisible and impossible to select again.
    const left = Math.min(x1, x2), right = Math.max(x1, x2, left + 8);
    const rows = FIB_LEVELS.map((lvl) => {
      const price = p1.price + (p2.price - p1.price) * lvl;
      const y = g.yOf(price);
      return y == null ? null : { lvl, price, y };
    }).filter((r): r is { lvl: number; price: number; y: number } => r != null);
    const ys = rows.map((r) => r.y);
    const topY = ys.length ? Math.min(...ys) : 0;
    const bottomY = ys.length ? Math.max(...ys) : 0;
    return (
      <g key={key}>
        {rows.length > 0 && (
          <rect
            x={left} y={topY} width={right - left} height={Math.max(bottomY - topY, 8)}
            fill={d.color} fillOpacity={0.07} stroke="transparent"
            style={{ pointerEvents: g.interactive ? "fill" : "none", cursor: d.locked ? "default" : "move" }}
            onMouseDown={g.onBody}
          />
        )}
        {rows.map((r) => (
          <g key={r.lvl} pointerEvents="none">
            <line x1={left} y1={r.y} x2={right} y2={r.y} stroke={d.color} strokeWidth={r.lvl === 0 || r.lvl === 1 ? width : 1} opacity={0.85} />
            <text x={right + 3} y={r.y + 3} fontSize={9} fill={d.color}>
              {r.lvl.toFixed(3)} · {fmtPrice(r.price, g.symbol)}
            </text>
          </g>
        ))}
        <Handles g={g} d={d} />
      </g>
    );
  }

  if ((d.type === "longPosition" || d.type === "shortPosition") && p2 && p3) {
    const m = positionMetrics(d.points);
    const x1 = g.xOf(p1.time);
    const x2 = Math.max(g.xOf(p2.time) ?? 0, g.xOf(p3.time) ?? 0);
    const yEntry = g.yOf(p1.price), yTarget = g.yOf(p2.price), yStop = g.yOf(p3.price);
    if (x1 == null || x2 == null || yEntry == null || yTarget == null || yStop == null || !m) return null;
    const left = Math.min(x1, x2);
    // Keep a grabbable width even when the anchors are dragged onto each other.
    const right = Math.max(x1, x2, left + 8);
    const up = "#10b981", dn = "#f43f5e";
    // The tool the user picked decides long/short — not the accidental case
    // where the anchors were dragged past each other.
    const isLong = d.type === "longPosition";
    const profitFill = isLong ? up : dn;
    const lossFill = isLong ? dn : up;
    return (
      <g key={key}>
        <rect x={left} y={Math.min(yEntry, yTarget)} width={right - left} height={Math.abs(yTarget - yEntry)}
          fill={profitFill} fillOpacity={0.16} stroke="transparent"
          style={{ pointerEvents: g.interactive ? "fill" : "none", cursor: d.locked ? "default" : "move" }}
          onMouseDown={g.onBody} />
        <rect x={left} y={Math.min(yEntry, yStop)} width={right - left} height={Math.abs(yStop - yEntry)}
          fill={lossFill} fillOpacity={0.16} stroke="transparent"
          style={{ pointerEvents: g.interactive ? "fill" : "none", cursor: d.locked ? "default" : "move" }}
          onMouseDown={g.onBody} />
        {[{ y: yEntry, c: "var(--text-primary)" }, { y: yTarget, c: profitFill }, { y: yStop, c: lossFill }].map((l, i) => (
          <line key={i} x1={left} y1={l.y} x2={right} y2={l.y} stroke={l.c} strokeWidth={i === 0 ? width : 1} pointerEvents="none" />
        ))}
        <g pointerEvents="none">
          <rect x={left + 4} y={Math.min(yEntry, yTarget, yStop) - 1} height={14} width={168} rx={3}
            fill="var(--bg-elevated)" stroke="var(--border-strong)" opacity={0.92} />
          <text x={left + 9} y={Math.min(yEntry, yTarget, yStop) + 10} fontSize={10} fill="var(--text-secondary)">
            {isLong ? "LONG" : "SHORT"} · risk {m.riskPct.toFixed(2)}% · reward {m.rewardPct.toFixed(2)}% · R:R {m.rr == null ? "—" : `1:${m.rr.toFixed(2)}`}
          </text>
          {[{ y: yTarget, t: `TP ${fmtPrice(m.target, g.symbol)}`, c: profitFill },
             { y: yStop, t: `SL ${fmtPrice(m.stop, g.symbol)}`, c: lossFill },
             { y: yEntry, t: `Entry ${fmtPrice(m.entry, g.symbol)}`, c: "var(--text-primary)" }].map((l, i) => (
            <text key={i} x={right + 3} y={l.y + 3} fontSize={9} fill={l.c}>{l.t}</text>
          ))}
        </g>
        <Handles g={g} d={d} />
      </g>
    );
  }

  return null;
}

/** Price-measurement readout: absolute + percentage change over the anchored
 *  time span. `x/y` are already the label's screen position, chosen by the caller. */
function measureLabel(d: Drawing, g: Geom, x: number, y: number) {
  const [p1, p2] = d.points;
  if (!p1 || !p2) return null;
  const diff = p2.price - p1.price;
  const pct = p1.price !== 0 ? (diff / p1.price) * 100 : 0;
  const minutes = Math.round(Math.abs(p2.time - p1.time) / 60);
  const label = `${diff >= 0 ? "+" : ""}${diff.toPrecision(4)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) · ${minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`}`;
  return (
    <g pointerEvents="none">
      <rect x={x - 78} y={y - 20} width={156} height={15} rx={3} fill="var(--bg-elevated)" stroke="var(--border-strong)" />
      <text x={x} y={y - 9} fontSize={10} textAnchor="middle" fill={diff >= 0 ? "var(--success)" : "var(--danger)"}>{label}</text>
    </g>
  );
}

/** Dashed in-progress shape while a placement tool collects clicks. */
function previewNodes(
  points: DrawingPoint[],
  tool: ChartTool,
  xOf: (t: number) => number | null,
  yOf: (p: number) => number | null,
  W: number,
  H: number,
): React.ReactNode {
  if (!isPlacementTool(tool) || points.length < 2) return null;
  const a = points[points.length - 2]!, b = points[points.length - 1]!;
  const x1 = xOf(a.time), y1 = yOf(a.price), x2 = xOf(b.time), y2 = yOf(b.price);
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
  const end = tool === "trendline" || tool === "ray" || tool === "measure"
    ? { x: x2, y: y2 }
    : tool === "horizontal"
      ? { x: W, y: y1 }
      : { x: x1, y: H };
  return (
    <g key="preview" pointerEvents="none">
      <line x1={x1} y1={y1} x2={end.x} y2={end.y} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="5 4" opacity={0.85} />
      <circle cx={x1} cy={y1} r={3} fill="var(--accent)" />
    </g>
  );
}
