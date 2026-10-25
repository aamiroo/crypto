"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import { useChartStore, selectDrawings } from "@/lib/store/chartStore";
import {
  FIB_LEVELS, PALETTE, TOOL_BY_ID, TYPE_LABEL, drawingForTool, isPlacementTool,
  pointsRequired, positionMetrics, toolHint,
} from "@/lib/utils/drawings";
import { fmtPrice, fmtTime } from "@/lib/utils/format";
import { EyeIcon, EyeOffIcon, LockIcon, TrashIcon, UnlockIcon } from "@/components/icons/ToolIcons";
import type { ChartTool, Drawing, DrawingPoint } from "@/lib/types";

interface Props {
  chartRef: RefObject<IChartApi | null>;
  mainRef: RefObject<ISeriesApi<SeriesType> | null>;
  /** The element lightweight-charts was created inside — wheel events have to be
   *  sent back to it (see the wheel-forwarding effect). */
  hostRef: RefObject<HTMLDivElement | null>;
  symbol: string;
  /** Bumped whenever the chart instance is recreated. */
  epoch: number;
}

type Drag =
  | { kind: "body"; id: string; start: DrawingPoint[]; anchor: DrawingPoint }
  | { kind: "point"; id: string; index: number };

/** Presses closer than this are one click, not a rubber-band drag. */
const DRAG_SLOP = 4;
/** Anchors closer than this build a shape with nothing to see or grab. */
const MIN_ANCHOR_GAP = 4;

/**
 * Chart annotations: the SVG shapes, the pointer input that places and edits
 * them, and the floating controls around the selected one.
 *
 * Geometry is projected through the chart's own transforms (timeToCoordinate /
 * priceToCoordinate) so shapes stay glued to the candles while panning.
 *
 * Input is split by mode, which is what keeps drawing from fighting the chart:
 *  - a placement tool armed → this layer captures every pointer event, so the
 *    chart cannot pan underneath a rubber-band drag (the crosshair is replayed
 *    into the chart with setCrosshairPosition so it still looks alive);
 *  - cursor tool → the layer is transparent to the pointer except on the shapes
 *    themselves, so pan/zoom stay normal and a click on empty chart deselects.
 *
 * Nothing here touches orders — these are chart annotations only.
 */
