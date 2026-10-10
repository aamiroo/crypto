"use client";
import { useMarketStore } from "@/lib/store/marketStore";
import { fmtPrice, fmtQty, fmtTime } from "@/lib/utils/format";
export function TradeList({ symbol }: { symbol: string }) {
  const trades = useMarketStore((s) => s.recentTrades[symbol] ?? []);
  return (
    <div className="flex h-full flex-col overflow-hidden text-[11px]">
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider" style={{color:"var(--text-muted)"}}>Recent Trades</div>
      <div className="grid grid-cols-[1fr_70px_50px_50px] px-2 py-0.5" style={{color:"var(--text-muted)"}}>
        <span>Price</span><span className="text-right">Size</span><span className="text-right">Side</span><span className="text-right">Time</span>
      </div>
      <div className="flex-1 overflow-hidden">
        {trades.map((t) => (
          <div key={t.id} className="grid grid-cols-[1fr_70px_50px_50px] px-2 py-[1px]">
            <span className="tabular-nums" style={{color:t.side==="buy"?"var(--success)":"var(--danger)"}}>{fmtPrice(t.price,symbol)}</span>
            <span className="text-right tabular-nums" style={{color:"var(--text-muted)"}}>{fmtQty(t.size,symbol)}</span>
            <span className="text-right uppercase" style={{color:t.side==="buy"?"var(--success)":"var(--danger)"}}>{t.side}</span>
            <span className="text-right tabular-nums" style={{color:"var(--text-muted)"}}>{t.ts?fmtTime(t.ts):""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
