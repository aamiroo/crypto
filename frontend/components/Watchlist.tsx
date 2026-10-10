"use client";
import { useState, useMemo } from "react";
import { useMarketStore } from "@/lib/store/marketStore";
import { fmtPrice, fmtPct } from "@/lib/utils/format";
import { baseAsset } from "@/lib/utils/symbol";
import { CoinIcon } from "@/components/CoinIcon";
export function Watchlist() {
  const symbols = useMarketStore((s) => s.symbols);
  const tickers = useMarketStore((s) => s.tickers);
  const selected = useMarketStore((s) => s.symbol);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"sym"|"price"|"change"|"vol">("sym");
  const filtered = useMemo(() => {
    let list = query ? symbols.filter((s) => s.toLowerCase().includes(query.toLowerCase())) : symbols;
    if (sort !== "sym") list = [...list].sort((a, b) => {
      const ta = tickers[a], tb = tickers[b]; if (!ta || !tb) return 0;
      if (sort === "price") return parseFloat(tb.lastPrice) - parseFloat(ta.lastPrice);
      if (sort === "change") return parseFloat(tb.change24h) - parseFloat(ta.change24h);
      return parseFloat(tb.volume24h) - parseFloat(ta.volume24h);
    });
    return list;
  }, [symbols, tickers, query, sort]);
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider" style={{color:"var(--text-muted)"}}>Watchlist</div>
      <input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Filter..." className="mx-2 mb-1 h-6 rounded px-2 text-[11px] outline-none" style={{background:"var(--bg-surface)",color:"var(--text-secondary)"}} />
      <div className="grid grid-cols-[1fr_60px_45px] gap-x-1 px-2 text-[9px] border-b pb-0.5" style={{color:"var(--text-muted)",borderColor:"var(--border)"}}>
        <button onClick={()=>setSort("sym")} className="text-left">Symbol</button>
        <button onClick={()=>setSort("price")} className="text-right">Price</button>
        <button onClick={()=>setSort("change")} className="text-right">24h</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.map((sym) => {
          const t = tickers[sym]; const ch = t ? parseFloat(t.change24h)*100 : 0; const up = ch >= 0;
          return (<button key={sym} onClick={()=>setSymbol(sym)} className="w-full text-left grid grid-cols-[1fr_60px_45px] gap-x-1 px-2 py-[3px]"
            style={{background:sym===selected?"var(--bg-surface)":"transparent",borderLeft:sym===selected?"2px solid var(--accent)":"2px solid transparent"}}>
            <span className="flex items-center gap-1 truncate text-[11px] font-medium" style={{color:"var(--text-secondary)"}}><CoinIcon symbol={sym} size="xs" /> {baseAsset(sym)}</span>
            <span className="text-right text-[11px] tabular-nums" style={{color:"var(--text-secondary)"}}>{t?fmtPrice(t.lastPrice,sym):"\u2014"}</span>
            <span className="text-right text-[10px] tabular-nums" style={{color:up?"var(--success)":"var(--danger)"}}>{t?fmtPct(ch):"\u2014"}</span>
          </button>);
        })}
      </div>
    </div>
  );
}
