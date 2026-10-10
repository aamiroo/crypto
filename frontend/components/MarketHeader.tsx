"use client";
import { useRef, useEffect } from "react";
import { useMarketStore } from "@/lib/store/marketStore";
import { useChartStore } from "@/lib/store/chartStore";
import { fmtPrice, fmtPct, fmtVolume } from "@/lib/utils/format";
import { baseAsset } from "@/lib/utils/symbol";
import { CoinIcon } from "@/components/CoinIcon";
import type { Timeframe } from "@/lib/types";
const TF: Timeframe[] = ["1m","3m","5m","15m","30m","1h","4h","1d","1w"];
export function MarketHeader({ symbol }: { symbol: string }) {
  const ticker = useMarketStore((s) => s.tickers[symbol]);
  const tf = useChartStore((s) => s.timeframe);
  const setTf = useChartStore((s) => s.setTimeframe);
  const prevPrice = useRef(parseFloat(ticker?.lastPrice || "0"));
  const flashRef = useRef<HTMLSpanElement>(null);
  const lastPrice = ticker?.lastPrice;
  useEffect(() => {
    if (!lastPrice) return;
    const cur = parseFloat(lastPrice);
    if (cur !== prevPrice.current && flashRef.current) {
      flashRef.current.classList.remove("flash-text-green","flash-text-red");
      void flashRef.current.offsetWidth;
      flashRef.current.classList.add(cur > prevPrice.current ? "flash-text-green" : "flash-text-red");
    }
    prevPrice.current = cur;
  }, [lastPrice]);
  const change = ticker ? parseFloat(ticker.change24h) : 0;
  const pctVal = Math.abs(change) < 1 ? change * 100 : change;
  const up = pctVal >= 0;
  const color = up ? "var(--success)" : "var(--danger)";
  return (
    <div className="flex items-center gap-3 border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
      <CoinIcon symbol={symbol} size="md" />
      <div className="flex items-center gap-1">
        <span className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>{baseAsset(symbol)}</span>
        <span className="text-sm" style={{ color: "var(--text-muted)" }}>/USDT</span>
      </div>
      {ticker && (<>
        <span ref={flashRef} className="text-sm font-semibold tabular-nums" style={{ color }}>{fmtPrice(ticker.lastPrice, symbol)}</span>
        <span className="text-xs tabular-nums" style={{ color }}>{fmtPct(change)}</span>
        {ticker.bidPrice && <span className="text-[11px] tabular-nums" style={{ color: "var(--success)" }}>Bid {fmtPrice(ticker.bidPrice, symbol)}</span>}
        {ticker.askPrice && <span className="text-[11px] tabular-nums" style={{ color: "var(--danger)" }}>Ask {fmtPrice(ticker.askPrice, symbol)}</span>}
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>H <span className="tabular-nums" style={{ color: "var(--text-secondary)" }}>{fmtPrice(ticker.high24h, symbol)}</span></span>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>L <span className="tabular-nums" style={{ color: "var(--text-secondary)" }}>{fmtPrice(ticker.low24h, symbol)}</span></span>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>Vol <span className="tabular-nums" style={{ color: "var(--text-secondary)" }}>{fmtVolume(ticker.volume24h)}</span></span>
      </>)}
      <div className="flex-1" />
      <div className="flex items-center gap-0.5">
        {TF.map((t) => (<button key={t} onClick={() => setTf(t)} className="px-2 py-0.5 text-[11px] font-medium rounded transition-colors"
          style={{ background: tf === t ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "transparent", color: tf === t ? "var(--accent)" : "var(--text-muted)" }}>{t}</button>))}
      </div>
    </div>
  );
}
