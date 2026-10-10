"use client";
import { useEffect, useState } from "react";
import { useMarketFeed } from "@/lib/ws/useMarketFeed";
import { useMarketStore } from "@/lib/store/marketStore";
import { useChartStore } from "@/lib/store/chartStore";
import { TopBar } from "@/components/TopBar";
import { MarketHeader } from "@/components/MarketHeader";
import { ChartPanel } from "@/components/ChartPanel";
import { ChartToolbar } from "@/components/ChartToolbar";
import { OrderBook } from "@/components/OrderBook";
import { TradeList } from "@/components/TradeList";
import { Watchlist } from "@/components/Watchlist";
import { TradingPanel } from "@/components/TradingPanel";
import { BottomPanel } from "@/components/BottomPanel";

export default function TerminalPage() {
  useMarketFeed();
  const symbol = useMarketStore((s) => s.symbol);
  const fullscreen = useChartStore((s) => s.fullscreen);
  // Stores initialize from localStorage (symbol, timeframe, theme, ...) which
  // differs from the server-rendered markup. Rendering the terminal only after
  // mount avoids hydration mismatches (and the full client re-render / chart
  // remount they cause) while showing a proper boot loading state.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) return <BootSplash />;
  if (fullscreen) {
    return (<div className="flex h-screen flex-col overflow-hidden" style={{background:"var(--bg-primary)"}}>
      <TopBar /><div className="flex-1 overflow-hidden flex flex-col">
      <MarketHeader symbol={symbol} /><ChartToolbar />
      <div className="flex-1 overflow-hidden"><ChartPanel symbol={symbol} /></div></div></div>);
  }
  return (<div className="flex h-screen flex-col overflow-hidden" style={{background:"var(--bg-primary)"}}>
    <TopBar /><div className="flex flex-1 overflow-hidden">
    <aside className="w-56 flex-shrink-0 overflow-hidden flex flex-col" style={{borderRight:"1px solid var(--border)"}}><Watchlist /></aside>
    <main className="flex flex-1 flex-col overflow-hidden">
      <MarketHeader symbol={symbol} /><ChartToolbar />
      <div className="flex-1 overflow-hidden"><ChartPanel symbol={symbol} /></div>
      <div className="h-48 flex-shrink-0" style={{borderTop:"1px solid var(--border)"}}><BottomPanel /></div>
    </main>
    <aside className="w-80 flex-shrink-0 flex flex-col overflow-hidden" style={{borderLeft:"1px solid var(--border)"}}>
      <div className="flex-1 overflow-hidden"><OrderBook symbol={symbol} /></div>
      <div className="h-48 flex-shrink-0 overflow-hidden" style={{borderTop:"1px solid var(--border)"}}><TradeList symbol={symbol} /></div>
    </aside>
    <aside className="w-72 flex-shrink-0 overflow-hidden flex flex-col" style={{borderLeft:"1px solid var(--border)"}}><TradingPanel symbol={symbol} /></aside>
    </div></div>);
}

function BootSplash() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3" style={{ background: "var(--bg-primary)" }}>
      <div className="h-6 w-6 animate-spin rounded-full border-2" style={{ borderColor: "var(--border)", borderTopColor: "var(--accent)" }} />
      <span className="text-xs tracking-wide" style={{ color: "var(--text-muted)" }}>Loading terminal…</span>
    </div>
  );
}
