"use client";
import { useRef, useEffect } from "react";
import { useMarketStore, selectBestBid, selectBestAsk } from "@/lib/store/marketStore";
import { useChartStore } from "@/lib/store/chartStore";
import { fmtPct, fmtPrice, fmtVolume } from "@/lib/utils/format";
import { baseAsset } from "@/lib/utils/symbol";
import { CoinIcon } from "@/components/CoinIcon";
import { TIMEFRAMES } from "@/lib/utils/klines";

export function MarketHeader({ symbol }: { symbol: string }) {
  const ticker = useMarketStore((s) => s.tickers[symbol]);
  // Bybit's ticker stream omits bid/ask, so read the top of the live book.
  const bestBid = useMarketStore((s) => selectBestBid(s, symbol));
  const bestAsk = useMarketStore((s) => selectBestAsk(s, symbol));
  const tf = useChartStore((s) => s.timeframe);
  const setTf = useChartStore((s) => s.setTimeframe);
  const prevPrice = useRef(parseFloat(ticker?.lastPrice || "0"));
  const flashRef = useRef<HTMLSpanElement>(null);

  const lastPrice = ticker?.lastPrice;
  useEffect(() => {
    if (!lastPrice) return;
    const cur = parseFloat(lastPrice);
    if (cur !== prevPrice.current && flashRef.current) {
      flashRef.current.classList.remove("flash-text-green", "flash-text-red");
      void flashRef.current.offsetWidth;
      flashRef.current.classList.add(cur > prevPrice.current ? "flash-text-green" : "flash-text-red");
    }
    prevPrice.current = cur;
  }, [lastPrice]);

  const change = ticker ? parseFloat(ticker.change24h) : 0;
  const up = change >= 0;
  const color = up ? "var(--success)" : "var(--danger)";

  return (
    <div className="no-select flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--bg-primary)" }}>
      <div className="flex items-center gap-2">
        <CoinIcon symbol={symbol} size="md" />
        <span className="text-[13px] font-bold tracking-wide" style={{ color: "var(--text-secondary)" }}>{baseAsset(symbol)}</span>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>/ USDT</span>
      </div>

      {ticker ? (
        <>
          {/* The last price is the one number a trader scans for, so it is by far
              the largest thing in the header; before, it was 16px against a 14px
              pair name and read as just another stat. */}
          <div className="flex items-baseline gap-2">
            <span ref={flashRef} className="text-[22px] font-bold leading-none tracking-tight tabular-nums" style={{ color }}>{fmtPrice(ticker.lastPrice, symbol)}</span>
            <span
              className="rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
              style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
            >
              {fmtPct(change)}
            </span>
          </div>
          <div className="hidden items-center gap-3 text-[11px] md:flex">
            <Stat label="24h High" value={fmtPrice(ticker.high24h, symbol)} />
            <Stat label="24h Low" value={fmtPrice(ticker.low24h, symbol)} />
            <Stat label="24h Vol" value={fmtVolume(ticker.volume24h)} />
            {ticker.turnover24h && <Stat label="Turnover" value={fmtVolume(ticker.turnover24h)} />}
            {bestBid != null && <Stat label="Bid" value={fmtPrice(bestBid, symbol)} valueColor="var(--success)" />}
            {bestAsk != null && <Stat label="Ask" value={fmtPrice(bestAsk, symbol)} valueColor="var(--danger)" />}
          </div>
        </>
      ) : (
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>waiting for market data…</span>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-0.5 overflow-x-auto">
        {TIMEFRAMES.map((t) => (
          <button
            key={t}
            onClick={() => setTf(t)}
            data-active={tf === t}
            className="seg-btn font-medium"
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <span className="flex items-baseline gap-1" style={{ color: "var(--text-muted)" }}>
      {label}
      <span className="tabular-nums" style={{ color: valueColor || "var(--text-secondary)" }}>{value}</span>
    </span>
  );
}
