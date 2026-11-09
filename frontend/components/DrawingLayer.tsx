"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import type { IChartApi, ISeriesApi, MouseEventParams, SeriesType } from "lightweight-charts";
import { useChartStore, selectDrawings } from "@/lib/store/chartStore";
import { COLOR_LABEL, PALETTE, TYPE_LABEL, drawingForTool, isPlacementTool, pointsRequired } from "@/lib/utils/drawings";
import { parseHit, resolveColor, type DrawingsPrimitive, type ShapeColor } from "@/lib/chart/drawingsPrimitive";
import { chartPalette } from "@/lib/chart/theme";
import { useThemeStore } from "@/lib/store/themeStore";
import { EyeIcon, EyeOffIcon, LockIcon, TrashIcon, UnlockIcon, DuplicateIcon } from "@/components/icons/ToolIcons";
import type { ChartTool, Drawing, DrawingPoint } from "@/lib/types";

interface Props {
  chartRef: RefObject<IChartApi | null>;
  primitiveRef: RefObject<DrawingsPrimitive | null>;
  /** The element lightweight-charts was created inside — gestures are read off it. */
  hostRef: RefObject<HTMLDivElement | null>;
  symbol: string;
  /** Bumped whenever the chart instance is recreated. */
  epoch: number;
  /** Written here, read by the primitive on paint. Refs, not state: a pointer
   *  move must repaint the canvas, not re-render React. */
  hoverIdRef: RefObject<string | null>;
  ghostRef: RefObject<Drawing | null>;
  pendingRef: RefObject<DrawingPoint[]>;
  /** The price series attached to the right price scale (candle series). The
   *  fallback in `onCrosshairMove` uses it to place a tool when the pointer is
   *  outside the visible candle range: `coordinateToTime` can return null there
   *  while `coordinateToPrice` is still invertible. */
  seriesRef: RefObject<ISeriesApi<SeriesType> | null>;
}

type Hit = { id: string; part: "body" | "point"; index: number };

type Gesture =
  | { kind: "place"; tool: ChartTool; press: DrawingPoint; x: number; y: number; anchored: boolean }
  | { kind: "body"; id: string; start: DrawingPoint[]; anchor: DrawingPoint }
  | { kind: "point"; id: string; index: number };

const DRAG_SLOP = 3;
const MIN_ANCHOR_GAP = 2;

/** Matches the menu's own box, so the clamp can keep all of it inside the chart. */
const MENU_W = 172;
const MENU_H = 168;

/**
 * Pointer input for chart annotations. It draws nothing: every shape is painted
 * by `DrawingsPrimitive` inside the chart's own canvas, and this component only
 * turns chart events into store writes.
 *
 * That split is what removes the "layer of glass over a chart" feeling. There is
 * no overlay to fall a frame behind the candles, no second coordinate system to
 * drift, and — because the events are the chart's own, not stolen from beneath it
 * — pan, zoom and the crosshair keep working while a tool is armed. The only thing
 * still rendered in DOM is the right-click menu.
 *
 * Coordinates come from `subscribeCrosshairMove`, whose `point` is already in the
 * pane-local space the primitive paints in, and whose `hoveredInfo.objectId` is
 * already the chart's own hit test. So nothing here measures the DOM.
 *
 * Nothing here touches orders — these are chart annotations only.
 */
