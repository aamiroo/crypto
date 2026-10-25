"use client";

import { useEffect } from "react";
import { useChartStore } from "@/lib/store/chartStore";
import { useMarketStore } from "@/lib/store/marketStore";
import { useUiStore } from "@/lib/store/uiStore";
import { TIMEFRAMES } from "@/lib/utils/klines";
import type { ChartTool } from "@/lib/types";

/** Signals the chart to reset zoom and scroll back to the latest candle. */
export const RESET_VIEW_EVENT = "ct:reset-view";

/** Stops shortcuts from stealing keystrokes in text fields (search box, alert
 *  price inputs). The instanceof check also keeps non-element targets safe. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

const TOOL_KEYS: Record<string, ChartTool> = {
  v: "crosshair",
  h: "horizontal",
  b: "vertical",
  t: "trendline",
  j: "ray",
  g: "fibonacci",
  m: "measure",
  l: "longPosition",
  k: "shortPosition",
};

/**
 * Global keyboard shortcuts. Deliberately conservative: never fires while the
 * user is typing, and avoids overriding browser-reserved combos.
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const chart = useChartStore.getState();
      const ui = useUiStore.getState();

      // Undo/redo work even inside the chart area, but not while typing.
      if ((e.ctrlKey || e.metaKey) && !isTypingTarget(e.target)) {
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) { e.preventDefault(); chart.undoDrawings(); return; }
        if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); chart.redoDrawings(); return; }
      }

      if (isTypingTarget(e.target)) return;

      if (e.key === "?") { e.preventDefault(); ui.toggleShortcuts(); return; }
      if (e.key === "Escape") {
        if (ui.shortcutsOpen) { ui.setShortcutsOpen(false); return; }
        if (ui.alertsOpen) { ui.setAlertsOpen(false); return; }
        chart.setActiveTool("crosshair");
        return;
      }
      // Delete the selected annotation (the tool would otherwise delete the
      // draft shape, which Escape already handles).
      if ((e.key === "Delete" || e.key === "Backspace") && chart.selectedId) {
        e.preventDefault();
        chart.removeDrawing(useMarketStore.getState().symbol, chart.selectedId);
        return;
      }

      const k = e.key.toLowerCase();
      if (k === "f" && !e.ctrlKey && !e.metaKey) { chart.setFullscreen(!chart.fullscreen); return; }
      if (k === "r" && !e.ctrlKey && !e.metaKey) {
        window.dispatchEvent(new Event(RESET_VIEW_EVENT));
        return;
      }
      const tool = TOOL_KEYS[k];
      if (tool && !e.ctrlKey && !e.metaKey) {
        // Same key again = flip "keep armed", matching a second click on the rail.
        chart.setActiveTool(tool, chart.activeTool === tool ? !chart.stickyTool : false);
        return;
      }

      const n = parseInt(e.key, 10);
      if (!e.ctrlKey && !e.metaKey && n >= 1 && n <= TIMEFRAMES.length) {
        const tf = TIMEFRAMES[n - 1];
        if (tf) chart.setTimeframe(tf);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export interface ShortcutDef { keys: string; label: string; }

export const SHORTCUTS: ShortcutDef[] = [
  { keys: "1 – 9", label: "Switch timeframe" },
  { keys: "F", label: "Toggle chart fullscreen" },
  { keys: "R", label: "Reset view / jump to latest" },
  { keys: "V", label: "Crosshair (cursor) tool" },
  { keys: "H", label: "Horizontal line tool" },
  { keys: "B", label: "Vertical line tool" },
  { keys: "T", label: "Trend line tool" },
  { keys: "J", label: "Ray tool" },
  { keys: "G", label: "Fibonacci retracement tool" },
  { keys: "M", label: "Measure tool" },
  { keys: "L", label: "Long position tool" },
  { keys: "K", label: "Short position tool" },
  { keys: "Ctrl/⌘ Z", label: "Undo drawing" },
  { keys: "Ctrl/⌘ Y", label: "Redo drawing" },
  { keys: "Tool key again", label: "Keep the tool armed for repeated drawing" },
  { keys: "Space (tool armed)", label: "Pan and zoom without dropping the tool" },
  { keys: "Right-click a drawing", label: "Lock / hide / delete menu" },
  { keys: "Del", label: "Delete selected drawing" },
  { keys: "Esc", label: "Cancel tool / close dialog" },
  { keys: "?", label: "Show this help" },
];
