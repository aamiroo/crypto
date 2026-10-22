"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMarketStore } from "@/lib/store/marketStore";
import { useWatchlistStore } from "@/lib/store/watchlistStore";
import { fmtPrice, fmtPct } from "@/lib/utils/format";
import { baseAsset } from "@/lib/utils/symbol";
import { CoinIcon } from "@/components/CoinIcon";

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

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    const list = q ? symbols.filter((s) => s.includes(q)) : symbols;
    const rank = (s: string) => (favorites.includes(s) ? 0 : 1);
    return [...list]
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .slice(0, 40);
  }, [symbols, favorites, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => { setHighlight(0); }, [query]);

  const choose = (sym: string) => {
    setSymbol(sym);
    setQuery("");
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
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>⌕</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
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
