import { create } from "zustand";
import type {
  Envelope, KlineData, OrderBookDeltaData, OrderBookSnapshotData,
  TickerData, TradeData,
} from "@/lib/types";
import { EMPTY_KLINES, MAX_KLINES, klineKey, mergeKlines, mergeRawKline } from "@/lib/utils/klines";

/** Orderbook stored as maps for O(1) delta apply */
interface OrderBookState { bids: Map<string, string>; asks: Map<string, string>; }

export type KlineState = "idle" | "loading" | "ready" | "error";
export interface KlineStatus { state: KlineState; error?: string; }

interface MarketState {
  symbol: string;
  symbols: string[];
  orderBooks: Record<string, OrderBookState>;
  recentTrades: Record<string, TradeData[]>;
  klines: Record<string, Record<string, KlineData[]>>;  // symbol -> interval -> klines
  klineStatus: Record<string, KlineStatus>;             // `${symbol}:${interval}` -> status
  tickers: Record<string, TickerData>;
  connected: boolean;

  setSymbol: (s: string) => void;
  setConnected: (c: boolean) => void;
  setKlineStatus: (symbol: string, interval: string, state: KlineState, error?: string) => void;
  mergeKlinesInto: (symbol: string, interval: string, incoming: KlineData[]) => void;
  applyEnvelope: (env: Envelope) => void;
}

const MAX_TRADES = 100;

export const useMarketStore = create<MarketState>((set, get) => ({
  symbol: typeof window !== "undefined" ? (localStorage.getItem("ct_sym") || "BTCUSDT") : "BTCUSDT",
  symbols: [],
  orderBooks: {},
  recentTrades: {},
  klines: {},
  klineStatus: {},
  tickers: {},
  connected: false,

  setSymbol: (symbol) => { if (typeof window !== "undefined") localStorage.setItem("ct_sym", symbol); set({ symbol }); },
  setConnected: (connected) => set({ connected }),

  setKlineStatus: (symbol, interval, state, error) =>
    set((st) => ({ klineStatus: { ...st.klineStatus, [klineKey(symbol, interval)]: { state, error } } })),

  mergeKlinesInto: (symbol, interval, incoming) =>
    set((st) => {
      if (incoming.length === 0) return {};
      const byIv = st.klines[symbol] ?? {};
      const cur = byIv[interval] ?? EMPTY_KLINES;
      const next = mergeKlines(cur, incoming);
      if (next === cur) return {};
      return { klines: { ...st.klines, [symbol]: { ...byIv, [interval]: next } } };
    }),

  applyEnvelope: (env) => {
    if (env.type === "symbols") {
      const d = env as unknown as { data: string[] };
      if (Array.isArray(d.data)) set({ symbols: d.data });
      return;
    }

    if (!env.symbol) return;
    const sym = env.symbol;

    switch (env.type) {
      case "orderbook_snapshot": {
        const data = env.data as OrderBookSnapshotData;
        const bids = new Map(data.bids.map(([p, s]) => [p, s]));
        const asks = new Map(data.asks.map(([p, s]) => [p, s]));
        set((st) => ({ orderBooks: { ...st.orderBooks, [sym]: { bids, asks } } }));
        break;
      }
      case "orderbook_delta": {
        const data = env.data as OrderBookDeltaData;
        const book = get().orderBooks[sym];
        if (!book) return;
        const bids = new Map(book.bids);
        const asks = new Map(book.asks);
        applyLevels(bids, data.bids);
        applyLevels(asks, data.asks);
        set((st) => ({ orderBooks: { ...st.orderBooks, [sym]: { bids, asks } } }));
        break;
      }
      case "trade": {
        const data = env.data as TradeData;
        const trade = { ...data, ts: env.ts };
        set((st) => {
          const list = [trade, ...(st.recentTrades[sym] ?? [])].slice(0, MAX_TRADES);
          return { recentTrades: { ...st.recentTrades, [sym]: list } };
        });
        break;
      }
      case "kline": {
        const raw = env.data as KlineData;
        const interval = raw?.interval || "1m";
        set((st) => {
          const byIv = st.klines[sym] ?? {};
          const cur = byIv[interval] ?? EMPTY_KLINES;
          // Sorted merge: replaces the forming candle, appends new ones and
          // tolerates replayed/out-of-order messages without duplicating bars.
          const next = mergeRawKline(cur, raw, interval);
          if (next === cur) return {};
          const capped = next.length > MAX_KLINES ? next.slice(next.length - MAX_KLINES) : next;
          return { klines: { ...st.klines, [sym]: { ...byIv, [interval]: capped } } };
        });
        break;
      }
      case "ticker": {
        const data = env.data as TickerData;
        set((st) => ({ tickers: { ...st.tickers, [sym]: data } }));
        break;
      }
    }
  },
}));

function applyLevels(target: Map<string, string>, levels: [string, string][]) {
  for (const [price, size] of levels) {
    if (parseFloat(size) === 0) target.delete(price);
    else target.set(price, size);
  }
}

/**
 * Get klines for a specific symbol and interval.
 * Returns a stable EMPTY_KLINES reference when absent so selectors don't
 * produce a new array (and a re-render) on every unrelated store update.
 */
export function selectKlines(state: MarketState, symbol: string, interval: string): KlineData[] {
  return state.klines[symbol]?.[interval] ?? EMPTY_KLINES;
}

/** Sorted top-N bids/asks */
export function selectDepth(state: MarketState, symbol: string, depth = 25) {
  const book = state.orderBooks[symbol];
  if (!book) return { bids: [] as [string, string][], asks: [] as [string, string][] };
  const bids = [...book.bids.entries()]
    .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
    .slice(0, depth);
  const asks = [...book.asks.entries()]
    .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
    .slice(0, depth);
  return { bids, asks };
}

