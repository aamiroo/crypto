"use client";

import { useEffect } from "react";
import { useMarketStore } from "@/lib/store/marketStore";
import { useAlertsStore } from "@/lib/store/alertsStore";
import { toast } from "@/lib/store/toastStore";
import { fmtPrice } from "@/lib/utils/format";

/**
 * Evaluates client-side price alerts against live ticker updates.
 *
 * Uses a store subscription (rather than a component selector) so alert
 * evaluation never triggers React re-renders — it only looks at the tickers
 * sub-object and diffs it against the previous frame.
 */
export function useAlertEngine() {
  useEffect(() => {
    const unsub = useMarketStore.subscribe((state, prev) => {
      if (state.tickers === prev.tickers) return;
      const evaluate = useAlertsStore.getState().evaluate;
      for (const sym of Object.keys(state.tickers)) {
        const t = state.tickers[sym];
        if (!t || t === prev.tickers[sym]) continue;
        const price = parseFloat(t.lastPrice);
        if (!Number.isFinite(price)) continue;
        for (const fired of evaluate(sym, price)) {
          toast(
            "info",
            `Alert: ${sym} ${fired.condition === "above" ? "crossed above" : "dropped below"} ${fmtPrice(fired.price, sym)}`,
            6000,
          );
        }
      }
    });
    return unsub;
  }, []);
}