export function DrawingController({ chartRef, primitiveRef, hostRef, symbol, epoch, hoverIdRef, ghostRef, pendingRef, seriesRef }: Props) {
  /** `symbol` is remembered so a menu opened on one chart can never repaint on another. */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; symbol: string } | null>(null);
  const activeTool = useChartStore((s) => s.activeTool);
  const placing = isPlacementTool(activeTool);
  const closeMenu = useCallback(() => setMenu(null), []);

  // The chart owns the cursor while the tool is the cursor (a primitive hit makes
  // it move/grab). Only the armed-tool crosshair is ours to set, and it goes on
  // the wrapper so the library's own value on the chart element still wins.
  useEffect(() => {
    const host = hostRef.current;
    if (host) host.style.cursor = placing ? "crosshair" : "";
  }, [placing, hostRef, epoch]);

  // A half-finished shape never survives a tool or symbol change.
  useEffect(() => {
    pendingRef.current = [];
    ghostRef.current = null;
    hoverIdRef.current = null;
    primitiveRef.current?.invalidate();
  }, [activeTool, symbol, ghostRef, hoverIdRef, pendingRef, primitiveRef]);

  // Everything the primitive paints comes out of the store, so any write that
  // could change geometry needs a repaint — including ones made from the
  // drawings panel, the undo stack or a colour pick.
  useEffect(() => {
    const unsubscribe = useChartStore.subscribe((s, prev) => {
      // The menu belongs to the cursor tool; arming anything else retires it.
      if (s.activeTool !== prev.activeTool) setMenu(null);
      // Check if drawings for the current symbol have changed
      const currentDrawings = s.drawingsBySymbol[symbol] ?? [];
      const prevDrawings = prev.drawingsBySymbol[symbol] ?? [];
      const drawingsChanged =
        currentDrawings.length !== prevDrawings.length ||
        // Check if any drawing's id or type changed at the same index
        currentDrawings.some((d, i) => {
          const prevD = prevDrawings[i];
          return d.id !== prevD?.id || d.type !== prevD?.type;
        });
      // Always invalidate the primitive when drawings change to ensure
      // the drawing layer re-renders. Removed the early return that was
      // preventing invalidation when selectedId and settings hadn't changed.
      primitiveRef.current?.invalidate();
    });
    return unsubscribe;
  }, [primitiveRef, symbol]);

  useEffect(() => {
    const chart = chartRef.current;
    const prim = primitiveRef.current;
    const host = hostRef.current;
    if (!chart || !prim || !host) return;

    /** Where the pointer is, in the primitive's own coordinates. Null the moment
     *  it leaves the plot — which is also how a stray press on the axis is ignored. */
    let aim: { x: number; y: number; pt: DrawingPoint } | null = null;
    /** Last usable point, so a gesture released outside the plot still closes. */
    let lastPt: DrawingPoint | null = null;
    let hit: Hit | null = null;
    let gesture: Gesture | null = null;
    /** A press that hit nothing, and so may be a click that should deselect. */
    let plainPress: { x: number; y: number } | null = null;
    let panBlocked = false;
    /** Space held: the press belongs to the chart, so panning stays enabled. */
    let spaceHeld = false;

    const blockPan = (on: boolean) => {
      if (panBlocked === on) return;
      panBlocked = on;
      // v5 calls press-drag panning "pressedMouseMove". The wheel stays live, so
      // the chart can still be zoomed mid-gesture.
      chart.applyOptions({ handleScroll: { pressedMouseMove: !on } });
    };

    /** Screen distance between two anchors; off-scale counts as far apart. */
    const gap = (a: DrawingPoint, b: DrawingPoint): number => {
      const pa = prim.project(a);
      const pb = prim.project(b);
      if (!pa || !pb) return Infinity;
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    };

    /**
     * Append one anchor, completing (and persisting) the shape once the tool has
     * all of its points.
     *
     * TradingView's rhythm on completion: the tool returns to the cursor and the
     * finished shape is selected, so the next click adjusts it instead of drawing
     * another one. "Keep armed" (the rail flyout, or the tool key a second time)
     * opts out.
     */
    const addPoint = (pt: DrawingPoint, tool: ChartTool) => {
      const pending = pendingRef.current;
      const last = pending[pending.length - 1];
      if (last && gap(last, pt) < MIN_ANCHOR_GAP) return;
      const next = [...pending, pt];
      const need = pointsRequired(tool);
      if (next.length < need) {
        pendingRef.current = next;
        prim.invalidate();
        return;
      }
      pendingRef.current = [];
      ghostRef.current = null;
      const drawing = drawingForTool(symbol, tool, next.slice(0, need));
      if (drawing) {
        const st = useChartStore.getState();
        if (!st.stickyTool) st.setActiveTool("crosshair");
        // Runs after the tool switch: setActiveTool clears the selection, so the
        // order is what leaves the new shape with its handles showing.
        st.addDrawing(symbol, drawing);
      }
      prim.invalidate();
    };

    const moveShape = (g: Gesture, pt: DrawingPoint) => {
      if (g.kind === "place") return;
      const st = useChartStore.getState();
      const cur = selectDrawings(st, symbol).find((d) => d.id === g.id);
      if (!cur || cur.locked) return;

      if (g.kind === "point") {
        st.updateDrawingPoints(symbol, g.id, cur.points.map((p, i) => {
          if (i !== g.index) return p;
          if (cur.type === "horizontal") return { ...p, price: pt.price };
          if (cur.type === "vertical") return { ...p, time: pt.time };
          return { time: pt.time, price: pt.price };
        }));
        return;
      }

      const dx = pt.time - g.anchor.time;
      const dy = pt.price - g.anchor.price;
      st.updateDrawingPoints(symbol, g.id, g.start.map((p) => {
        if (cur.type === "horizontal") return { ...p, price: p.price + dy };
        if (cur.type === "vertical") return { ...p, time: p.time + dx };
        return { time: p.time + dx, price: p.price + dy };
      }));
    };

    const onCrosshairMove = (p: MouseEventParams) => {
      const inPane = p.point != null && (p.paneIndex ?? 0) === prim.paneIndexOf();
      let pt: DrawingPoint | null = null;
      if (inPane && p.point) {
        pt = prim.unproject(p.point.x, p.point.y);
      }
      // When the pointer is outside the candle range the axis lookups can return
      // null (scale not ready yet, or the logical is outside the visible range
      // and the round trip cannot be inverted). Fall back to the scale's own
      // coordinate conversion so a tool dragged before the first or after the
      // last candle still lands where the pointer is.
      if (!pt && p.point && inPane) {
        const chart = chartRef.current;
        if (chart) {
          try {
            const timeScale = chart.timeScale();
            const time = timeScale.coordinateToTime(p.point.x);
            const series = seriesRef.current;
            if (typeof time === "number" && Number.isFinite(time)) {
              const price = series ? series.coordinateToPrice(p.point.y) : null;
              if (price != null && Number.isFinite(Number(price))) pt = { time: Math.round(time), price: Number(price) };
            }
          } catch {
            // Chart may not be fully mounted during a resize/transition; the
            // primitive's own extrapolation is the authoritative path.
          }
        }
      }
      aim = pt && p.point ? { x: p.point.x, y: p.point.y, pt } : null;
      if (pt) lastPt = pt;

      const rawHit = aim && p.hoveredInfo?.sourceKind === "series-primitive" ? parseHit(p.hoveredInfo.objectId) : null;
      if (rawHit) {
        const st = useChartStore.getState();
        const drawings = selectDrawings(st, symbol);
        const d = drawings.find((x) => x.id === rawHit.id);
        if (d?.visible === false) {
          hit = null;
        } else {
          hit = rawHit;
        }
      } else {
        hit = null;
      }

      if (gesture) {
        if (pt) moveShape(gesture, pt);
        return;
      }

      const st = useChartStore.getState();
      let dirty = false;
      const hoverId = hit?.id ?? null;
      if (hoverId !== hoverIdRef.current) {
        hoverIdRef.current = hoverId;
        dirty = true;
      }

      const wantsGhost = st.settings.showDrawings && isPlacementTool(st.activeTool) && !spaceHeld;
      if (wantsGhost) {
        const pending = pendingRef.current;
        const next = pt ? drawingForTool(symbol, st.activeTool, pending.length ? [...pending, pt] : [pt]) : null;
        if (next !== ghostRef.current) {
          ghostRef.current = next;
          dirty = true;
        }
      } else if (ghostRef.current) {
        ghostRef.current = null;
        dirty = true;
      }
      if (dirty) prim.invalidate();
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const st = useChartStore.getState();
      if (!st.settings.showDrawings || spaceHeld) return;

      if (isPlacementTool(st.activeTool)) {
        const pt = aim?.pt;
        if (!pt) return;
        const anchored = pointsRequired(st.activeTool) >= 2 && pendingRef.current.length === 0;
        if (anchored) pendingRef.current = [pt];
        gesture = { kind: "place", tool: st.activeTool, press: pt, x: e.clientX, y: e.clientY, anchored };
        blockPan(true);
        prim.invalidate();
        return;
      }

      const h = hit;
      if (!h) {
        if (aim && st.activeTool === "crosshair") {
          plainPress = { x: e.clientX, y: e.clientY };
        }
        return;
      }
      const d = selectDrawings(st, symbol).find((x) => x.id === h.id);
      if (!d || d.visible === false) return;
      st.selectDrawing(d.id);
      if (d.locked) return;
      const pt = aim?.pt;
      if (h.part === "point") {
        st.beginDrawingHistory(symbol);
        gesture = { kind: "point", id: d.id, index: h.index };
      } else if (pt) {
        st.beginDrawingHistory(symbol);
        gesture = { kind: "body", id: d.id, start: d.points.map((q) => ({ ...q })), anchor: pt };
      } else {
        return;
      }
      blockPan(true);
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const g = gesture;
      gesture = null;
      const press = plainPress;
      plainPress = null;
      blockPan(false);

      if (g?.kind === "place") {
        const moved = Math.abs(e.clientX - g.x) > DRAG_SLOP || Math.abs(e.clientY - g.y) > DRAG_SLOP;
        addPoint(moved ? (aim?.pt ?? lastPt ?? g.press) : g.press, g.tool);
        return;
      }
      if (g) return;
      if (!press) return;
      if (Math.abs(e.clientX - press.x) > DRAG_SLOP || Math.abs(e.clientY - press.y) > DRAG_SLOP) return;
      const st = useChartStore.getState();
      if (st.activeTool === "crosshair" && st.selectedId) {
        const d = selectDrawings(st, symbol).find((x) => x.id === st.selectedId);
        if (!hit) st.selectDrawing(null);
      }
    };

    const endGesture = () => {
      if (gesture) {
        gesture = null;
        pendingRef.current = [];
        ghostRef.current = null;
        prim.invalidate();
      }
      plainPress = null;
      blockPan(false);
    };

    /** Right-click abandons the shape in progress, like TradingView; on a shape
     *  it opens the actions where the pointer already is. */
    const onContextMenu = (e: MouseEvent) => {
      const st = useChartStore.getState();
      if (isPlacementTool(st.activeTool)) {
        if (pendingRef.current.length === 0 && !ghostRef.current) return;
        e.preventDefault();
        pendingRef.current = [];
        ghostRef.current = null;
        prim.invalidate();
        return;
      }
      if (!hit || !aim) return;
      e.preventDefault();
      st.selectDrawing(hit.id);
      const r = host.getBoundingClientRect();
      setMenu({
        id: hit.id,
        x: Math.max(4, Math.min(e.clientX - r.left, r.width - MENU_W)),
        y: Math.max(4, Math.min(e.clientY - r.top, r.height - MENU_H)),
        symbol,
      });
    };

    const isField = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    /** Space = hand tool, but only while a drawing tool is armed. Without it the
     *  press would always belong to the shape, and a wide annotation would be
     *  impossible to place. */
    const onKeyDown = (e: KeyboardEvent) => {
      if (isField(e.target)) return;
      if (e.code === "Space") {
        if (!isPlacementTool(useChartStore.getState().activeTool)) return;
        e.preventDefault();
        spaceHeld = true;
        if (ghostRef.current) {
          ghostRef.current = null;
          prim.invalidate();
        }
        return;
      }
      if (e.key === "Enter") {
        const st = useChartStore.getState();
        if (isPlacementTool(st.activeTool) && pendingRef.current.length > 0) {
          e.preventDefault();
          const last = pendingRef.current[pendingRef.current.length - 1]!;
          addPoint(last, st.activeTool);
        }
        return;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      spaceHeld = false;
    };
    const onBlur = () => {
      spaceHeld = false;
      endGesture();
    };

    chart.subscribeCrosshairMove(onCrosshairMove);
    host.addEventListener("mousedown", onMouseDown);
    host.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      host.removeEventListener("mousedown", onMouseDown);
      host.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      blockPan(false);
      aim = null;
      lastPt = null;
      hit = null;
      gesture = null;
      plainPress = null;
      hoverIdRef.current = null;
      ghostRef.current = null;
      pendingRef.current = [];
    };
  }, [chartRef, primitiveRef, hostRef, symbol, epoch, hoverIdRef, ghostRef, pendingRef]);

  return menu && menu.symbol === symbol ? (
    <ContextMenu id={menu.id} symbol={symbol} at={menu} onClose={closeMenu} />
  ) : null;
}

