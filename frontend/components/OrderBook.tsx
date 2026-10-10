"use client";
import { useMarketStore, selectDepth } from "@/lib/store/marketStore";
import { useMemo } from "react";
import { fmtPrice, fmtQty } from "@/lib/utils/format";
import { CoinIcon } from "@/components/CoinIcon";
export function OrderBook({ symbol }: { symbol: string }) {
  const bids = useMarketStore((s) => selectDepth(s, symbol, 20).bids);
  const asks = useMarketStore((s) => selectDepth(s, symbol, 20).asks);
  const ticker = useMarketStore((s) => s.tickers[symbol]);
  const lastPrice = ticker ? parseFloat(ticker.lastPrice) : 0;
  const maxT = useMemo(() => {
    let s=0,mb=0; for(const[,v]of bids){s+=parseFloat(v);mb=Math.max(mb,s);}
    s=0;let ma=0; for(const[,v]of asks){s+=parseFloat(v);ma=Math.max(ma,s);}
    return Math.max(mb,ma,1);
  }, [bids,asks]);
  return (
    <div className="flex h-full flex-col overflow-hidden text-[11px]">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider" style={{color:"var(--text-muted)"}}><CoinIcon symbol={symbol} size="xs" /> Order Book</div>
      <div className="grid grid-cols-[1fr_70px_60px] px-2 py-0.5" style={{color:"var(--text-muted)"}}><span>Price</span><span className="text-right">Size</span><span className="text-right">Total</span></div>
      <div className="flex-1 overflow-hidden flex flex-col justify-end">
        {[...asks].reverse().map(([p,s],i)=>{let t=0;for(let j=0;j<=i;j++){const r=asks[asks.length-1-j];if(r)t+=parseFloat(r[1]);}
          return(<div key={i} className="relative grid grid-cols-[1fr_70px_60px] px-2 py-[1px]">
            <div className="depth-bar absolute inset-y-0 right-0" style={{width:(t/maxT*100)+"%",background:"color-mix(in srgb, var(--danger) 10%, transparent)"}}/>
            <span className="relative tabular-nums" style={{color:"var(--danger)"}}>{fmtPrice(p,symbol)}</span>
            <span className="relative text-right tabular-nums" style={{color:"var(--text-muted)"}}>{fmtQty(s,symbol)}</span>
            <span className="relative text-right tabular-nums" style={{color:"var(--text-muted)"}}>{fmtQty(t,symbol)}</span>
          </div>);})}
      </div>
      <div className="flex items-center justify-center py-1 text-sm font-semibold tabular-nums" style={{background:"var(--bg-panel)"}}>
        {lastPrice>0?<span style={{color:"var(--text-primary)"}}>{fmtPrice(lastPrice,symbol)}</span>:<span style={{color:"var(--text-muted)"}}>\u2014</span>}
      </div>
      <div className="flex-1 overflow-hidden">
        {bids.map(([p,s],i)=>{let t=0;for(let j=0;j<=i;j++){const r=bids[j];if(r)t+=parseFloat(r[1]);}
          return(<div key={i} className="relative grid grid-cols-[1fr_70px_60px] px-2 py-[1px]">
            <div className="depth-bar absolute inset-y-0 right-0" style={{width:(t/maxT*100)+"%",background:"color-mix(in srgb, var(--success) 10%, transparent)"}}/>
            <span className="relative tabular-nums" style={{color:"var(--success)"}}>{fmtPrice(p,symbol)}</span>
            <span className="relative text-right tabular-nums" style={{color:"var(--text-muted)"}}>{fmtQty(s,symbol)}</span>
            <span className="relative text-right tabular-nums" style={{color:"var(--text-muted)"}}>{fmtQty(t,symbol)}</span>
          </div>);})}
      </div>
    </div>
  );
}
