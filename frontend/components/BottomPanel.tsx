"use client";
import { useState, useMemo } from "react";
import { useTradingStore } from "@/lib/store/tradingStore";
import { useMarketStore } from "@/lib/store/marketStore";
import { fmtPrice } from "@/lib/utils/format";
import { baseAsset } from "@/lib/utils/symbol";

type Tab = "orders"|"positions"|"history";

export function BottomPanel() {
  const [tab, setTab] = useState<Tab>("orders");
  const orders = useTradingStore((s) => s.orders.filter(o=>o.status==="open"));
  const filled = useTradingStore((s) => s.orders.filter(o=>o.status==="filled").slice(-20).reverse());
  const positions = useTradingStore((s) => s.positions);
  const balance = useTradingStore((s) => s.balance);
  const initialBalance = useTradingStore((s) => s.initialBalance);
  const cancelOrder = useTradingStore((s) => s.cancelOrder);
  const tickers = useMarketStore((s) => s.tickers);

  const totalUnrealized = useMemo(() => {
    let total = 0;
    for (const p of positions) {
      const last = parseFloat(tickers[p.symbol]?.lastPrice || "0");
      const entry = parseFloat(p.avgEntry);
      const qty = parseFloat(p.qty);
      if (p.side === "long") total += (last - entry) * qty;
      else total += (entry - last) * qty;
    }
    return total;
  }, [positions, tickers]);

  const realizedPnl = useMemo(() => {
    // simplified realized: not tracking round-trips, PnL = balance delta
    return balance - initialBalance;
  }, [balance, initialBalance]);

  return (
    <div className="flex h-full flex-col overflow-hidden text-[11px]">
      <div className="flex border-b" style={{borderColor:"var(--border)"}}>
        <button onClick={()=>setTab("orders")} className="px-3 py-1.5 text-[10px] font-medium" style={{borderBottom:tab==="orders"?"2px solid var(--accent)":"2px solid transparent",color:tab==="orders"?"var(--accent)":"var(--text-muted)"}}>Open Orders ({orders.length})</button>
        <button onClick={()=>setTab("positions")} className="px-3 py-1.5 text-[10px] font-medium" style={{borderBottom:tab==="positions"?"2px solid var(--accent)":"2px solid transparent",color:tab==="positions"?"var(--accent)":"var(--text-muted)"}}>Positions ({positions.length})</button>
        <button onClick={()=>setTab("history")} className="px-3 py-1.5 text-[10px] font-medium" style={{borderBottom:tab==="history"?"2px solid var(--accent)":"2px solid transparent",color:tab==="history"?"var(--accent)":"var(--text-muted)"}}>History ({filled.length})</button>
        <div className="flex-1"/>
        <div className="flex items-center gap-3 px-2 text-[10px] tabular-nums">
          <span style={{color:"var(--text-muted)"}}>Bal: <span style={{color:"var(--text-secondary)"}}>{balance.toLocaleString("en-US",{maximumFractionDigits:2})}</span></span>
          <span style={{color:"var(--text-muted)"}}>UPnL: <span style={{color:totalUnrealized>=0?"var(--success)":"var(--danger)"}}>{totalUnrealized>=0?"+":""}{totalUnrealized.toFixed(2)}</span></span>
          <span style={{color:"var(--text-muted)"}}>PnL: <span style={{color:realizedPnl>=0?"var(--success)":"var(--danger)"}}>{realizedPnl>=0?"+":""}{realizedPnl.toFixed(2)}</span></span>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {tab==="orders"&&(orders.length===0?(
          <div className="flex h-full items-center justify-center" style={{color:"var(--text-muted)"}}>No open orders</div>
        ):(orders.map(o=>(
          <div key={o.id} className="grid grid-cols-[60px_50px_50px_70px_70px_50px] gap-x-2 px-2 py-[2px]">
            <span style={{color:"var(--text-secondary)"}}>{baseAsset(o.symbol)}</span>
            <span style={{color:"var(--text-muted)"}}>{o.type}</span>
            <span style={{color:o.side==="buy"?"var(--success)":"var(--danger)"}}>{o.side}</span>
            <span className="tabular-nums" style={{color:"var(--text-secondary)"}}>{fmtPrice(o.price,o.symbol)}</span>
            <span className="tabular-nums" style={{color:"var(--text-muted)"}}>{o.qty}</span>
            <button onClick={()=>cancelOrder(o.id)} style={{color:"var(--danger)"}}>Cancel</button>
          </div>
        ))))}
        {tab==="positions"&&(positions.length===0?(
          <div className="flex h-full items-center justify-center" style={{color:"var(--text-muted)"}}>No positions</div>
        ):(positions.map(p=>{
          const last=parseFloat(tickers[p.symbol]?.lastPrice||"0");
          const entry=parseFloat(p.avgEntry);
          const qty=parseFloat(p.qty);
          const pnl=p.side==="long"?(last-entry)*qty:(entry-last)*qty;
          const pnlPct=entry>0?(pnl/(entry*qty))*100:0;
          return(<div key={p.symbol+p.side} className="grid grid-cols-[60px_50px_60px_70px_70px_50px] gap-x-2 px-2 py-[2px]">
            <span style={{color:"var(--text-secondary)"}}>{baseAsset(p.symbol)}</span>
            <span style={{color:p.side==="long"?"var(--success)":"var(--danger)"}}>{p.side}</span>
            <span className="tabular-nums" style={{color:"var(--text-muted)"}}>{qty}</span>
            <span className="tabular-nums" style={{color:"var(--text-secondary)"}}>{fmtPrice(p.avgEntry,p.symbol)}</span>
            <span className="tabular-nums" style={{color:pnl>=0?"var(--success)":"var(--danger)"}}>{pnl>=0?"+":""}{pnl.toFixed(2)} ({pnlPct>=0?"+":""}{pnlPct.toFixed(2)}%)</span>
            <span className="tabular-nums" style={{color:"var(--text-muted)"}}>{fmtPrice(last,p.symbol)}</span>
          </div>);
        })))}
        {tab==="history"&&(filled.length===0?(
          <div className="flex h-full items-center justify-center" style={{color:"var(--text-muted)"}}>No filled orders</div>
        ):(filled.map(o=>(
          <div key={o.id} className="grid grid-cols-[60px_50px_50px_70px_70px] gap-x-2 px-2 py-[2px]">
            <span style={{color:"var(--text-secondary)"}}>{baseAsset(o.symbol)}</span>
            <span style={{color:"var(--text-muted)"}}>{o.type}</span>
            <span style={{color:o.side==="buy"?"var(--success)":"var(--danger)"}}>{o.side}</span>
            <span className="tabular-nums" style={{color:"var(--text-secondary)"}}>{fmtPrice(o.filledPrice||o.price,o.symbol)}</span>
            <span className="tabular-nums" style={{color:"var(--text-muted)"}}>{o.qty}</span>
          </div>
        ))))}
      </div>
    </div>
  );
}
