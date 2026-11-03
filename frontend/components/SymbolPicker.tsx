"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMarketStore, topLiquid } from "@/lib/store/marketStore";
import { useWatchlistStore } from "@/lib/store/watchlistStore";
import { fmtPrice, fmtPct } from "@/lib/utils/format";
import { baseAsset } from "@/lib/utils/symbol";
import { CoinIcon } from "@/components/CoinIcon";
import { SearchIcon } from "@/components/icons/ToolIcons";

/**
 * Searchable symbol selector with keyboard navigation. Live prices come from
 * the ticker map (already subscribed for every pair).
 */
export function SymbolPicker() {
  const symbols = useMarketStore((s) => s.symbols);
  const tickers = useMarketStore((s) => s.tickers);
  const selected = useMarketStore((s) => s.symbol);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const favorites = useWatchlistStore((s) => s.favorites);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // With no query the list is the market's own priority order — favourites on
  // top, then the most liquid pairs. Slicing the alphabetical list instead would
  // show 40 pairs that happen to start with "1" or "A" and hide every pair the
  // user actually came here to find.
  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) {
      const favSet = new Set(favorites);
      const rest = topLiquid(symbols, tickers, 40).filter((s) => !favSet.has(s));
      return [...favorites.filter((s) => symbols.includes(s)), ...rest].slice(0, 60);
    }
    const rank = (s: string) => (favorites.includes(s) ? 0 : 1);
    return symbols
      .filter((s) => s.includes(q))
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .slice(0, 60);
  }, [symbols, favorites, query, tickers]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (sym: string) => {
    setSymbol(sym);
    setQuery("");
    setHighlight(0);
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { const s = filtered[highlight]; if (s) choose(s); }
    else if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); }
  };

  return (
    <div className="relative" ref={ref}>
      <div className="flex h-7 items-center gap-1 rounded px-2" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
        <span className="flex flex-shrink-0 items-center" style={{ color: "var(--text-muted)" }}><SearchIcon size={13} /></span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setHighlight(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={baseAsset(selected) + "/USDT"}
          aria-label="Search symbol"
          className="w-28 bg-transparent text-xs outline-none sm:w-40"
          style={{ color: "var(--text-primary)" }}
        />
      </div>

      {open && (
        <div className="popover max-h-80 overflow-y-auto" style={{ left: 0, top: "calc(100% + 4px)", width: 260 }} role="listbox">
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-center text-[11px]" style={{ color: "var(--text-muted)" }}>No symbols match “{query}”</div>
          ) : (
            filtered.map((sym, i) => {
              const t = tickers[sym];
              const ch = t ? parseFloat(t.change24h) : 0;
              const up = ch >= 0;
              return (
                <button
                  key={sym}
                  role="option"
                  aria-selected={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(sym)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px]"
                  style={{ background: i === highlight ? "var(--bg-hover)" : "transparent" }}
                >
                  <CoinIcon symbol={sym} size="xs" />
                  <span className="flex-1 font-medium" style={{ color: "var(--text-secondary)" }}>{baseAsset(sym)}<span style={{ color: "var(--text-muted)" }}>/USDT</span></span>
                  <span className="tabular-nums" style={{ color: "var(--text-secondary)" }}>{t ? fmtPrice(t.lastPrice, sym) : "—"}</span>
                  <span className="w-14 text-right tabular-nums" style={{ color: up ? "var(--success)" : "var(--danger)" }}>{t ? fmtPct(ch) : "—"}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
