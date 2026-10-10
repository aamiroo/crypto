"use client";
import { useState, useRef, useEffect } from "react";
import { useMarketStore } from "@/lib/store/marketStore";
import { useThemeStore } from "@/lib/store/themeStore";
import { useChartStore } from "@/lib/store/chartStore";
import { CoinIcon } from "@/components/CoinIcon";

export function TopBar() {
  const connected = useMarketStore((s) => s.connected);
  const symbols = useMarketStore((s) => s.symbols);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const theme = useThemeStore((s) => s.theme);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const filtered = query ? symbols.filter((s) => s.toLowerCase().includes(query.toLowerCase())) : [];

  // Determine connection status
  const statusText = connected ? "\u25cf LIVE" : "\u26a0 RECONNECTING";
  const statusColor = connected ? "var(--success)" : "var(--warning)";
  useEffect(() => {
    const h = (e: MouseEvent) => { if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <header className="flex h-10 items-center gap-3 border-b px-3" style={{ background: "var(--bg-primary)", borderColor: "var(--border)" }}>
      <div className="flex items-center gap-2">
        <div className="h-5 w-5 rounded flex items-center justify-center text-[10px] font-bold" style={{ background: "color-mix(in srgb, var(--accent) 20%, transparent)", color: "var(--accent)" }}>C</div>
        <span className="text-xs font-semibold tracking-wide" style={{ color: "var(--text-muted)" }}>CRYPTO TERMINAL</span>
      </div>
      <div className="h-4 w-px" style={{ background: "var(--border)" }} />
      <div className="relative">
        <input value={query} onChange={(e) => { setQuery(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)} placeholder="Search symbol..." className="h-7 w-40 rounded px-2 text-xs outline-none" style={{ background: "var(--bg-surface)", color: "var(--text-primary)" }} />
        {open && filtered.length > 0 && (<div className="absolute top-8 left-0 z-50 max-h-60 w-48 overflow-y-auto rounded border shadow-xl" style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}>
          {filtered.slice(0, 30).map((sym) => (<button key={sym} onClick={() => { useMarketStore.getState().setSymbol(sym); setQuery(""); setOpen(false); }} className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs" style={{ color: "var(--text-secondary)" }}><CoinIcon symbol={sym} size="xs" /> {sym}</button>))}
        </div>)}
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-2 text-[11px]">
        <span style={{ color: "var(--text-muted)" }}>{symbols.length} pairs</span>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: connected ? "var(--success)" : "var(--warning)" }} />
        <span style={{ color: statusColor }}>{statusText}</span>
        <button onClick={toggleTheme} className="flex h-6 w-6 items-center justify-center rounded" style={{ color: "var(--text-muted)" }}>{theme === "dark" ? "\u2600" : "\u263e"}</button>
        <div className="relative" ref={settingsRef}>
          <button onClick={() => setSettingsOpen((p) => !p)} className="flex h-6 w-6 items-center justify-center rounded" style={{ color: "var(--text-muted)" }}>{"\u2699"}</button>
          {settingsOpen && (<div className="absolute right-0 top-8 z-50 w-52 rounded border p-2 shadow-xl text-[11px] space-y-1" style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}>
            <div className="font-semibold pb-1" style={{ color: "var(--text-primary)" }}>Market Data</div>
            <KV k="Source" v="Bybit" /><KV k="Connection" v="WebSocket" /><KV k="Mode" v="PAPER" vc="var(--accent)" />
            <div className="h-px my-1" style={{ background: "var(--border)" }} />
            <KV k="Symbol" v={useMarketStore.getState().symbol} /><KV k="Timeframe" v={useChartStore.getState().timeframe} />
          </div>)}
        </div>
      </div>
    </header>
  );
}
function KV({ k, v, vc }: { k: string; v: string; vc?: string }) {
  return <div className="flex justify-between"><span style={{ color: "var(--text-muted)" }}>{k}</span><span className="tabular-nums" style={{ color: vc || "var(--text-secondary)" }}>{v}</span></div>;
}
