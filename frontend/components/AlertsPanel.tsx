"use client";

import { useState } from "react";
import { useUiStore } from "@/lib/store/uiStore";
import { useAlertsStore, conditionLabel } from "@/lib/store/alertsStore";
import { useMarketStore } from "@/lib/store/marketStore";
import { fmtPrice, fmtTime } from "@/lib/utils/format";
import { baseAsset } from "@/lib/utils/symbol";
import { CloseIcon } from "@/components/icons/ToolIcons";
import type { AlertCondition } from "@/lib/types";

export function AlertsPanel() {
  const open = useUiStore((s) => s.alertsOpen);
  const setOpen = useUiStore((s) => s.setAlertsOpen);
  const symbol = useMarketStore((s) => s.symbol);
  const ticker = useMarketStore((s) => s.tickers[symbol]);
  const alerts = useAlertsStore((s) => s.alerts);
  const addAlert = useAlertsStore((s) => s.addAlert);
  const removeAlert = useAlertsStore((s) => s.removeAlert);
  const clearTriggered = useAlertsStore((s) => s.clearTriggered);

  const last = ticker ? parseFloat(ticker.lastPrice) : 0;
  const [condition, setCondition] = useState<AlertCondition>("above");
  const [price, setPrice] = useState("");

  if (!open) return null;

  const submit = () => {
    const p = price ? parseFloat(price) : last;
    if (!Number.isFinite(p) || p <= 0) return;
    addAlert({ symbol, condition, price: p });
    setPrice("");
  };

  const triggeredCount = alerts.filter((a) => a.triggeredAt).length;

  return (
    <div
      className="fixed inset-0 z-[150] flex items-start justify-end p-3 sm:items-center sm:justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Price alerts"
    >
      <div
        className="w-full max-w-sm rounded-xl border p-4"
        style={{ background: "var(--bg-elevated)", borderColor: "var(--border-strong)", boxShadow: "var(--shadow)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Price Alerts</h2>
          <button onClick={() => setOpen(false)} className="icon-btn h-6 w-6" aria-label="Close alerts"><CloseIcon size={13} /></button>
        </div>

        <div className="mb-3 rounded-lg p-2" style={{ background: "var(--bg-surface)" }}>
          <div className="mb-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
            New alert for <span style={{ color: "var(--text-secondary)" }}>{baseAsset(symbol)}/USDT</span>
            {last > 0 && <> · now <span className="tabular-nums" style={{ color: "var(--text-secondary)" }}>{fmtPrice(last, symbol)}</span></>}
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={condition}
              onChange={(e) => setCondition(e.target.value as AlertCondition)}
              className="h-7 rounded px-1.5 text-[11px] outline-none"
              style={{ background: "var(--bg-primary)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
            >
              <option value="above">Price ≥</option>
              <option value="below">Price ≤</option>
            </select>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder={last ? fmtPrice(last, symbol) : "0.00"}
              className="h-7 min-w-0 flex-1 rounded px-2 text-[11px] tabular-nums outline-none"
              style={{ background: "var(--bg-primary)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
            />
            <button
              onClick={submit}
              className="h-7 rounded px-2.5 text-[11px] font-semibold"
              style={{ background: "color-mix(in srgb, var(--accent) 18%, transparent)", color: "var(--accent)" }}
            >
              Add
            </button>
          </div>
        </div>

        <div className="max-h-72 overflow-y-auto">
          {alerts.length === 0 ? (
            <div className="py-6 text-center text-[11px]" style={{ color: "var(--text-muted)" }}>No alerts yet</div>
          ) : (
            alerts.map((a) => (
              <div key={a.id} className="flex items-center gap-2 border-b py-1.5 text-[11px] last:border-0" style={{ borderColor: "var(--border)" }}>
                <span className="w-12 font-medium" style={{ color: "var(--text-secondary)" }}>{baseAsset(a.symbol)}</span>
                <span style={{ color: a.triggeredAt ? "var(--warning)" : "var(--text-primary)" }}>{conditionLabel(a.condition)}</span>
                <span className="flex-1 tabular-nums" style={{ color: "var(--text-primary)" }}>{fmtPrice(a.price, a.symbol)}</span>
                {a.triggeredAt && (
                  <span className="text-[9px]" style={{ color: "var(--warning)" }} title={`Fired ${fmtTime(a.triggeredAt)}`}>fired</span>
                )}
                <button onClick={() => removeAlert(a.id)} className="icon-btn h-5 w-5" title="Remove alert" aria-label="Remove alert"><CloseIcon size={11} /></button>
              </div>
            ))
          )}
        </div>

        {triggeredCount > 0 && (
          <button
            onClick={clearTriggered}
            className="mt-2 w-full rounded py-1.5 text-[11px]"
            style={{ background: "var(--bg-surface)", color: "var(--text-secondary)" }}
          >
            Clear {triggeredCount} triggered
          </button>
        )}
        <p className="mt-2 text-[10px] leading-snug" style={{ color: "var(--text-muted)" }}>
          Alerts are evaluated locally against the live ticker feed while this tab is open.
        </p>
      </div>
    </div>
  );
}
