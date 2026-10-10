"use client";
import { useChartStore } from "@/lib/store/chartStore";
import type { ChartTool } from "@/lib/types";

interface ToolDef { id: ChartTool; icon: string; label: string; }
const TOOLS: ToolDef[] = [
  { id:"crosshair", icon:"+", label:"Crosshair" },
  { id:"trendline", icon:"/", label:"Trend Line" },
  { id:"horizontal", icon:"-", label:"Horizontal Line" },
  { id:"ray", icon:"\u2192", label:"Ray" },
  { id:"rectangle", icon:"\u25a1", label:"Rectangle" },
  { id:"fibonacci", icon:"F", label:"Fibonacci" },
  { id:"measure", icon:"\u2194", label:"Measure" },
  { id:"text", icon:"T", label:"Text" },
  { id:"eraser", icon:"\u2716", label:"Delete All" },
  { id:"magnet", icon:"M", label:"Magnet Mode" },
  { id:"hide", icon:"\u25ce", label:"Hide Drawings" },
  { id:"lock", icon:"L", label:"Lock Drawings" },
];

export function ChartToolbar() {
  const activeTool = useChartStore((s) => s.activeTool);
  const setActiveTool = useChartStore((s) => s.setActiveTool);
  const clearDrawings = useChartStore((s) => s.clearDrawings);
  const undoDrawing = useChartStore((s) => s.undoDrawing);
  const redoDrawing = useChartStore((s) => s.redoDrawing);
  const settings = useChartStore((s) => s.settings);
  const updateSettings = useChartStore((s) => s.updateSettings);
  const fullscreen = useChartStore((s) => s.fullscreen);
  const setFullscreen = useChartStore((s) => s.setFullscreen);
  const chartType = useChartStore((s) => s.chartType);
  const setChartType = useChartStore((s) => s.setChartType);

  return (
    <div className="flex items-center gap-0.5 px-1 py-0.5 border-b" style={{borderColor:"var(--border)",background:"var(--bg-panel)"}}>
      <div className="flex items-center gap-0.5">
        {TOOLS.map((t) => (
          <button key={t.id} onClick={() => {
            if (t.id === "eraser") { clearDrawings(); return; }
            if (t.id === "magnet") { updateSettings({magnetMode:!settings.magnetMode}); return; }
            if (t.id === "hide") { updateSettings({showDrawings:!settings.showDrawings}); return; }
            if (t.id === "lock") { updateSettings({lockDrawings:!settings.lockDrawings}); return; }
            setActiveTool(t.id);
          }} className="w-7 h-7 flex items-center justify-center rounded text-xs tooltip-trigger"
            data-tooltip={t.label}
            style={{
              background: (activeTool===t.id||((t.id==="magnet"||t.id==="hide"||t.id==="lock")&&(
                (t.id==="magnet"&&settings.magnetMode)||(t.id==="hide"&&!settings.showDrawings)||(t.id==="lock"&&settings.lockDrawings)
              ))) ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "transparent",
              color: (activeTool===t.id||((t.id==="magnet"&&settings.magnetMode)||(t.id==="hide"&&!settings.showDrawings)||(t.id==="lock"&&settings.lockDrawings)))
                ? "var(--accent)" : "var(--text-muted)",
            }}>{t.icon}</button>
        ))}
      </div>
      <div className="h-5 w-px mx-1" style={{background:"var(--border)"}}/>
      <div className="flex items-center gap-0.5">
        <button onClick={undoDrawing} className="w-7 h-7 flex items-center justify-center rounded text-xs tooltip-trigger" data-tooltip="Undo" style={{color:"var(--text-muted)"}}>{"\u21b6"}</button>
        <button onClick={redoDrawing} className="w-7 h-7 flex items-center justify-center rounded text-xs tooltip-trigger" data-tooltip="Redo" style={{color:"var(--text-muted)"}}>{"\u21b7"}</button>
      </div>
      <div className="h-5 w-px mx-1" style={{background:"var(--border)"}}/>
      <div className="flex items-center gap-0.5">
        {(["candlestick","line","area"] as const).map((t) => (
          <button key={t} onClick={() => setChartType(t)} className="px-1.5 py-0.5 text-[10px] rounded"
            style={{background: chartType===t ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "transparent", color: chartType===t ? "var(--accent)" : "var(--text-muted)"}}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>
        ))}
      </div>
      <div className="h-5 w-px mx-1" style={{background:"var(--border)"}}/>
      <button onClick={()=>updateSettings({showGrid:!settings.showGrid})} className="px-1.5 py-0.5 text-[10px] rounded" style={{background:settings.showGrid?"color-mix(in srgb, var(--accent) 15%, transparent)":"transparent",color:settings.showGrid?"var(--accent)":"var(--text-muted)"}}>Grid</button>
      <button onClick={()=>updateSettings({showVolume:!settings.showVolume})} className="px-1.5 py-0.5 text-[10px] rounded" style={{background:settings.showVolume?"color-mix(in srgb, var(--accent) 15%, transparent)":"transparent",color:settings.showVolume?"var(--accent)":"var(--text-muted)"}}>Vol</button>
      <button onClick={()=>updateSettings({showIndicators:!settings.showIndicators})} className="px-1.5 py-0.5 text-[10px] rounded" style={{background:settings.showIndicators?"color-mix(in srgb, var(--accent) 15%, transparent)":"transparent",color:settings.showIndicators?"var(--accent)":"var(--text-muted)"}}>Ind</button>
      <div className="flex-1"/>
      <button onClick={()=>setFullscreen(!fullscreen)} className="px-1.5 py-0.5 text-[10px] rounded" style={{color:"var(--text-muted)"}}>{fullscreen?"\u2716 Fullscreen":"\u26f6 Full"}</button>
    </div>
  );
}
