"use client";
import { useChartStore } from "@/lib/store/chartStore";
import { Popover } from "@/components/ui/Popover";
import { IndicatorMenu } from "@/components/IndicatorMenu";
import { ChartSettingsMenu } from "@/components/ChartSettingsMenu";
import { RESET_VIEW_EVENT } from "@/lib/hooks/useKeyboardShortcuts";
import { TOOLS } from "@/lib/utils/drawings";

const CHART_TYPES = [
  { id: "candlestick", label: "Candles" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
] as const;

export function ChartToolbar({ symbol }: { symbol: string }) {
  const activeTool = useChartStore((s) => s.activeTool);
  const setActiveTool = useChartStore((s) => s.setActiveTool);
  const clearDrawings = useChartStore((s) => s.clearDrawings);
  const undoDrawing = useChartStore((s) => s.undoDrawings);
  const redoDrawing = useChartStore((s) => s.redoDrawings);
  const canUndo = useChartStore((s) => s.past.length > 0);
  const canRedo = useChartStore((s) => s.future.length > 0);
  const settings = useChartStore((s) => s.settings);
  const updateSettings = useChartStore((s) => s.updateSettings);
  const fullscreen = useChartStore((s) => s.fullscreen);
  const setFullscreen = useChartStore((s) => s.setFullscreen);
  const chartType = useChartStore((s) => s.chartType);
  const setChartType = useChartStore((s) => s.setChartType);
  const drawingCount = useChartStore((s) => s.drawingsBySymbol[symbol]?.length ?? 0);

  return (
    <div
      className="no-select flex flex-shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1.5 py-1"
      style={{ borderColor: "var(--border)", background: "var(--bg-panel)" }}
    >
      {TOOLS.map((t) => (
        <button
          key={t.id}
          onClick={() => setActiveTool(t.id)}
          data-active={activeTool === t.id}
          data-tooltip={t.label}
          aria-label={t.label}
          className="icon-btn tooltip-trigger h-7 w-7 flex-shrink-0 text-[13px]"
          style={{ color: t.id === "longPosition" ? "var(--success)" : t.id === "shortPosition" ? "var(--danger)" : undefined }}
        >
          {t.icon}
        </button>
      ))}

      <div className="divider-v" />

      <button onClick={undoDrawing} disabled={!canUndo} data-tooltip="Undo drawing (Ctrl+Z)" aria-label="Undo drawing"
        className="icon-btn tooltip-trigger h-7 w-7 flex-shrink-0 text-[13px] disabled:opacity-30">↶</button>
      <button onClick={redoDrawing} disabled={!canRedo} data-tooltip="Redo drawing (Ctrl+Y)" aria-label="Redo drawing"
        className="icon-btn tooltip-trigger h-7 w-7 flex-shrink-0 text-[13px] disabled:opacity-30">↷</button>
      <button onClick={() => clearDrawings(symbol)} disabled={drawingCount === 0} data-tooltip={`Delete all drawings of ${symbol}${drawingCount ? ` (${drawingCount})` : ""}`} aria-label="Delete all drawings"
        className="icon-btn tooltip-trigger h-7 w-7 flex-shrink-0 text-[13px] disabled:opacity-30">🗑</button>
      <button
        onClick={() => updateSettings({ showDrawings: !settings.showDrawings })}
        data-active={!settings.showDrawings}
        data-tooltip={settings.showDrawings ? "Hide drawings" : "Show drawings"}
        aria-label="Toggle drawings visibility"
        className="icon-btn tooltip-trigger h-7 w-7 flex-shrink-0 text-[13px]"
      >
        {settings.showDrawings ? "◉" : "◌"}
      </button>

      <div className="divider-v" />

      <IndicatorMenu />
      <ChartSettingsMenu />

      <div className="divider-v" />

      <div className="flex flex-shrink-0 items-center gap-0.5">
        {CHART_TYPES.map((t) => (
          <button
            key={t.id}
            onClick={() => setChartType(t.id)}
            data-active={chartType === t.id}
            className="seg-btn"
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <Popover label="⤢" tooltip="Reset view (R)" align="right" width={150}>
        {(close) => (
          <button
            onClick={() => { window.dispatchEvent(new Event(RESET_VIEW_EVENT)); close(); }}
            className="w-full rounded px-2 py-1.5 text-left text-[11px]"
            style={{ color: "var(--text-secondary)" }}
          >
            Reset view &amp; jump to latest candle
          </button>
        )}
      </Popover>
      <button
        onClick={() => setFullscreen(!fullscreen)}
        data-tooltip={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
        aria-label="Toggle fullscreen"
        className="icon-btn tooltip-trigger h-7 w-7 flex-shrink-0 text-[13px]"
      >
        {fullscreen ? "⤡" : "⤢"}
      </button>
    </div>
  );
}
