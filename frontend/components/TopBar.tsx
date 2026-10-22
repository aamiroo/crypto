"use client";
import { useMarketStore } from "@/lib/store/marketStore";
import { useThemeStore } from "@/lib/store/themeStore";
import { useChartStore } from "@/lib/store/chartStore";
import { useAlertsStore } from "@/lib/store/alertsStore";
import { useUiStore } from "@/lib/store/uiStore";
import { useLayoutStore } from "@/lib/store/layoutStore";
import { SymbolPicker } from "@/components/SymbolPicker";
import { ConnectionStatus } from "@/components/ui/ConnectionStatus";
import { Popover } from "@/components/ui/Popover";

export function TopBar() {
  const toggleTheme = useThemeStore((s) => s.toggle);
  const theme = useThemeStore((s) => s.theme);
  const alerts = useAlertsStore((s) => s.alerts);
  const setAlertsOpen = useUiStore((s) => s.setAlertsOpen);
  const toggleShortcuts = useUiStore((s) => s.toggleShortcuts);

  const activeAlerts = alerts.filter((a) => !a.triggeredAt).length;

  return (
    <header className="flex h-11 flex-shrink-0 items-center gap-2 border-b px-2 sm:px-3" style={{ background: "var(--bg-primary)", borderColor: "var(--border)" }}>
      <div className="flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded text-[11px] font-bold" style={{ background: "color-mix(in srgb, var(--accent) 20%, transparent)", color: "var(--accent)" }}>C</div>
        <span className="hidden text-xs font-semibold tracking-wide sm:inline" style={{ color: "var(--text-secondary)" }}>CRYPTO TERMINAL</span>
      </div>
      <div className="divider-v" />
      <SymbolPicker />
      <div className="flex-1" />
      <ConnectionStatus />
      <button
        onClick={() => setAlertsOpen(true)}
        className="icon-btn relative h-7 w-7 text-[13px]"
        title="Price alerts"
        aria-label="Price alerts"
      >
        🔔
        {activeAlerts > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[8px] font-bold text-white" style={{ background: "var(--accent)" }}>
            {activeAlerts}
          </span>
        )}
      </button>
      <button onClick={toggleShortcuts} className="icon-btn hidden h-7 w-7 text-[12px] sm:flex" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">⌨</button>
      <button onClick={toggleTheme} className="icon-btn h-7 w-7 text-[13px]" title="Toggle theme" aria-label="Toggle theme">{theme === "dark" ? "☀" : "☾"}</button>
      <Popover label="⚙" tooltip="Settings & data source" className="icon-btn h-7 w-7 text-[13px]" align="right" width={240}>
        {(close) => <SettingsBody close={close} />}
      </Popover>
    </header>
  );
}

function SettingsBody({ close }: { close: () => void }) {
  const symbol = useMarketStore((s) => s.symbol);
  const symbols = useMarketStore((s) => s.symbols);
  const connected = useMarketStore((s) => s.connected);
  const tf = useChartStore((s) => s.timeframe);
  return (
    <div className="space-y-1 text-[11px]">
      <div className="px-1 pb-1 font-semibold" style={{ color: "var(--text-primary)" }}>Market Data</div>
      <KV k="Source" v="Bybit Spot (live)" />
      <KV k="Transport" v="WebSocket" />
      <KV k="Order source" v={connected ? "exchange" : "unavailable"} vc={connected ? "var(--success)" : "var(--danger)"} />
      <div className="my-1 h-px" style={{ background: "var(--border)" }} />
      <div className="px-1 pb-1 font-semibold" style={{ color: "var(--text-primary)" }}>Session</div>
      <KV k="Symbol" v={symbol} />
      <KV k="Timeframe" v={tf} />
      <KV k="Pairs" v={String(symbols.length)} />
      <div className="my-1 h-px" style={{ background: "var(--border)" }} />
      <div className="px-1 pb-1 font-semibold" style={{ color: "var(--text-primary)" }}>Workspace</div>
      <div className="flex items-center justify-between px-1 pt-1">
        <span style={{ color: "var(--text-muted)" }}>Reset layout</span>
        <button
          onClick={() => { useLayoutStore.getState().reset(); close(); }}
          className="rounded px-2 py-0.5 text-[10px]"
          style={{ background: "var(--bg-surface)", color: "var(--text-secondary)" }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function KV({ k, v, vc }: { k: string; v: string; vc?: string }) {
  return (
    <div className="flex justify-between px-1">
      <span style={{ color: "var(--text-muted)" }}>{k}</span>
      <span className="tabular-nums" style={{ color: vc || "var(--text-secondary)" }}>{v}</span>
    </div>
  );
}
