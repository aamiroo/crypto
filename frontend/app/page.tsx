"use client";
import { useEffect, useState } from "react";
import { useMarketFeed } from "@/lib/ws/useMarketFeed";
import { useMarketStore } from "@/lib/store/marketStore";
import { useChartStore } from "@/lib/store/chartStore";
import { useLayoutStore, WATCHLIST_MIN, WATCHLIST_MAX } from "@/lib/store/layoutStore";
import { useUiStore, type MobilePanel } from "@/lib/store/uiStore";
import { useAlertEngine } from "@/lib/hooks/useAlertEngine";
import { useKeyboardShortcuts } from "@/lib/hooks/useKeyboardShortcuts";
import { useMediaQuery, DESKTOP_QUERY } from "@/lib/hooks/useMediaQuery";
import { TopBar } from "@/components/TopBar";
import { MarketHeader } from "@/components/MarketHeader";
import { ChartPanel } from "@/components/ChartPanel";
import { ChartToolbar } from "@/components/ChartToolbar";
import { OrderBook } from "@/components/OrderBook";
import { TradeList } from "@/components/TradeList";
import { Watchlist } from "@/components/Watchlist";
import { ShortcutsModal } from "@/components/ShortcutsModal";
import { AlertsPanel } from "@/components/AlertsPanel";
import { Toasts } from "@/components/ui/Toasts";
import { ResizeHandle } from "@/components/ui/ResizeHandle";

export default function TerminalPage() {
  useMarketFeed();
  useAlertEngine();
  useKeyboardShortcuts();

  const symbol = useMarketStore((s) => s.symbol);
  const fullscreen = useChartStore((s) => s.fullscreen);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  // Stores initialize from localStorage (symbol, timeframe, theme, ...) which
  // differs from the server-rendered markup. Rendering the terminal only after
  // mount avoids hydration mismatches (and the full client re-render / chart
  // remount they cause) while showing a proper boot loading state.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) return <BootSplash />;

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: "var(--bg-primary)" }}>
      <TopBar />
      {fullscreen ? (
        <FullscreenChart symbol={symbol} />
      ) : isDesktop ? (
        <DesktopLayout symbol={symbol} />
      ) : (
        <MobileLayout symbol={symbol} />
      )}
      <ShortcutsModal />
      <AlertsPanel />
      <Toasts />
    </div>
  );
}

function FullscreenChart({ symbol }: { symbol: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <MarketHeader symbol={symbol} />
      <ChartToolbar symbol={symbol} />
      <div className="min-h-0 flex-1 overflow-hidden"><ChartPanel symbol={symbol} /></div>
    </div>
  );
}

function DesktopLayout({ symbol }: { symbol: string }) {
  const watchlistOpen = useLayoutStore((s) => s.watchlistOpen);
  const watchlistWidth = useLayoutStore((s) => s.watchlistWidth);
  const setWatchlistWidth = useLayoutStore((s) => s.setWatchlistWidth);
  const toggle = useLayoutStore((s) => s.toggle);
  const rightPanelOpen = useLayoutStore((s) => s.rightPanelOpen);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {watchlistOpen ? (
        <>
          <div className="flex-shrink-0 overflow-hidden" style={{ width: watchlistWidth, borderRight: "1px solid var(--border)" }}>
            <Watchlist onCollapse={() => toggle("watchlistOpen")} />
          </div>
          <ResizeHandle
            orientation="vertical"
            ariaLabel="Resize watchlist"
            getSize={() => useLayoutStore.getState().watchlistWidth}
            onResize={(w) => setWatchlistWidth(Math.min(WATCHLIST_MAX, Math.max(WATCHLIST_MIN, w)))}
          />
        </>
      ) : (
        <CollapsedRail label="Watchlist" side="left" onExpand={() => toggle("watchlistOpen")} />
      )}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <MarketHeader symbol={symbol} />
        <ChartToolbar symbol={symbol} />
        <div className="min-h-0 flex-1 overflow-hidden"><ChartPanel symbol={symbol} /></div>
      </main>

      {rightPanelOpen ? (
        <div className="flex w-80 flex-shrink-0 flex-col overflow-hidden" style={{ borderLeft: "1px solid var(--border)" }}>
          <div className="min-h-0 flex-1 overflow-hidden" style={{ borderBottom: "1px solid var(--border)" }}>
            <OrderBook symbol={symbol} onCollapse={() => toggle("rightPanelOpen")} />
          </div>
          <div className="h-48 flex-shrink-0 overflow-hidden"><TradeList symbol={symbol} /></div>
        </div>
      ) : (
        <CollapsedRail label="Book & Trades" side="right" onExpand={() => toggle("rightPanelOpen")} />
      )}

    </div>
  );
}

function MobileLayout({ symbol }: { symbol: string }) {
  const panel = useUiStore((s) => s.mobilePanel);
  const setPanel = useUiStore((s) => s.setMobilePanel);
  const tabs: { id: MobilePanel; label: string }[] = [
    { id: "none", label: "Chart" },
    { id: "watchlist", label: "Watchlist" },
    { id: "book", label: "Book" },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-shrink-0 border-b" style={{ borderColor: "var(--border)", background: "var(--bg-panel)" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setPanel(t.id)}
            className="flex-1 py-1.5 text-[11px] font-medium"
            style={{
              color: panel === t.id ? "var(--accent)" : "var(--text-muted)",
              borderBottom: panel === t.id ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {panel === "none" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <MarketHeader symbol={symbol} />
          <ChartToolbar symbol={symbol} />
          <div className="min-h-0 flex-1 overflow-hidden"><ChartPanel symbol={symbol} /></div>
        </div>
      )}
      {panel === "watchlist" && (
        <div className="min-h-0 flex-1 overflow-hidden"><Watchlist /></div>
      )}
      {panel === "book" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-hidden" style={{ borderBottom: "1px solid var(--border)" }}><OrderBook symbol={symbol} /></div>
          <div className="h-2/5 min-h-0 overflow-hidden"><TradeList symbol={symbol} /></div>
        </div>
      )}
    </div>
  );
}

function CollapsedRail({ label, side, onExpand }: { label: string; side: "left" | "right"; onExpand: () => void }) {
  return (
    <div className="flex w-6 flex-shrink-0 flex-col items-center" style={{ background: "var(--bg-panel)", borderLeft: side === "right" ? "1px solid var(--border)" : undefined, borderRight: side === "left" ? "1px solid var(--border)" : undefined }}>
      <button onClick={onExpand} className="icon-btn mt-1 h-5 w-5 text-[12px]" title={`Expand ${label}`}>
        {side === "left" ? "›" : "‹"}
      </button>
      <div className="mt-2 select-none text-[9px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)", writingMode: "vertical-rl" }}>
        {label}
      </div>
    </div>
  );
}

function BootSplash() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3" style={{ background: "var(--bg-primary)" }}>
      <div className="h-6 w-6 animate-spin rounded-full border-2" style={{ borderColor: "var(--border)", borderTopColor: "var(--accent)" }} />
      <span className="text-xs tracking-wide" style={{ color: "var(--text-muted)" }}>Loading terminal…</span>
    </div>
  );
}