/** Right-click shortcuts on a shape. The chart paints the shape itself, so this
 *  is the one piece of DOM the annotation layer still needs: canvas pixels
 *  cannot be clicked. */
function ContextMenu({ id, symbol, at, onClose }: { id: string; symbol: string; at: { x: number; y: number }; onClose: () => void }) {
  const d = useChartStore((s) => (s.drawingsBySymbol[symbol] ?? []).find((x) => x.id === id));
  const theme = useThemeStore((s) => s.theme);
  /** A palette keyword ("ink", "up") is not a CSS colour, and the canvas resolves
   *  it at paint time — so the swatch has to resolve it the same way, or the
   *  default colour would preview as nothing and never read as "currently set". */
  const palette = chartPalette(theme);
  const cssOf = (c: string) => resolveColor(c as ShapeColor, palette);

  // Close on any press outside the menu, and on Escape.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-draw-ui]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!d) return null;
  const st = useChartStore.getState();
  const hidden = d.visible === false;
  const run = (fn: () => void) => () => { fn(); onClose(); };
  return (
    <div className="ctx-menu" data-draw-ui style={{ left: at.x, top: at.y }}>
      <div className="ctx-title">{TYPE_LABEL[d.type]}</div>
      <div className="ctx-swatches" role="group" aria-label="Colour">
        {PALETTE.map((c) => (
          <button
            key={c}
            className="ctx-swatch"
            style={{ "--swatch": cssOf(c) } as React.CSSProperties}
            data-active={cssOf(d.color) === cssOf(c)}
            title={`Colour ${COLOR_LABEL[c] ?? c}`}
            aria-label={`Set colour ${COLOR_LABEL[c] ?? c}`}
            onClick={run(() => st.updateDrawing(symbol, d.id, { color: c }))}
          />
        ))}
      </div>
      <button className="ctx-item" onClick={run(() => st.updateDrawing(symbol, d.id, { locked: !d.locked }))}>
        {d.locked ? <LockIcon size={13} /> : <UnlockIcon size={13} />}
        {d.locked ? "Unlock" : "Lock"}
      </button>
      <button className="ctx-item" onClick={run(() => st.updateDrawing(symbol, d.id, { visible: hidden }))}>
        {hidden ? <EyeIcon size={13} /> : <EyeOffIcon size={13} />}
        {hidden ? "Show" : "Hide"}
      </button>
      <button className="ctx-item" onClick={run(() => st.duplicateDrawing(symbol, d.id))}>
        <DuplicateIcon size={13} />
        Duplicate
      </button>
      <button className="ctx-item ctx-danger" onClick={run(() => st.removeDrawing(symbol, d.id))}>
        <TrashIcon size={13} />
        Delete
      </button>
    </div>
  );
}
