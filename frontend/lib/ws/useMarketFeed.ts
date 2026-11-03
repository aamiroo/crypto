"use client";

import { useEffect, useRef, useCallback } from "react";
import { MarketWSClient } from "@/lib/ws/client";
import { useMarketStore, mostLiquid } from "@/lib/store/marketStore";
import { useChartStore } from "@/lib/store/chartStore";
import { toast } from "@/lib/store/toastStore";
import { loadHistoricalKlines, refreshRecentKlines } from "@/lib/api/klines";
import type { SymbolsData } from "@/lib/types";

const GATEWAY_WS_URL =
  process.env.NEXT_PUBLIC_GATEWAY_WS_URL ||
  (typeof window !== "undefined"
    ? `ws://${window.location.hostname}:8080/ws`
    : "ws://localhost:8080/ws");

/**
 * Single persistent WS connection + historical kline loader.
 * 1. Connects once on mount
 * 2. Subscribes tickers for ALL symbols
 * 3. On symbol/timeframe change: loads historical klines via REST, then subscribes live kline
 */
export function useMarketFeed() {
  const clientRef = useRef<MarketWSClient | null>(null);
  const symbolRef = useRef<string>("");
  const intervalRef = useRef<string>("");
  const tickerSubs = useRef<Set<string>>(new Set());
  /** Set when the socket drops, cleared by the history re-pull that follows the
   *  next connect — so a reconnect heals the gap exactly once. */
  const droppedRef = useRef(false);
  const applyEnvelope = useMarketStore((s) => s.applyEnvelope);
  const setConnected = useMarketStore((s) => s.setConnected);

  // ── Subscribe live kline for a symbol+interval ────────────────────────
  const subscribeLiveKline = useCallback((client: MarketWSClient, symbol: string, interval: string) => {
    client.subscribe({ channel: "kline", symbol, interval });
  }, []);

  const unsubscribeLiveKline = useCallback((client: MarketWSClient, symbol: string, interval: string) => {
    client.unsubscribe("kline", symbol, interval);
  }, []);

  const doSelectSymbol = useCallback((client: MarketWSClient, sym: string) => {
    const oldSym = symbolRef.current;
    symbolRef.current = sym;
    const iv = useChartStore.getState().timeframe;
    intervalRef.current = iv;

    // Unsubscribe old detail channels
    if (oldSym) {
      client.unsubscribe("orderbook", oldSym);
      client.unsubscribe("trades", oldSym);
      unsubscribeLiveKline(client, oldSym, iv);
    }

    client.selectSymbol(sym);
    // 50 is what the venue actually streams (Bybit's `orderbook.50` topic) and the
    // deepest the panel can show; asking for less would only make the book's own
    // depth control lie about how many levels it can fill.
    client.subscribe({ channel: "orderbook", symbol: sym, depth: 50 });
    client.subscribe({ channel: "trades", symbol: sym });
    subscribeLiveKline(client, sym, iv);

    // Fetch historical klines (validated + merged into the store)
    void loadHistoricalKlines(sym, iv);
  }, [subscribeLiveKline, unsubscribeLiveKline]);

  // ── WS connection lifecycle ───────────────────────────────────
  useEffect(() => {
    const client = new MarketWSClient(GATEWAY_WS_URL);
    clientRef.current = client;

    const unsubMessage = client.onMessage((env) => {
      applyEnvelope(env);

      if (env.type === "symbols") {
        const data = env.data as SymbolsData | undefined;
        const instruments = data?.instruments;
        if (!Array.isArray(instruments)) return;
        // One grouped subscribe frame: a per-symbol frame for every listed pair
        // meant hundreds of writes per connect.
        client.subscribeBatch(instruments.map((i) => ({ channel: "ticker" as const, symbol: i.symbol })));
        for (const i of instruments) tickerSubs.current.add(i.symbol);
        const current = useMarketStore.getState().symbol;
        const known = instruments.some((i) => i.symbol === current);
        if (!known && !symbolRef.current && instruments.length > 0) {
          // The stored pair is not on the venue's list (delisted, or a quote the
          // gateway does not collect). Pick the most traded pair rather than the
          // first row of the exchange's catalogue, and say so — a chart that
          // quietly changes symbol under the user is worse than a warning.
          const picked = mostLiquid(instruments.map((i) => i.symbol), useMarketStore.getState().tickers, 1)[0]!;
          useMarketStore.getState().setSymbol(picked);
          if (current) toast("warning", `${current} is not listed on ${data?.venue ?? "the venue"} — showing ${picked}`);
        }
      } else if (env.type === "error") {
        const e = env.data as { code?: string; message?: string } | undefined;
        if (e?.code) toast("warning", e.message || e.code);
      }
    });
    const unsubState = client.onStateChange((connected) => {
      setConnected(connected);
      // The hub only replays its ring buffer, so everything the venue published
      // while the socket was down is gone for good. Re-pull the recent window
      // after a dropout, otherwise the hole stays at the right-hand edge of the
      // chart forever. (The first connect needs no re-pull: the symbol and
      // timeframe effects below already do that load.)
      if (!connected) { droppedRef.current = true; return; }
      if (!droppedRef.current) return;
      droppedRef.current = false;
      void loadHistoricalKlines(useMarketStore.getState().symbol, useChartStore.getState().timeframe);
    });

    // A brand-new client carries no subscriptions. These refs survive it, because
    // React keeps the component instance across StrictMode's double-mount and
    // across Fast Refresh — and both re-run this effect with a fresh client.
    // Without the reset, the symbol/timeframe effects below compare against the
    // OLD client's selections and skip their work, so only the ticker batch is
    // ever sent: the order book, trades and the live candle stay on "Waiting…"
    // forever in `next dev`.
    symbolRef.current = "";
    intervalRef.current = "";

    client.connect();

    // A hidden tab throttles timers and socket handling without the client ever
    // seeing a drop, so the newest candle can silently stop advancing. Re-check
    // the tail on the way back (refreshRecentKlines no-ops when it is current).
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refreshRecentKlines(useMarketStore.getState().symbol, useChartStore.getState().timeframe);
    };
    document.addEventListener("visibilitychange", onVisible);

    const activeTickerSubs = tickerSubs.current;
    return () => {
      unsubMessage();
      unsubState();
      document.removeEventListener("visibilitychange", onVisible);
      client.disconnect();
      setConnected(false);
      activeTickerSubs.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Track symbol changes ──────────────────────────────────────
  const symbol = useMarketStore((s) => s.symbol);
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !symbol || symbol === symbolRef.current) return;
    doSelectSymbol(client, symbol);
  }, [symbol, doSelectSymbol]);

  // ── Track timeframe changes ───────────────────────────────────
  const timeframe = useChartStore((s) => s.timeframe);
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !symbol) return;
    if (timeframe === intervalRef.current) return;

    const oldIv = intervalRef.current;
    intervalRef.current = timeframe;

    // Unsubscribe old kline, subscribe new
    if (oldIv) unsubscribeLiveKline(client, symbol, oldIv);
    subscribeLiveKline(client, symbol, timeframe);

    // Fetch historical data for new interval
    void loadHistoricalKlines(symbol, timeframe);
  }, [timeframe, symbol, subscribeLiveKline, unsubscribeLiveKline]);
}

