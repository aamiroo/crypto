"use client";
import { memo, useMemo, useRef, useState, useEffect } from "react";
import { useMarketStore } from "@/lib/store/marketStore";
import { useWatchlistStore } from "@/lib/store/watchlistStore";
import { fmtPrice, fmtPct, fmtVolume } from "@/lib/utils/format";
import { baseAsset } from "@/lib/utils/symbol";
import { CoinIcon } from "@/components/CoinIcon";
import { Panel } from "@/components/ui/Panel";
import { useVirtualList } from "@/lib/hooks/useVirtualList";

type Tab = "favorites" | "all";
type SortKey = "sym" | "price" | "change" | "vol";

const ROW_H = 24;

export function Watchlist({ onCollapse }: { onCollapse?: () => void }) {
  const symbols = useMarketStore((s) => s.symbols);
  const tickers = useMarketStore((s) => s.tickers);
  const selected = useMarketStore((s) => s.symbol);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const favorites = useWatchlistStore((s) => s.favorites);
  const toggleFavorite = useWatchlistStore((s) => s.toggleFavorite);

  const [tab, setTab] = useState<Tab>("favorites");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("sym");
  const [asc, setAsc] = useState(true);

  const favSet = useMemo(() => new Set(favorites), [favorites]);

  // Only the ticker-sorted views read the map, so the default alphabetical list
  // does not re-filter and re-sort on every 250 ms ticker flush.
  const sortTickers = sort === "sym" ? null : tickers;

  const rows = useMemo(() => {
    const universe = tab === "favorites"
      ? (favorites.length ? favorites : symbols.slice(0, 30))
      : symbols;
    const q = query.trim().toUpperCase();
    let list = q ? universe.filter((s) => s.includes(q)) : universe;
    if (sort !== "sym" && sortTickers) {
      list = [...list].sort((a, b) => {
        const ta = sortTickers[a], tb = sortTickers[b];
        if (!ta || !tb) return Number(!!tb) - Number(!!ta);
        if (sort === "price") return parseFloat(tb.lastPrice) - parseFloat(ta.lastPrice);
        if (sort === "change") return parseFloat(tb.change24h) - parseFloat(ta.change24h);
        return parseFloat(tb.volume24h) - parseFloat(ta.volume24h);
      });
    } else if (sort === "sym" && !asc) {
      list = [...list].reverse();
    }
    return list;
  }, [tab, favorites, symbols, query, sort, asc, sortTickers]);

  const virt = useVirtualList(rows.length, ROW_H);
  const scroller = useRef<HTMLDivElement>(null);

  // Filter/tab changes keep the window near the top of the new list.
  useEffect(() => { scroller.current?.scrollTo(0, 0); }, [query, tab, sort, asc]);

  const sortBy = (k: SortKey) => {
    if (sort === k) setAsc((v) => !v);
    else { setSort(k); setAsc(k !== "sym"); }
  };

  const arrow = (k: SortKey) => (sort === k ? (asc ? "▲" : "▼") : "");
  const slice = rows.slice(virt.start, virt.end);

  return (
    <Panel
      title="Watchlist"
      onCollapse={onCollapse}
      right={
        <div className="flex items-center gap-0.5">
          <button onClick={() => setTab("favorites")} className="seg-btn" data-active={tab === "favorites"}>★</button>
          <button onClick={() => setTab("all")} className="seg-btn" data-active={tab === "all"}>All</button>
        </div>
      }
    >
      <div className="flex h-full flex-col overflow-hidden">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter symbols…"
          aria-label="Filter watchlist"
          className="mx-2 mb-1 h-6 flex-shrink-0 rounded px-2 text-[11px] outline-none"
          style={{ background: "var(--bg-surface)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
        />
        <div className="grid flex-shrink-0 grid-cols-[16px_1fr_64px_52px_50px] gap-x-1 border-b px-2 pb-0.5 text-[9px]" style={{ color: "var(--text-muted)", borderColor: "var(--border)" }}>
          <span />
          <button onClick={() => sortBy("sym")} className="text-left uppercase tracking-wide">Symbol {arrow("sym")}</button>
          <button onClick={() => sortBy("price")} className="text-right uppercase tracking-wide">Price {arrow("price")}</button>
          <button onClick={() => sortBy("change")} className="text-right uppercase tracking-wide">24h {arrow("change")}</button>
          <button onClick={() => sortBy("vol")} className="text-right uppercase tracking-wide">Vol {arrow("vol")}</button>
        </div>
        {rows.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-3 text-center">
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {tab === "favorites" ? "No favorites yet" : "No symbols"}
            </span>
            {tab === "favorites" && (
              <button onClick={() => setTab("all")} className="text-[10px]" style={{ color: "var(--accent)" }}>Browse all markets</button>
            )}
          </div>
        ) : (
          <div ref={scroller} onScroll={virt.onScroll} className="min-h-0 flex-1 overflow-y-auto">
            <div style={{ height: rows.length * ROW_H, position: "relative" }}>
              <div style={{ transform: `translateY(${virt.offsetY}px)` }}>
                {slice.map((sym) => (
                  <WatchlistRow
                    key={sym}
                    symbol={sym}
                    selected={sym === selected}
                    favorite={favSet.has(sym)}
                    onPick={setSymbol}
                    onToggleFavorite={toggleFavorite}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * Each row subscribes to its own ticker, so a market-wide update only repaints
 * the rows that actually changed instead of the whole list.
 */
const WatchlistRow = memo(function WatchlistRow({
  symbol, selected, favorite, onPick, onToggleFavorite,
}: {
  symbol: string;
  selected: boolean;
  favorite: boolean;
  onPick: (s: string) => void;
  onToggleFavorite: (s: string) => void;
}) {
  const t = useMarketStore((s) => s.tickers[symbol]);
  const change = t ? parseFloat(t.change24h) : 0;
  const up = change >= 0;

  return (
    <div
      className="group grid grid-cols-[16px_1fr_64px_52px_50px] items-center gap-x-1 px-2"
      style={{
        height: ROW_H,
        background: selected ? "var(--bg-surface)" : "transparent",
        borderLeft: selected ? "2px solid var(--accent)" : "2px solid transparent",
      }}
    >
      <button
        onClick={() => onToggleFavorite(symbol)}
        title={favorite ? "Remove from favorites" : "Add to favorites"}
        aria-label={favorite ? `Remove ${symbol} from favorites` : `Add ${symbol} to favorites`}
        className="text-[10px] leading-none"
        style={{ color: favorite ? "var(--accent)" : "var(--text-muted)" }}
      >
        {favorite ? "★" : "☆"}
      </button>
      <button onClick={() => onPick(symbol)} className="flex min-w-0 items-center gap-1 text-left">
        <CoinIcon symbol={symbol} size="xs" />
        <span className="truncate text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>{baseAsset(symbol)}</span>
      </button>
      <button onClick={() => onPick(symbol)} className="text-right text-[11px] tabular-nums" style={{ color: "var(--text-secondary)" }}>
        {t ? fmtPrice(t.lastPrice, symbol) : "—"}
      </button>
      <span className="text-right text-[10px] tabular-nums" style={{ color: up ? "var(--success)" : "var(--danger)" }}>
        {t ? fmtPct(change) : "—"}
      </span>
      <span className="text-right text-[10px] tabular-nums" style={{ color: "var(--text-muted)" }}>
        {t ? fmtVolume(t.volume24h) : "—"}
      </span>
    </div>
  );
});
