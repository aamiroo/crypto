"use client";

import { useChartStore } from "@/lib/store/chartStore";
import { Popover } from "@/components/ui/Popover";
import type { IndicatorConfig } from "@/lib/types";

const QUICK_ADD: { type: IndicatorConfig["type"]; label: string; period: number; color: string }[] = [
  { type: "sma", label: "SMA", period: 20, color: "#f59e0b" },
  { type: "ema", label: "EMA", period: 50, color: "#8b5cf6" },
  { type: "rsi", label: "RSI", period: 14, color: "#38bdf8" },
  { type: "macd", label: "MACD", period: 12, color: "#2196f3" },
  { type: "bb", label: "BB", period: 20, color: "#f59e0b" },
];

const TYPE_LABEL: Record<IndicatorConfig["type"], string> = {
  sma: "SMA", ema: "EMA", rsi: "RSI", macd: "MACD", bb: "Bollinger", vol: "Volume",
};

export function IndicatorMenu() {
  const indicators = useChartStore((s) => s.indicators);
  const showIndicators = useChartStore((s) => s.settings.showIndicators);
  const addIndicator = useChartStore((s) => s.addIndicator);
  const updateIndicator = useChartStore((s) => s.updateIndicator);
  const removeIndicator = useChartStore((s) => s.removeIndicator);
  const toggleIndicator = useChartStore((s) => s.toggleIndicator);
  const updateSettings = useChartStore((s) => s.updateSettings);

  const visibleCount = indicators.filter((i) => i.visible).length;

  const add = (q: (typeof QUICK_ADD)[number]) => {
    const id = `${q.type}${q.period}-${Date.now().toString(36)}`;
    addIndicator({ id, type: q.type, period: q.period, visible: true, color: q.color });
    if (!showIndicators) updateSettings({ showIndicators: true });
  };

  return (
    <Popover label="ƒ" tooltip="Indicators" active={showIndicators && visibleCount > 0} align="left" width={280}>
      {() => (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-semibold" style={{ color: "var(--text-primary)" }}>Indicators</span>
            <label className="flex cursor-pointer items-center gap-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
              <input type="checkbox" checked={showIndicators} onChange={(e) => updateSettings({ showIndicators: e.target.checked })} />
              Show
            </label>
          </div>

          <div className="flex flex-wrap gap-1">
            {QUICK_ADD.map((q) => (
              <button
                key={q.type}
                onClick={() => add(q)}
                className="rounded px-2 py-1 text-[10px] font-medium"
                style={{ background: "var(--bg-surface)", color: "var(--text-secondary)" }}
                title={`Add ${q.label} (${q.period})`}
              >
                + {q.label}
              </button>
            ))}
          </div>

          <div className="space-y-1">
            {indicators.length === 0 && (
              <div className="px-1 py-2 text-center text-[10px]" style={{ color: "var(--text-muted)" }}>No indicators</div>
            )}
            {indicators.map((ind) => (
              <div key={ind.id} className="flex items-center gap-1.5 rounded px-1.5 py-1" style={{ background: "var(--bg-surface)" }}>
                <input
                  type="checkbox"
                  checked={ind.visible}
                  onChange={() => toggleIndicator(ind.id)}
                  title={ind.visible ? "Hide" : "Show"}
                />
                <input
                  type="color"
                  value={ind.color || "#f59e0b"}
                  onChange={(e) => updateIndicator(ind.id, { color: e.target.value })}
                  className="h-4 w-4 cursor-pointer rounded border-0 bg-transparent p-0"
                  title="Color"
                />
                <span className="flex-1 text-[10px] font-medium" style={{ color: "var(--text-secondary)" }}>{TYPE_LABEL[ind.type]}</span>
                {(ind.type === "sma" || ind.type === "ema" || ind.type === "rsi" || ind.type === "bb") && (
                  <input
                    type="number"
                    min={2}
                    max={400}
                    value={ind.period}
                    onChange={(e) => {
                      const p = parseInt(e.target.value, 10);
                      if (Number.isFinite(p) && p >= 2) updateIndicator(ind.id, { period: p });
                    }}
                    className="h-5 w-12 rounded px-1 text-[10px] tabular-nums outline-none"
                    style={{ background: "var(--bg-primary)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
                    title="Period"
                  />
                )}
                <button onClick={() => removeIndicator(ind.id)} className="icon-btn h-5 w-5 text-[10px]" title="Remove">✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}
