"use client";
import { useState, useMemo } from "react";
import { useMarketStore } from "@/lib/store/marketStore";
import { useTradingStore } from "@/lib/store/tradingStore";
import { fmtPrice } from "@/lib/utils/format";
import { baseAsset, getQtyDecimals } from "@/lib/utils/symbol";
import { CoinIcon } from "@/components/CoinIcon";

export function TradingPanel({ symbol }: { symbol: string }) {
  const ticker = useMarketStore((s) => s.tickers[symbol]);
  const placeOrder = useTradingStore((s) => s.placeOrder);
  const balance = useTradingStore((s) => s.balance);
  const positions = useTradingStore((s) => s.positions);
  const [side, setSide] = useState<"buy"|"sell">("buy");
  const [ot, setOt] = useState<"limit"|"market">("market");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const lp = ticker ? parseFloat(ticker.lastPrice) : 0;

  const posQty = useMemo(() => {
    const p = positions.find((p) => p.symbol === symbol && p.side === "long");
    return p ? parseFloat(p.qty) : 0;
  }, [positions, symbol]);

  const submit = () => {
    const p = ot === "market" ? String(lp) : price;
    if (!p || !qty) return;
    const q = parseFloat(qty);
    const priceNum = parseFloat(p);
    if (q <= 0 || priceNum <= 0) return;
    if (side === "buy") {
      const cost = priceNum * q;
      if (cost > balance) return;
    } else {
      if (q > posQty) return;
    }
    placeOrder({ symbol, side, type: ot, price: p, qty, status: "open" });
    setQty("");
  };

  const usd = parseFloat(qty || "0") * parseFloat(price || String(lp));
  const pctButtons = side === "buy"
    ? ["25%", "50%", "75%", "100%"]
    : ["25%", "50%", "75%", "100%"];

  return (
    <div className="flex h-full flex-col overflow-hidden text-[11px]">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider" style={{color:"var(--text-muted)"}}><CoinIcon symbol={symbol} size="xs" /> Trade</div>
      <div className="px-2 pb-1"><span style={{color:"var(--text-muted)"}}>Balance: </span><span className="tabular-nums" style={{color:"var(--text-secondary)"}}>{balance.toLocaleString("en-US",{maximumFractionDigits:2})} USDT</span></div>
      {posQty > 0 && <div className="px-2 pb-1"><span style={{color:"var(--text-muted)"}}>Position: </span><span className="tabular-nums" style={{color:"var(--success)"}}>{posQty} {baseAsset(symbol)}</span></div>}
      <div className="mx-2 mb-2 grid grid-cols-2 gap-1">
        <button onClick={()=>setSide("buy")} className="rounded py-1.5 text-xs font-semibold" style={{background:side==="buy"?"var(--success)":"var(--bg-surface)",color:side==="buy"?"#fff":"var(--text-muted)"}}>Buy</button>
        <button onClick={()=>setSide("sell")} className="rounded py-1.5 text-xs font-semibold" style={{background:side==="sell"?"var(--danger)":"var(--bg-surface)",color:side==="sell"?"#fff":"var(--text-muted)"}}>Sell</button>
      </div>
      <div className="mx-2 mb-2 flex gap-1">
        {(["market","limit"] as const).map(t=>(<button key={t} onClick={()=>setOt(t)} className="flex-1 rounded py-1 text-[10px] font-medium" style={{background:ot===t?"var(--bg-hover)":"transparent",color:ot===t?"var(--text-primary)":"var(--text-muted)"}}>{t==="market"?"Market":"Limit"}</button>))}
      </div>
      {ot==="limit"&&<div className="mx-2 mb-1"><label className="mb-0.5 text-[10px]" style={{color:"var(--text-muted)"}}>Price</label><input type="number" value={price} onChange={e=>setPrice(e.target.value)} placeholder={lp?fmtPrice(lp,symbol):"0.00"} className="w-full rounded px-2 py-1.5 text-[11px] tabular-nums outline-none" style={{background:"var(--bg-surface)",color:"var(--text-primary)"}}/></div>}
      <div className="mx-2 mb-1"><label className="mb-0.5 text-[10px]" style={{color:"var(--text-muted)"}}>Qty</label><input type="number" value={qty} onChange={e=>setQty(e.target.value)} placeholder="0.00" className="w-full rounded px-2 py-1.5 text-[11px] tabular-nums outline-none" style={{background:"var(--bg-surface)",color:"var(--text-primary)"}}/></div>
      <div className="mx-2 mb-2 flex gap-1">{pctButtons.map(p=>(<button key={p} onClick={()=>{const pr=parseFloat(price||String(lp));if(pr>0){if(side==="buy"){setQty(((balance*(parseInt(p)/100))/pr).toFixed(getQtyDecimals(symbol)));}else{setQty((posQty*(parseInt(p)/100)).toFixed(getQtyDecimals(symbol)));}}}} className="flex-1 rounded py-0.5 text-[9px]" style={{background:"var(--bg-surface)",color:"var(--text-muted)"}}>{p}</button>))}</div>
      <div className="mx-2 mb-2 text-[10px]" style={{color:"var(--text-muted)"}}>~ {usd.toLocaleString("en-US",{maximumFractionDigits:2})} USDT</div>
      <div className="px-2 mt-auto pb-2"><button onClick={submit} className="w-full rounded py-2 text-xs font-bold text-white" style={{background:side==="buy"?"var(--success)":"var(--danger)"}}>{side==="buy"?"Buy":"Sell"} {baseAsset(symbol)}</button></div>
    </div>
  );
}
