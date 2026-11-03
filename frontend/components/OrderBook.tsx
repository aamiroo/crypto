"use client";
import { useMemo, useState } from "react";
import { useMarketStore, selectDepth } from "@/lib/store/marketStore";
import { fmtPrice, fmtQty } from "@/lib/utils/format";
import { Panel } from "@/components/ui/Panel";

const DEPTH_OPTIONS = [10, 20, 50];

interface Row { price: string; size: string; total: number; }

/** Running depth total per level. `max` is deliberately this side's own worst
 *  case, not the global one: bids and asks each scale against the shared max in
 *  the render, so the shorter side keeps a visible ramp instead of collapsing. */
function buildRows(levels: [string, string][]): { rows: Row[]; max: number } {
  let cumulative = 0;
  let max = 0;
  const rows = levels.map(([price, size]) => {
    cumulative += parseFloat(size) || 0;
    if (cumulative > max) max = cumulative;
    return { price, size, total: cumulative };
  });
  return { rows, max: max || 1 };
}

export function OrderBook({ symbol, onCollapse }: { symbol: string; onCollapse?: () => void }) {
  const [depth, setDepth] = useState(20);
  const bids = useMarketStore((s) => selectDepth(s, symbol, depth).bids);
  const asks = useMarketStore((s) => selectDepth(s, symbol, depth).asks);
  const ticker = useMarketStore((s) => s.tickers[symbol]);

  const bidData = useMemo(() => buildRows(bids), [bids]);
  const askData = useMemo(() => buildRows(asks), [asks]);
  const maxTotal = Math.max(bidData.max, askData.max);

  const bestBid = bids[0] ? parseFloat(bids[0][0]) : null;
  const bestAsk = asks[0] ? parseFloat(asks[0][0]) : null;
  const lastPrice = ticker ? parseFloat(ticker.lastPrice) : 0;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const spreadPct = spread != null && bestAsk ? (spread / bestAsk) * 100 : null;
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : lastPrice;

  const hasData = bids.length > 0 || asks.length > 0;

  return (
    <Panel
      title="Order Book"
      side="right"
      onCollapse={onCollapse}
      right={
        <div className="flex items-center gap-0.5">
          {DEPTH_OPTIONS.map((d) => (
            <button key={d} onClick={() => setDepth(d)} className="seg-btn" data-active={depth === d}>{d}</button>
          ))}
        </div>
      }
    >
      <div className="flex h-full flex-col overflow-hidden text-[11px]">
        <div className="grid flex-shrink-0 grid-cols-[1fr_70px_60px] px-2 py-0.5" style={{ color: "var(--text-muted)" }}>
          <span>Price</span><span className="text-right">Size</span><span className="text-right">Total</span>
        </div>

        {!hasData ? (
          <div className="flex flex-1 items-center justify-center text-[11px]" style={{ color: "var(--text-muted)" }}>
            Waiting for order book…
          </div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
              {[...askData.rows].reverse().map((r, i) => (
                <div key={`a-${i}`} className="relative grid grid-cols-[1fr_70px_60px] px-2 py-[1px] text-left">
                  <div className="depth-bar absolute inset-y-0 right-0" style={{ width: `${(r.total / maxTotal) * 100}%`, background: "color-mix(in srgb, var(--danger) 12%, transparent)" }} />
                  <span className="relative tabular-nums" style={{ color: "var(--danger)" }}>{fmtPrice(r.price, symbol)}</span>
                  <span className="relative text-right tabular-nums" style={{ color: "var(--text-muted)" }}>{fmtQty(r.size, symbol)}</span>
                  <span className="relative text-right tabular-nums" style={{ color: "var(--text-muted)" }}>{fmtQty(r.total, symbol)}</span>
                </div>
              ))}
            </div>

            <div className="flex flex-shrink-0 items-center justify-between px-2 py-1" style={{ background: "var(--bg-panel)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
              <span className="text-sm font-semibold tabular-nums" style={{ color: mid > 0 ? "var(--text-primary)" : "var(--text-muted)" }}>
                {mid > 0 ? fmtPrice(mid, symbol) : "—"}
              </span>
              <span className="text-[10px] tabular-nums" title="Best bid/ask spread" style={{ color: "var(--text-muted)" }}>
                {spread != null ? <>Spread {fmtPrice(spread, symbol)}{spreadPct != null && <> · {spreadPct.toFixed(3)}%</>}</> : "—"}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {bidData.rows.map((r, i) => (
                <div key={`b-${i}`} className="relative grid grid-cols-[1fr_70px_60px] px-2 py-[1px] text-left">
                  <div className="depth-bar absolute inset-y-0 right-0" style={{ width: `${(r.total / maxTotal) * 100}%`, background: "color-mix(in srgb, var(--success) 12%, transparent)" }} />
                  <span className="relative tabular-nums" style={{ color: "var(--success)" }}>{fmtPrice(r.price, symbol)}</span>
                  <span className="relative text-right tabular-nums" style={{ color: "var(--text-muted)" }}>{fmtQty(r.size, symbol)}</span>
                  <span className="relative text-right tabular-nums" style={{ color: "var(--text-muted)" }}>{fmtQty(r.total, symbol)}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="flex-shrink-0 px-2 py-1 text-center text-[10px]" style={{ color: "var(--text-muted)" }}>
          Live · Bybit depth{lastPrice > 0 ? ` · last ${fmtPrice(lastPrice, symbol)}` : ""}
        </div>
      </div>
    </Panel>
  );
}
