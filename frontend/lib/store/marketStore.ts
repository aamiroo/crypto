import { create } from "zustand";
import type {
  Envelope, KlineData, OrderBookDeltaData, OrderBookSnapshotData, PriceLevel,
  SymbolsData, TickerData, TradeData,
} from "@/lib/types";
import { EMPTY_KLINES, MAX_KLINES, klineKey, mergeKlines, mergeRawKline } from "@/lib/utils/klines";
import type { CandlePrecedence } from "@/lib/utils/klines";
import { setInstruments } from "@/lib/utils/symbol";

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
  /** Wall-clock ms of the last inbound message (any channel) — drives stale UI. */
  lastMessageTs: number;

  setSymbol: (s: string) => void;
  setConnected: (c: boolean) => void;
  setKlineStatus: (symbol: string, interval: string, state: KlineState, error?: string) => void;
  mergeKlinesInto: (symbol: string, interval: string, incoming: KlineData[], restTickCursor?: number) => void;
  applyEnvelope: (env: Envelope) => void;
}

const MAX_TRADES = 100;
const TICKER_BATCH_MS = 250;
const MESSAGE_TS_STEP_MS = 1000;

/** Per window: the newest candle the websocket wrote, and which tick wrote it.
 *  Kept outside the store — it is bookkeeping for merge precedence, not
 *  something a component renders, and a per-tick `set()` for it would notify
 *  subscribers twice. */
const liveTick = new Map<string, { openTime: number; seq: number }>();
/** Counts live candles as they are applied. A REST page is tagged with the count
 *  read when the request was issued, so "newer" is an exact ordering instead of a
 *  millisecond clock comparison — two events in the same millisecond would
 *  otherwise decide the winner by luck. */
let tickSeq = 0;
export function klineTickCursor(): number { return tickSeq; }

/** Which version of a colliding candle wins when a REST page lands on top of
 *  live data. A REST page is a snapshot of the venue taken when the request was
 *  issued, so it cannot know about a tick that arrived after that: for the candle
 *  the stream touched, the stream version is the truth. A finalized bar also
 *  beats the same bar as "still forming", which is what the page carries when the
 *  bar closed in the meantime. Without this the chart's last candle jumps
 *  backwards every time a slow page resolves over a fast stream. */
function restPrecedence(key: string, issuedAtCursor: number): CandlePrecedence {
  const live = liveTick.get(key);
  return (stored, incoming) =>
    (stored.closed && !incoming.closed) ||
    (!!live && live.openTime === stored.openTime && live.seq > issuedAtCursor);
}

/** Only a plausible exchange pair is trusted from the cache: a garbage symbol
 *  makes every subscribe and REST call fail, which looks like a dead terminal. */
function readStoredSymbol(): string {
  if (typeof window === "undefined") return "BTCUSDT";
  const v = localStorage.getItem("ct_sym");
  return v && /^[A-Z0-9]{3,20}$/.test(v) ? v : "BTCUSDT";
}

export const useMarketStore = create<MarketState>((set, get) => ({
  symbol: readStoredSymbol(),
  symbols: [],
  orderBooks: {},
  recentTrades: {},
  klines: {},
  klineStatus: {},
  tickers: {},
  connected: false,
  lastMessageTs: 0,

  setSymbol: (symbol) => { if (typeof window !== "undefined") localStorage.setItem("ct_sym", symbol); set({ symbol }); },
  setConnected: (connected) => set({ connected }),

  setKlineStatus: (symbol, interval, state, error) =>
    set((st) => ({ klineStatus: { ...st.klineStatus, [klineKey(symbol, interval)]: { state, error } } })),

  mergeKlinesInto: (symbol, interval, incoming, restTickCursor) =>
    set((st) => {
      if (incoming.length === 0) return {};
      const byIv = st.klines[symbol] ?? {};
      const cur = byIv[interval] ?? EMPTY_KLINES;
      // Only a REST page carries the precedence question; a bulk merge from the
      // stream (replay after a reconnect) is the newer source and simply wins.
      const next = mergeKlines(cur, incoming,
        restTickCursor === undefined ? undefined : restPrecedence(klineKey(symbol, interval), restTickCursor));
      if (next === cur) return {};
      return { klines: { ...st.klines, [symbol]: { ...byIv, [interval]: next } } };
    }),

  applyEnvelope: (env) => {
    // Any inbound frame (incl. pong) proves the socket is alive. Coarsened: a
    // per-frame timestamp would notify every subscriber several times a second.
    if (Date.now() - get().lastMessageTs >= MESSAGE_TS_STEP_MS) set({ lastMessageTs: Date.now() });

    if (env.type === "symbols") {
      const data = env.data as SymbolsData | undefined;
      const instruments = data?.instruments;
      if (Array.isArray(instruments)) {
        setInstruments(instruments);
        set({ symbols: instruments.map((i) => i.symbol) });
      }
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
        const tickTime = Number(raw?.openTime);
        // Counted even when the frame changes nothing: it is still the stream
        // saying it owns this candle, which is what a later REST page defers to.
        if (Number.isFinite(tickTime) && tickTime > 0) {
          liveTick.set(klineKey(sym, interval), { openTime: tickTime, seq: ++tickSeq });
        }
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
        // One commit per batch: hundreds of symbols tick continuously, and each
        // commit copies the whole ticker map and notifies every subscriber.
        queueTicker(sym, env.data as TickerData);
        break;
      }
    }
  },
}));

