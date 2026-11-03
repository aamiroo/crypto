"use client";

import { useChartStore, selectDrawings } from "@/lib/store/chartStore";
import { useUiStore } from "@/lib/store/uiStore";
import { TYPE_LABEL, positionMetrics } from "@/lib/utils/drawings";
import { fmtPrice } from "@/lib/utils/format";
import { CloseIcon, EyeIcon, EyeOffIcon, LockIcon, TrashIcon, UnlockIcon } from "@/components/icons/ToolIcons";
import type { Drawing } from "@/lib/types";

/**
 * Floating list of the current symbol's drawings. Before this, a shape could
 * only be found by hunting for it on the chart with the cursor tool, so a
 * crowded chart was effectively unmanageable: this lists every shape, and
 * picking a row selects it and drops the tool so its handles appear.
 */
export function DrawingsPanel({ symbol }: { symbol: string }) {
  const open = useUiStore((s) => s.drawingsOpen);
  const setOpen = useUiStore((s) => s.setDrawingsOpen);
  const drawings = useChartStore((s) => selectDrawings(s, symbol));
  const selectedId = useChartStore((s) => s.selectedId);

  if (!open) return null;

  return (
    <div className="floating-panel absolute right-2 top-8 z-30 flex max-h-[46vh] w-60 flex-col overflow-hidden" data-draw-ui>
      <div className="flex flex-shrink-0 items-center justify-between px-2.5 py-1.5" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          Drawings · {drawings.length}
        </span>
        <button onClick={() => setOpen(false)} className="icon-btn h-5 w-5" title="Close list" aria-label="Close drawings list">
          <CloseIcon size={11} />
        </button>
      </div>

      {drawings.length === 0 ? (
        <p className="px-2.5 py-3 text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Nothing drawn on {symbol} yet. Pick a tool above, then click the chart.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto py-0.5">
          {[...drawings].reverse().map((d) => (
            <Row key={d.id} d={d} symbol={symbol} selected={d.id === selectedId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ d, symbol, selected }: { d: Drawing; symbol: string; selected: boolean }) {
  const selectDrawing = useChartStore((s) => s.selectDrawing);
  const setActiveTool = useChartStore((s) => s.setActiveTool);
  const updateDrawing = useChartStore((s) => s.updateDrawing);
  const removeDrawing = useChartStore((s) => s.removeDrawing);

  // Selecting from the list must actually give you the shape: while a placement
  // tool is armed every click draws, so the cursor tool comes first.
  const focus = () => {
    setActiveTool("crosshair");
    selectDrawing(d.id);
  };

  return (
    <li
      onClick={focus}
      className="group flex cursor-pointer items-center gap-1.5 px-2.5 py-1"
      style={{
        background: selected ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "transparent",
        borderLeft: `2px solid ${selected ? "var(--accent)" : "transparent"}`,
      }}
    >
      <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: d.color, opacity: d.visible === false ? 0.3 : 1 }} />
      <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: d.visible === false ? "var(--text-muted)" : "var(--text-secondary)" }}>
        {TYPE_LABEL[d.type]}
        <span className="ml-1 tabular-nums" style={{ color: "var(--text-muted)" }}>{detail(d, symbol)}</span>
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); updateDrawing(symbol, d.id, { visible: d.visible === false }); }}
        className="icon-btn h-5 w-5 opacity-0 group-hover:opacity-100"
        style={{ opacity: d.visible === false ? 1 : undefined }}
        title={d.visible === false ? "Show" : "Hide"}
        aria-label={d.visible === false ? "Show drawing" : "Hide drawing"}
      >
        {d.visible === false ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); updateDrawing(symbol, d.id, { locked: !d.locked }); }}
        className="icon-btn h-5 w-5 opacity-0 group-hover:opacity-100"
        style={{ opacity: d.locked ? 1 : undefined }}
        title={d.locked ? "Unlock" : "Lock"}
        aria-label={d.locked ? "Unlock drawing" : "Lock drawing"}
      >
        {d.locked ? <LockIcon size={12} /> : <UnlockIcon size={12} />}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); removeDrawing(symbol, d.id); }}
        className="icon-btn h-5 w-5 opacity-0 group-hover:opacity-100"
        style={{ color: "var(--danger)" }}
        title="Delete"
        aria-label="Delete drawing"
      >
        <TrashIcon size={12} />
      </button>
    </li>
  );
}

/** One short fact per row so a list of identical tools is still readable. */
function detail(d: Drawing, symbol: string): string {
  const p1 = d.points[0];
  if (!p1) return "";
  if (d.type === "horizontal") return fmtPrice(p1.price, symbol);
  if (d.type === "vertical") return new Date(p1.time * 1000).toLocaleString();
  if (d.type === "longPosition" || d.type === "shortPosition") {
    const m = positionMetrics(d.points);
    return m ? `R:R ${m.rr == null ? "—" : `1:${m.rr.toFixed(2)}`}` : "";
  }
  return "";
}