export function DrawingLayer({ chartRef, mainRef, hostRef, symbol, epoch }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drawings = useChartStore((s) => selectDrawings(s, symbol));
  const showDrawings = useChartStore((s) => s.settings.showDrawings);
  const activeTool = useChartStore((s) => s.activeTool);
  const stickyTool = useChartStore((s) => s.stickyTool);
  const selectedId = useChartStore((s) => s.selectedId);
  const setActiveTool = useChartStore((s) => s.setActiveTool);
  const setStickyTool = useChartStore((s) => s.setStickyTool);
  const [tick, setTick] = useState(0);
  /** Shape under the pointer — highlighted so clickable geometry is findable. */
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** Right-click menu on a shape: the action bar needs a selection first, and
   *  hunting for a thin line to click is exactly the friction this removes. */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** Space held: the layer lets the pointer through so the chart can be panned
   *  without disarming the tool — drawing across a wider window than one screen
   *  is otherwise impossible. */
  const [hand, setHand] = useState(false);

  const pendingRef = useRef<DrawingPoint[]>([]);
  const cursorRef = useRef<DrawingPoint | null>(null);
  /** Pointer in layer pixels, for the label that follows the cursor. */
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pressRef = useRef<{ x: number; y: number; pt: DrawingPoint } | null>(null);
  /** True while the first anchor of the current shape came from this press. */
  const anchoredRef = useRef(false);

  const placing = isPlacementTool(activeTool);
  const need = pointsRequired(activeTool);

  // Half-finished shapes never survive a tool or symbol change.
  useEffect(() => {
    pendingRef.current = [];
    cursorRef.current = null;
    dragRef.current = null;
    pressRef.current = null;
    anchoredRef.current = false;
    setMenu(null);
    setHoverId(null);
    setHand(false);
    clearCrosshair(chartRef, mainRef);
    setTick((t) => t + 1);
  }, [activeTool, symbol, chartRef, mainRef]);

  // Redraw requests arrive per mouse-move/pan event; coalescing them to one
  // frame keeps the SVG overlay from re-rendering several times per frame.
  const bump = useCallback(() => {
    requestAnimationFrame(() => setTick((t) => t + 1));
  }, []);

  // The chart is re-created on theme/type changes; the overlay must follow.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(bump);
    window.addEventListener("resize", bump);
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(bump);
      window.removeEventListener("resize", bump);
    };
  }, [chartRef, bump, epoch]);

  // A press-and-release on empty chart (the canvas, not a shape or a control)
  // drops the selection, so the action bar never floats over nothing. A drag is
  // a pan and keeps the selection. This deliberately does not use
  // chart.subscribeClick: that delegate suppresses rapid repeat clicks, which is
  // exactly the input a drawing gesture makes.
  useEffect(() => {
    let x = 0;
    let y = 0;
    const onDown = (e: MouseEvent) => {
      x = e.clientX;
      y = e.clientY;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (Math.abs(e.clientX - x) > DRAG_SLOP || Math.abs(e.clientY - y) > DRAG_SLOP) return;
      const t = e.target;
      if (!(t instanceof Element) || t.tagName.toLowerCase() !== "canvas") return;
      const st = useChartStore.getState();
      if (st.activeTool === "crosshair" && st.selectedId) st.selectDrawing(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const pointAt = useCallback((clientX: number, clientY: number): DrawingPoint | null => {
    const chart = chartRef.current;
    const main = mainRef.current;
    const layer = layerRef.current;
    if (!chart || !main || !layer) return null;
    return plotPoint(chart, main, layer.getBoundingClientRect(), clientX, clientY);
  }, [chartRef, mainRef]);

  // The overlay sits *beside* the chart's own DOM, so while a tool is armed the
  // wheel never reaches lightweight-charts and the chart cannot be zoomed
  // mid-drawing. Hand the event to whatever the overlay is covering instead.
  useEffect(() => {
    const layer = layerRef.current;
    const host = hostRef.current;
    if (!layer || !host || !placing) return;
    const onWheel = (e: WheelEvent) => {
      const was = layer.style.pointerEvents;
      layer.style.pointerEvents = "none";
      const under = document.elementFromPoint(e.clientX, e.clientY);
      layer.style.pointerEvents = was;
      if (!under || !host.contains(under)) return;
      under.dispatchEvent(new WheelEvent("wheel", {
        deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
        clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
        altKey: e.altKey, metaKey: e.metaKey, bubbles: true, cancelable: true,
      }));
      e.preventDefault();
    };
    layer.addEventListener("wheel", onWheel, { passive: false });
    return () => layer.removeEventListener("wheel", onWheel);
  }, [placing, hostRef]);

  // Space = hand tool, but only while a drawing tool is armed (otherwise the
  // global shortcut handler and the browser's own space behaviour rule).
  useEffect(() => {
    if (!placing) return;
    const isField = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isField(e.target)) return;
      e.preventDefault();
      if (e.type === "keydown") { if (!e.repeat) setHand(true); }
      else setHand(false);
    };
    const onBlur = () => setHand(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [placing]);

  /** Screen distance between two anchors; null (off-scale) counts as far apart. */
  const distance = (a: DrawingPoint, b: DrawingPoint): number => {
    const chart = chartRef.current;
    const main = mainRef.current;
    if (!chart || !main) return Infinity;
    const ax = chart.timeScale().timeToCoordinate(a.time as Time);
    const ay = main.priceToCoordinate(a.price);
    const bx = chart.timeScale().timeToCoordinate(b.time as Time);
    const by = main.priceToCoordinate(b.price);
    if (ax == null || ay == null || bx == null || by == null) return Infinity;
    return Math.hypot(ax - bx, ay - by);
  };

  /**
   * Append one anchor, completing (and persisting) the shape once the tool has
   * all of its points.
   *
   * TradingView's rhythm on completion: the tool returns to the cursor and the
   * finished shape is selected, so the next click adjusts it instead of drawing
   * another one. "Keep armed" (the flyout, or the strip below) opts out.
   */
  const addPoint = (pt: DrawingPoint, tool: ChartTool) => {
    const pending = pendingRef.current;
    const last = pending[pending.length - 1];
    if (last && distance(last, pt) < MIN_ANCHOR_GAP) return;
    pending.push(pt);
    if (pending.length < pointsRequired(tool)) { bump(); return; }
    const d = drawingForTool(symbol, tool, pending.slice(0, pointsRequired(tool)));
    pendingRef.current = [];
    cursorRef.current = null;
    anchoredRef.current = false;
    if (d) {
      const st = useChartStore.getState();
      if (!st.stickyTool) st.setActiveTool("crosshair");
      // Runs after the tool switch: setActiveTool clears the selection, so the
      // order is what leaves the new shape with its handles showing.
      st.addDrawing(symbol, d);
    }
    bump();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // The floating controls are children of the layer: a press on one of them
    // must not place an anchor.
    if (e.target instanceof Element && e.target.closest("[data-draw-ui]")) return;
    pressRef.current = null;
    anchoredRef.current = false;
    if (e.button !== 0) return;
    const pt = pointAt(e.clientX, e.clientY);
    if (!pt) return;
    pressRef.current = { x: e.clientX, y: e.clientY, pt };
    // Multi-point tools anchor on press so the preview follows the drag and the
    // release point closes the shape.
    if (need >= 2 && pendingRef.current.length === 0) {
      pendingRef.current = [pt];
      anchoredRef.current = true;
    }
    // Capture so a release outside the plot still closes the shape. Synthetic
    // pointer ids are not always active, which makes this throw.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch { /* no capture: the release may land on the chart instead */ }
    bump();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const layer = layerRef.current;
    const r = layer?.getBoundingClientRect();
    posRef.current = r ? { x: e.clientX - r.left, y: e.clientY - r.top } : null;
    cursorRef.current = pointAt(e.clientX, e.clientY);
    setCrosshair(chartRef, mainRef, cursorRef.current);
    bump();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press || e.button !== 0) return;
    const moved = Math.abs(e.clientX - press.x) > DRAG_SLOP || Math.abs(e.clientY - press.y) > DRAG_SLOP;
    if (moved) {
      // Only a press that anchored a shape may close it on release.
      if (anchoredRef.current) addPoint(pointAt(e.clientX, e.clientY) ?? press.pt, activeTool);
    } else {
      // Click-click: the press anchor is already pending, so this adds the next
      // point (and is rejected as degenerate if it is the same one).
      addPoint(press.pt, activeTool);
    }
    anchoredRef.current = false;
  };

  const onPointerLeave = () => {
    pressRef.current = null;
    cursorRef.current = null;
    posRef.current = null;
    setCrosshair(chartRef, mainRef, null);
    bump();
  };

  /** Right-click abandons the shape in progress, like TradingView. */
  const onContextMenu = (e: React.MouseEvent) => {
    if (!placing) return;
    e.preventDefault();
    pendingRef.current = [];
    anchoredRef.current = false;
    pressRef.current = null;
    bump();
  };

  // ── Drag editing (cursor tool) ───────────────────────────────────────
  // Applied per move (not on an animation frame): a frame callback can be
  // skipped entirely, which would silently drop the drag. The expensive part —
  // writing the drawing blob to localStorage — is debounced inside the store.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      const chart = chartRef.current;
      const main = mainRef.current;
      const layer = layerRef.current;
      if (!drag || !chart || !main || !layer) return;
      const pt = plotPoint(chart, main, layer.getBoundingClientRect(), e.clientX, e.clientY);
      if (!pt) return;
      const state = useChartStore.getState();
      const cur = selectDrawings(state, symbol).find((d) => d.id === drag.id);
      if (!cur || cur.locked) return;

      if (drag.kind === "point") {
        const next = cur.points.map((p, i) => {
          if (i !== drag.index) return p;
          if (cur.type === "horizontal") return { ...p, price: pt.price };
          if (cur.type === "vertical") return { ...p, time: pt.time };
          return { time: pt.time, price: pt.price };
        });
        state.updateDrawingPoints(symbol, drag.id, next);
        return;
      }

      const dx = pt.time - drag.anchor.time;
      const dy = pt.price - drag.anchor.price;
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
    const layer = layerRef.current;
    if (!chart || !main || !layer) return;
    const anchor = plotPoint(chart, main, layer.getBoundingClientRect(), e.clientX, e.clientY);
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

  const openMenu = (d: Drawing, e: React.MouseEvent) => {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    const layer = layerRef.current;
    if (!layer) return;
    useChartStore.getState().selectDrawing(d.id);
    const r = layer.getBoundingClientRect();
    setMenu({
      id: d.id,
      x: Math.max(4, Math.min(e.clientX - r.left, r.width - 150)),
      y: Math.max(4, Math.min(e.clientY - r.top, r.height - 110)),
    });
  };

  /** One geometry bundle per shape; `ghost` marks the in-progress preview,
   *  which paints like the finished shape but takes no input. */
  const geomFor = (d: Drawing, ghost = false): Geom => ({
    symbol, xOf, yOf, W, H, ghost,
    selected: !ghost && d.id === selectedId,
    hovered: !ghost && d.id === hoverId,
    interactive: interactive && !ghost,
    onBody: (e) => startBodyDrag(d, e),
    onHandle: (i, e) => startPointDrag(d, i, e),
    onContext: (e) => openMenu(d, e),
    onHover: () => setHoverId(d.id),
    onLeave: () => setHoverId((cur) => (cur === d.id ? null : cur)),
  });

  if (chart && main && showDrawings && W > 0 && H > 0) {
    for (const d of drawings) nodes.push(renderDrawing(d, geomFor(d)));
    const ghost = ghostDrawing(pendingRef.current, cursorRef.current, activeTool, symbol);
    if (ghost) {
      nodes.push(
        <g key="ghost" opacity={0.6} style={{ pointerEvents: "none" }}>
          {renderDrawing(ghost, geomFor(ghost, true))}
        </g>,
      );
    }
    // Every click must leave a mark: the first anchor of a 3-click tool paints
    // nothing on its own (the bands need all three points), so it shows as a dot.
    const dots: React.ReactNode[] = [];
    pendingRef.current.forEach((p, i) => {
      const x = xOf(p.time);
      const y = yOf(p.price);
      if (x == null || y == null) return;
      dots.push(<circle key={`pa-${i}`} cx={x} cy={y} r={3.5} fill="var(--bg-elevated)" stroke="var(--accent)" strokeWidth={1.5} />);
    });
    if (dots.length > 0) nodes.push(<g key="pending" pointerEvents="none">{dots}</g>);
  }

  const selected = drawings.find((d) => d.id === selectedId);
  const actions = selected && showDrawings
    ? actionBar(selected, layerRef, xOf, yOf)
    : null;
  const menuDrawing = menu ? drawings.find((d) => d.id === menu.id) : null;

  // `tick` participates only as a redraw trigger for the imperative transforms.
  const drafting = pendingRef.current.length;
  const pos = posRef.current;
  const aim = cursorRef.current;
  return (
    <div
      ref={layerRef}
      data-draw-layer=""
      className="absolute inset-0 z-10"
      style={{
        pointerEvents: placing && !hand ? "auto" : "none",
        cursor: hand ? "grab" : placing ? "crosshair" : "default",
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
    >
      <svg ref={svgRef} data-tick={tick} className="pointer-events-none absolute inset-0 h-full w-full">
        {nodes}
      </svg>

      {/* The instruction rides next to the pointer, where the user is looking,
          and carries the value the next click would anchor at. */}
      {placing && pos && (
        <div
          className="cursor-label glass-card"
          style={{
            left: Math.max(8, Math.min(pos.x + 16, W - 330)),
            top: Math.max(8, Math.min(pos.y + 18, H - 46)),
          }}
        >
          <span style={{ color: "var(--accent)" }}>{TOOL_BY_ID[activeTool].label}</span>
          <span style={{ color: "var(--text-muted)" }}>{toolHint(activeTool, drafting)}</span>
          {aim && (
            <span className="tabular-nums" style={{ color: "var(--text-primary)" }}>
              {fmtPrice(aim.price, symbol)} · {fmtTime(aim.time * 1000)}
            </span>
          )}
        </div>
      )}

      {/* Status strip: what is armed, how far along it is, and the two controls
          that used to live in a toolbar pill the scrolling bar clipped away. */}
      {placing && (
        <div className="armed-strip glass-card" data-draw-ui>
          <span className="pulse-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent)" }} />
          <span style={{ color: "var(--accent)" }}>{TOOL_BY_ID[activeTool].label}</span>
          <span style={{ color: "var(--text-muted)" }}>{toolHint(activeTool, drafting)}</span>
          <span className="flex items-center gap-0.5" aria-hidden="true">
            {Array.from({ length: need }, (_, i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: i < drafting ? "var(--accent)" : "color-mix(in srgb, var(--text-muted) 45%, transparent)" }}
              />
            ))}
          </span>
          <button
            onClick={() => setStickyTool(!stickyTool)}
            data-active={stickyTool}
            title={stickyTool ? "Stops after this shape and returns to the cursor" : "Keep this tool armed to draw shape after shape"}
          >
            {stickyTool ? "keep armed" : "once"}
          </button>
          <button onClick={() => setActiveTool("crosshair")} title="Back to the cursor (Esc)">Esc</button>
          <span
            className="px-0.5"
            style={{ color: "var(--text-muted)" }}
            title="Hold Space to pan and zoom the chart without dropping the tool"
          >
            Space = pan
          </span>
        </div>
      )}

      {actions}
      {menu && menuDrawing && (
        <ContextMenu d={menuDrawing} symbol={symbol} at={menu} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

/**
 * Replay the pointer position into the chart's own crosshair. The overlay
 * swallows mouse events while a tool is armed, so without this the dashed
 * lines and the axis price/time labels would vanish mid-drawing.
 */
function setCrosshair(
  chartRef: RefObject<IChartApi | null>,
  mainRef: RefObject<ISeriesApi<SeriesType> | null>,
  pt: DrawingPoint | null,
) {
  const chart = chartRef.current;
  const main = mainRef.current;
  if (!chart || !main) return;
  try {
    if (pt) chart.setCrosshairPosition(pt.price, pt.time as Time, main);
    else chart.clearCrosshairPosition();
  } catch { /* series detached between frames */ }
}

function clearCrosshair(
  chartRef: RefObject<IChartApi | null>,
  mainRef: RefObject<ISeriesApi<SeriesType> | null>,
) {
  setCrosshair(chartRef, mainRef, null);
}

/**
 * The shape that *would* be created if the next click landed here. Built with
 * the same factory as a real drawing and painted by the same renderer, so a
 * preview can never disagree with the result: the fib levels, the position
 * bands and the measure label all show up while you are still aiming.
 */
function ghostDrawing(
  pending: DrawingPoint[],
  cursor: DrawingPoint | null,
  tool: ChartTool,
  symbol: string,
): Drawing | null {
  if (!cursor || !isPlacementTool(tool)) return null;
  return drawingForTool(symbol, tool, pending.length > 0 ? [...pending, cursor] : [cursor]);
}

/** Right-click shortcuts on a shape. The floating action bar needs the shape to
 *  be selected first, which is fiddly on a thin line — this opens wherever the
 *  pointer already is. */
function ContextMenu({
  d, symbol, at, onClose,
}: { d: Drawing; symbol: string; at: { x: number; y: number }; onClose: () => void }) {
  const st = useChartStore.getState();
  const hidden = d.visible === false;
  const item = "ctx-item";
  const run = (fn: () => void) => () => { fn(); onClose(); };
  return (
    <div className="glass-card ctx-menu" data-draw-ui style={{ left: at.x, top: at.y }}>
      <div className="ctx-title">{TYPE_LABEL[d.type]}</div>
      <button className={item} onClick={run(() => st.updateDrawing(symbol, d.id, { locked: !d.locked }))}>
        {d.locked ? <LockIcon size={13} /> : <UnlockIcon size={13} />}
        {d.locked ? "Unlock" : "Lock"}
      </button>
      <button className={item} onClick={run(() => st.updateDrawing(symbol, d.id, { visible: hidden }))}>
        {hidden ? <EyeIcon size={13} /> : <EyeOffIcon size={13} />}
        {hidden ? "Show" : "Hide"}
      </button>
      <button className={item} style={{ color: "var(--danger)" }} onClick={run(() => st.removeDrawing(symbol, d.id))}>
        <TrashIcon size={13} />
        Delete
      </button>
    </div>
  );
}

/**
 * Screen point -> chart coordinates, kept inside the plot. The price axis and
 * the time axis are part of the widget but not part of the drawable area, and
 * the bottom price-scale margin extrapolates *below* zero — a BTC line at
 * −4,636 is an invisible drawing the user can only find again in the panel.
 */
function plotPoint(
  chart: IChartApi,
  main: ISeriesApi<SeriesType>,
  rect: DOMRect,
  clientX: number,
  clientY: number,
): DrawingPoint | null {
  const ts = chart.timeScale();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > ts.width() || y > rect.height - ts.height()) return null;
  const time = ts.coordinateToTime(x);
  if (typeof time !== "number") return null;
  const zeroY = main.priceToCoordinate(0);
  const price = main.coordinateToPrice(zeroY != null ? Math.min(y, zeroY - 2) : y);
  if (price == null) return null;
  return { time, price: Number(price) };
}

/** Floating control card next to the selected shape: colour, lock, hide, delete.
 *  It stays out of the way of the drawing itself and only appears once a shape
 *  is selected, so the chart never loses space when nothing is being edited. */
function actionBar(
  d: Drawing,
  layerRef: RefObject<HTMLDivElement | null>,
  xOf: (t: number) => number | null,
  yOf: (p: number) => number | null,
) {
  const el = layerRef.current;
  if (!el) return null;
  const xs = d.points.map((p) => xOf(p.time)).filter((v): v is number => v != null);
  const ys = d.points.map((p) => yOf(p.price)).filter((v): v is number => v != null);
  const CARD_W = 6 + PALETTE.length * 18 + 3 * 26 + 12;
  const x = xs.length ? Math.max(4, Math.min(Math.min(...xs), el.clientWidth - CARD_W - 4)) : 8;
  const y = ys.length ? Math.max(4, Math.min(...ys) - 38) : 8;
  const st = useChartStore.getState();
  const btn = "flex h-6 w-6 items-center justify-center rounded-md";
  const btnStyle = (active: boolean) => ({
    color: active ? "var(--accent)" : "var(--text-secondary)",
    background: active ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "transparent",
  });
  return (
    <div className="glass-card absolute z-20 flex items-center gap-1 px-1.5 py-1" data-draw-ui style={{ left: x, top: y }}>
      {PALETTE.map((c) => (
        <button
          key={c}
          className="h-3.5 w-3.5 rounded-full"
          style={{
            background: c,
            boxShadow: d.color === c ? "0 0 0 1.5px var(--bg-elevated), 0 0 0 3px var(--accent)" : "none",
          }}
          title={`Colour ${c}`}
          aria-label={`Set drawing colour ${c}`}
          onClick={() => st.updateDrawing(d.symbol, d.id, { color: c })}
        />
      ))}
      <span className="mx-0.5 h-4 w-px" style={{ background: "var(--border-strong)" }} />
      <button
        className={btn}
        style={btnStyle(!!d.locked)}
        title={d.locked ? "Unlock drawing" : "Lock drawing"}
        aria-label={d.locked ? "Unlock drawing" : "Lock drawing"}
        onClick={() => st.updateDrawing(d.symbol, d.id, { locked: !d.locked })}
      >
        {d.locked ? <LockIcon size={14} /> : <UnlockIcon size={14} />}
      </button>
      <button
        className={btn}
        style={btnStyle(d.visible === false)}
        title={d.visible === false ? "Show drawing" : "Hide drawing"}
        aria-label={d.visible === false ? "Show drawing" : "Hide drawing"}
        onClick={() => st.updateDrawing(d.symbol, d.id, { visible: d.visible === false })}
      >
        {d.visible === false ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
      </button>
      <button
        className={btn}
        style={{ color: "var(--danger)" }}
        title="Delete drawing (Del)"
        aria-label="Delete drawing"
        onClick={() => st.removeDrawing(d.symbol, d.id)}
      >
        <TrashIcon size={14} />
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
  /** The in-progress preview: paints like a shape, takes no input. */
  ghost: boolean;
  selected: boolean;
  hovered: boolean;
  interactive: boolean;
  onBody: (e: React.MouseEvent) => void;
  onHandle: (index: number, e: React.MouseEvent) => void;
  onContext: (e: React.MouseEvent) => void;
  onHover: () => void;
  onLeave: () => void;
}

/**
 * A locked drawing must stay clickable: it still has to be selectable,
 * otherwise the lock could never be removed. The drag handlers refuse locked
 * shapes, so clicking only selects.
 */
function hitProps(g: Geom, d: Drawing) {
  return {
    "data-drawing": d.id,
    stroke: "transparent",
    strokeWidth: g.hovered ? 16 : 12,
    fill: "none",
    style: {
      pointerEvents: g.interactive ? ("stroke" as const) : ("none" as const),
      cursor: d.locked ? "pointer" : "move",
    },
    onMouseDown: g.onBody,
    onContextMenu: g.onContext,
    onMouseEnter: g.onHover,
    onMouseLeave: g.onLeave,
  };
}

/** Same affordances as `hitProps` for the filled shapes (fib box, position
 *  bands), where the grabbable area is the fill rather than a stroke. */
function fillProps(g: Geom, d: Drawing) {
  return {
    "data-drawing": d.id,
    stroke: "transparent",
    style: {
      pointerEvents: g.interactive ? ("fill" as const) : ("none" as const),
      cursor: d.locked ? "pointer" : "move",
    },
    onMouseDown: g.onBody,
    onContextMenu: g.onContext,
    onMouseEnter: g.onHover,
    onMouseLeave: g.onLeave,
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
            data-drawing={d.id}
            cx={x}
            cy={y}
            r={g.hovered ? 5 : 4}
            fill="var(--bg-elevated)"
            stroke="var(--accent)"
            strokeWidth={1.5}
            style={{ pointerEvents: "all", cursor: "grab" }}
            onMouseDown={(e) => g.onHandle(i, e)}
            onContextMenu={g.onContext}
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
  const width = g.selected ? 2.25 : g.hovered ? 2 : 1.5;
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
            fill={d.color} fillOpacity={g.hovered ? 0.12 : 0.07}
            {...fillProps(g, d)}
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
          fill={profitFill} fillOpacity={g.hovered ? 0.22 : 0.16} {...fillProps(g, d)} />
        <rect x={left} y={Math.min(yEntry, yStop)} width={right - left} height={Math.abs(yStop - yEntry)}
          fill={lossFill} fillOpacity={g.hovered ? 0.22 : 0.16} {...fillProps(g, d)} />
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