let tickerBatch = new Map<string, TickerData>();
let tickerFlushTimer: ReturnType<typeof setTimeout> | null = null;

/** Merges every queued ticker into ONE store update. Hundreds of symbols tick
 *  several times per second, and a `set` per message would re-render the whole
 *  watchlist that often instead of once per batch window. */
function flushTickerBatch() {
  tickerFlushTimer = null;
  if (tickerBatch.size === 0) return;
  const batch = Object.fromEntries(tickerBatch);
  tickerBatch = new Map();
  useMarketStore.setState((st) => ({ tickers: { ...st.tickers, ...batch } }));
}

/** Buffer a ticker until the next flush. Only the newest value per symbol
 *  matters, so intermediate frames are dropped on purpose. */
function queueTicker(sym: string, data: TickerData) {
  if (!data) return;
  // The venue's streaming ticker carries no best bid/ask (only the REST
  // snapshot does), so keep the last known level instead of blanking it out.
  const prev = tickerBatch.get(sym) ?? useMarketStore.getState().tickers[sym];
  const next = prev && data.bidPrice === undefined && prev.bidPrice !== undefined
    ? { ...data, bidPrice: prev.bidPrice, askPrice: prev.askPrice }
    : data;
  tickerBatch.set(sym, next);
  if (tickerFlushTimer) return;
  tickerFlushTimer = setTimeout(flushTickerBatch, TICKER_BATCH_MS);
}

/** Test hook: apply pending ticker updates synchronously. */
export function flushTickerBatchNow() {
  if (tickerFlushTimer) clearTimeout(tickerFlushTimer);
  flushTickerBatch();
}

/** Merge side levels into the book map. Size 0 deletes the price — that is how
 *  a delta says a level is gone; storing it would show a phantom in the depth. */
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

/**
 * Sorted top-N bids/asks.
 * The result is memoized per book object, so a component can select it without
 * producing a fresh array (and an infinite re-render loop) on every store
 * notification.
 */
const EMPTY_DEPTH: DepthView = { bids: [], asks: [], totalBidQty: 0, totalAskQty: 0 };
export interface DepthView {
  bids: PriceLevel[];
  asks: PriceLevel[];
  totalBidQty: number;
  totalAskQty: number;
}
const depthCache = new WeakMap<OrderBookState, Map<number, DepthView>>();

/** Two-level cache keyed on book identity then depth. Every delta installs a
 *  new book object, so the WeakMap entry drops itself — no manual invalidation,
 *  and different depths never recompute the same sort. */
export function selectDepth(state: MarketState, symbol: string, depth = 25): DepthView {
  const book = state.orderBooks[symbol];
  if (!book) return EMPTY_DEPTH;
  let perDepth = depthCache.get(book);
  if (!perDepth) {
    perDepth = new Map();
    depthCache.set(book, perDepth);
  }
  const hit = perDepth.get(depth);
  if (hit) return hit;
  const bids = sortLevels(book.bids, -1).slice(0, depth);
  const asks = sortLevels(book.asks, 1).slice(0, depth);
  const view: DepthView = {
    bids,
    asks,
    totalBidQty: sumQty(book.bids),
    totalAskQty: sumQty(book.asks),
  };
  perDepth.set(depth, view);
  return view;
}

/** Prices stay strings (venue precision is lossy as a float); `dir` is -1 for
 *  bids (best = highest first) and +1 for asks (best = lowest first). */
function sortLevels(levels: Map<string, string>, dir: 1 | -1): PriceLevel[] {
  const out: PriceLevel[] = [];
  for (const [price, size] of levels) out.push([price, size]);
  out.sort((a, b) => (parseFloat(a[0]) - parseFloat(b[0])) * dir);
  return out;
}

/** Sums every level, not just the cached top-`depth` slice, so DepthView's
 *  totalBid/AskQty reflect whole-book pressure. `|| 0` skips a bad size. */
function sumQty(levels: Map<string, string>): number {
  let total = 0;
  for (const size of levels.values()) total += parseFloat(size) || 0;
  return total;
}

/** Best (highest) bid price from the live book, or null when empty. */
export function selectBestBid(state: MarketState, symbol: string): number | null {
  const top = selectDepth(state, symbol, 1).bids[0];
  return top ? parseFloat(top[0]) : null;
}

/** Best (lowest) ask price from the live book, or null when empty. */
export function selectBestAsk(state: MarketState, symbol: string): number | null {
  const top = selectDepth(state, symbol, 1).asks[0];
  return top ? parseFloat(top[0]) : null;
}

