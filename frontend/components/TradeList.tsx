"use client";
import { useMarketStore } from "@/lib/store/marketStore";
import { fmtPrice, fmtQty, fmtTime } from "@/lib/utils/format";

export function TradeList({ symbol }: { symbol: string }) {
  const trades = useMarketStore((s) => s.recentTrades[symbol] ?? []);
  return (
    <div className="flex h-full flex-col overflow-hidden text-[11px]" style={{ background: "var(--bg-panel)" }}>
      <div className="panel-header flex-shrink-0 border-b" style={{ borderColor: "var(--border)" }}>Recent Trades</div>
      <div className="grid flex-shrink-0 grid-cols-[1fr_70px_46px_56px] px-2 py-0.5" style={{ color: "var(--text-muted)" }}>
        <span>Price</span><span className="text-right">Size</span><span className="text-right">Side</span><span className="text-right">Time</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {trades.length === 0 ? (
          <div className="flex h-full items-center justify-center" style={{ color: "var(--text-muted)" }}>Waiting for trades…</div>
        ) : (
          trades.map((t) => {
            const up = t.side === "buy";
            return (
              <div key={t.id} className="grid grid-cols-[1fr_70px_46px_56px] px-2 py-[1px] hover:bg-[var(--bg-hover)]">
                <span className="tabular-nums" style={{ color: up ? "var(--success)" : "var(--danger)" }}>{fmtPrice(t.price, symbol)}</span>
                <span className="text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>{fmtQty(t.size, symbol)}</span>
                <span className="text-right uppercase" style={{ color: up ? "var(--success)" : "var(--danger)" }}>{t.side}</span>
                <span className="text-right tabular-nums" style={{ color: "var(--text-muted)" }}>{t.ts ? fmtTime(t.ts) : ""}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
