"use client";
import { useState } from "react";
import { useChartStore } from "@/lib/store/chartStore";
import { useUiStore } from "@/lib/store/uiStore";
import { Popover } from "@/components/ui/Popover";
import { IndicatorMenu } from "@/components/IndicatorMenu";
import { ChartSettingsMenu } from "@/components/ChartSettingsMenu";
import { RESET_VIEW_EVENT } from "@/lib/hooks/useKeyboardShortcuts";
import { TOOL_GROUPS, toolsInGroup } from "@/lib/utils/drawings";
import {
  CursorIcon, EyeIcon, EyeOffIcon, FibonacciIcon, HorizontalIcon, LayersIcon,
  LongPositionIcon, MeasureIcon, RayIcon, RedoIcon, ShortPositionIcon,
  TrashIcon, TrendlineIcon, UndoIcon, VerticalIcon,
} from "@/components/icons/ToolIcons";
import type { ToolDef } from "@/lib/utils/drawings";
import type { ChartTool } from "@/lib/types";
import type { ReactElement } from "react";

const CHART_TYPES = [
  { id: "candlestick", label: "Candles" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
] as const;

/** Tool rail icons, keyed by tool id so the list in lib/utils/drawings stays
 *  the single source for order, labels and shortcuts. */
const TOOL_ICON: Record<ChartTool, (p: { size?: number }) => ReactElement> = {
  crosshair: CursorIcon,
  horizontal: HorizontalIcon,
  vertical: VerticalIcon,
  trendline: TrendlineIcon,
  ray: RayIcon,
  fibonacci: FibonacciIcon,
  measure: MeasureIcon,
  longPosition: LongPositionIcon,
  shortPosition: ShortPositionIcon,
};

/** Long/short keep their semantic colour everywhere, including the rail. */
function toolColor(id: ChartTool): string | undefined {
  if (id === "longPosition") return "var(--success)";
  if (id === "shortPosition") return "var(--danger)";
  return undefined;
}

export function ChartToolbar({ symbol }: { symbol: string }) {
  const activeTool = useChartStore((s) => s.activeTool);
  const stickyTool = useChartStore((s) => s.stickyTool);
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
  const drawingsOpen = useUiStore((s) => s.drawingsOpen);
  const toggleDrawings = useUiStore((s) => s.toggleDrawings);
  /** Which tool each flyout last showed, so a group button keeps the identity
   *  of what you picked instead of snapping back to its first entry. */
  const [lastOf, setLastOf] = useState<Record<string, ChartTool>>({});

  const pick = (t: ToolDef) => {
    // Re-picking the armed tool flips "keep armed"; the strip over the chart
    // says the same thing in words.
    setActiveTool(t.id, activeTool === t.id ? !stickyTool : false);
    setLastOf((m) => ({ ...m, [t.group]: t.id }));
  };

  return (
    <div
      className="no-select flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1"
      style={{ borderColor: "var(--border)", background: "var(--bg-panel)" }}
    >
      <div className="tool-rail">
        {TOOL_GROUPS.map((g) => {
          const items = toolsInGroup(g.id);
          const single = items.length === 1 ? items[0] : null;
          if (single) return <ToolButton key={g.id} tool={single} armed={activeTool} sticky={stickyTool} onPick={pick} />;
          return (
            <ToolFlyout
              key={g.id}
              label={g.label}
              items={items}
              shown={lastOf[g.id] ?? items[0]!.id}
              armed={activeTool}
              sticky={stickyTool}
              onPick={pick}
            />
          );
        })}
      </div>

      <div className="divider-v" />

      <button onClick={undoDrawing} disabled={!canUndo} data-tooltip="Undo drawing (Ctrl+Z)" aria-label="Undo drawing"
        className="icon-btn tooltip-trigger h-7 w-7 flex-shrink-0 disabled:opacity-30">
        <UndoIcon size={15} />
      </button>
      <button onClick={redoDrawing} disabled={!canRedo} data-tooltip="Redo drawing (Ctrl+Y)" aria-label="Redo drawing"
        className="icon-btn tooltip-trigger h-7 w-7 flex-shrink-0 disabled:opacity-30">
        <RedoIcon size={15} />
      </button>
      <button
        onClick={() => updateSettings({ showDrawings: !settings.showDrawings })}
        data-active={!settings.showDrawings}
        data-tooltip={settings.showDrawings ? "Hide all drawings" : "Show all drawings"}
        aria-label="Toggle drawings visibility"
        className="icon-btn tooltip-trigger h-7 w-7 flex-shrink-0"
      >
        {settings.showDrawings ? <EyeIcon size={15} /> : <EyeOffIcon size={15} />}
      </button>
      <button
        onClick={toggleDrawings}
        data-active={drawingsOpen}
        data-tooltip="Drawings list"
        aria-label="Open drawings list"
        className="icon-btn tooltip-trigger h-7 gap-1 px-1.5 text-[11px]"
      >
        <LayersIcon size={15} />
        {drawingCount > 0 && <span className="tabular-nums">{drawingCount}</span>}
      </button>
      <button
        onClick={() => clearDrawings(symbol)}
        disabled={drawingCount === 0}
        data-tooltip={drawingCount ? `Delete all drawings of ${symbol} (${drawingCount})` : "No drawings to delete"}
        aria-label="Delete all drawings"
        className="icon-btn tooltip-trigger h-7 w-7 flex-shrink-0 disabled:opacity-30"
      >
        <TrashIcon size={15} />
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

interface PickProps {
  /** Currently armed tool, for the active state. */
  armed: ChartTool;
  sticky: boolean;
  onPick: (t: ToolDef) => void;
}

/** A family with a single member (the cursor) needs no flyout. */
function ToolButton({ tool, armed, sticky, onPick }: { tool: ToolDef } & PickProps) {
  const Icon = TOOL_ICON[tool.id];
  const isArmed = armed === tool.id;
  return (
    <button
      onClick={() => onPick(tool)}
      data-active={isArmed}
      data-sticky={isArmed && sticky}
      title={`${tool.label} (${tool.key?.toUpperCase() ?? ""}) — ${tool.hint}`}
      aria-label={tool.label}
      aria-pressed={isArmed}
      className="rail-btn"
      style={{ color: toolColor(tool.id) }}
    >
      <Icon size={15} />
    </button>
  );
}

/**
 * One rail button per tool family, opening a list that spells every tool out:
 * name, what it expects you to click, and its shortcut. A row of nine
 * unlabeled glyphs is precisely what made this rail hard to read.
 */
function ToolFlyout({
  label, items, shown, armed, sticky, onPick,
}: { label: string; items: ToolDef[]; shown: ChartTool } & PickProps) {
  const ShownIcon = TOOL_ICON[shown];
  const armedHere = items.some((t) => t.id === armed);
  return (
    <Popover
      align="left"
      width={252}
      active={armedHere}
      title={`${label} — ${items.map((t) => t.label).join(", ")}`}
      className="rail-btn rail-btn-wide"
      label={(
        <>
          <ShownIcon size={15} />
          <span className="text-[8px] leading-none" style={{ color: "var(--text-muted)" }}>▾</span>
          {armedHere && sticky && <span className="sticky-dot" title="Kept armed: draws shape after shape" />}
        </>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-0.5">
          <div className="tool-menu-title">{label}</div>
          {items.map((t) => {
            const Icon = TOOL_ICON[t.id];
            return (
              <button
                key={t.id}
                onClick={() => { onPick(t); close(); }}
                data-active={armed === t.id}
                title={`${t.label} (${t.key?.toUpperCase() ?? ""}) — ${t.hint}`}
                className="tool-menu-item"
              >
                <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center" style={{ color: toolColor(t.id) }}>
                  <Icon size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px]" style={{ color: "var(--text-primary)" }}>{t.label}</span>
                  <span className="block truncate text-[9px]" style={{ color: "var(--text-muted)" }}>{t.hint}</span>
                </span>
                <kbd className="tool-kbd">{t.key?.toUpperCase()}</kbd>
                {armed === t.id && sticky && <span className="sticky-dot" title="Kept armed: draws shape after shape" />}
              </button>
            );
          })}
          <p className="tool-menu-foot">
            Pick, then click the chart. Re-pick the armed tool (or use the strip over the chart) to keep drawing.
          </p>
        </div>
      )}
    </Popover>
  );
}
