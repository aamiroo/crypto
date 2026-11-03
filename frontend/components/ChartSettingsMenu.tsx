"use client";

import { useChartStore } from "@/lib/store/chartStore";
import { Popover } from "@/components/ui/Popover";
import { RESET_VIEW_EVENT } from "@/lib/hooks/useKeyboardShortcuts";
import { GearIcon } from "@/components/icons/ToolIcons";
import type { ChartSettings } from "@/lib/types";

export function ChartSettingsMenu() {
  const settings = useChartStore((s) => s.settings);
  const update = useChartStore((s) => s.updateSettings);

  const Toggle = ({ label, k }: { label: string; k: keyof ChartSettings }) => (
    <label className="flex cursor-pointer items-center justify-between gap-2 rounded px-1.5 py-1 text-[11px]" style={{ color: "var(--text-secondary)" }}>
      {label}
      <input type="checkbox" checked={Boolean(settings[k])} onChange={(e) => update({ [k]: e.target.checked } as Partial<ChartSettings>)} />
    </label>
  );

  return (
    <Popover label={<GearIcon size={14} />} tooltip="Chart settings" align="right" width={220}>
      {() => (
        <div className="space-y-0.5">
          <div className="px-1 pb-1 text-[11px] font-semibold" style={{ color: "var(--text-primary)" }}>Chart</div>
          <Toggle label="Grid lines" k="showGrid" />
          <Toggle label="Volume" k="showVolume" />
          <Toggle label="Indicators" k="showIndicators" />
          <Toggle label="Auto scale price" k="autoScale" />
          <Toggle label="Show drawings" k="showDrawings" />
          <div className="my-1 h-px" style={{ background: "var(--border)" }} />
          <button
            onClick={() => window.dispatchEvent(new Event(RESET_VIEW_EVENT))}
            className="w-full rounded px-1.5 py-1 text-left text-[11px]"
            style={{ color: "var(--text-secondary)" }}
          >
            Reset view / jump to latest
          </button>
        </div>
      )}
    </Popover>
  );
}
