import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useMarketStore, selectDepth, selectBestBid, selectBestAsk, mostLiquid, topLiquid } from "../frontend/lib/store/marketStore.ts";
import type { Envelope } from "../frontend/lib/types.ts";

function reset() {
  useMarketStore.setState({
    symbols: [], orderBooks: {}, recentTrades: {}, klines: {},
    klineStatus: {}, tickers: {}, connected: false, lastMessageTs: 0,
  });
}

beforeEach(reset);

const snapshot = (sym: string, bids: [string, string][], asks: [string, string][]): Envelope =>
  ({ type: "orderbook_snapshot", channel: "orderbook", symbol: sym, seq: 1, ts: 1, data: { bids, asks } } as Envelope);

test("order book snapshot populates depth sorted best-first", () => {
  useMarketStore.getState().applyEnvelope(snapshot("BTCUSDT", [["100", "1"], ["101", "2"], ["99", "3"]], [["103", "1"], ["102", "2"]]));
  const { bids, asks } = selectDepth(useMarketStore.getState(), "BTCUSDT", 25);
  assert.deepEqual(bids.map((b) => b[0]), ["101", "100", "99"]);
  assert.deepEqual(asks.map((a) => a[0]), ["102", "103"]);
});

test("best bid/ask come from the live book (not the ticker)", () => {
  useMarketStore.getState().applyEnvelope(snapshot("BTCUSDT", [["99", "1"], ["100.5", "1"]], [["102", "1"], ["101.5", "1"]]));
  const s = useMarketStore.getState();
  assert.equal(selectBestBid(s, "BTCUSDT"), 100.5);
  assert.equal(selectBestAsk(s, "BTCUSDT"), 101.5);
});

test("best bid/ask are null for an unknown or empty book", () => {
  const s = useMarketStore.getState();
  assert.equal(selectBestBid(s, "NOPEUSDT"), null);
  assert.equal(selectBestAsk(s, "NOPEUSDT"), null);
});

test("order book delta applies updates and removes zero-size levels", () => {
  const apply = useMarketStore.getState().applyEnvelope;
  apply(snapshot("BTCUSDT", [["100", "1"], ["101", "2"]], [["102", "2"]]));
  apply({ type: "orderbook_delta", channel: "orderbook", symbol: "BTCUSDT", seq: 2, ts: 2, data: { bids: [["100", "0"], ["100.5", "5"]], asks: [] } } as Envelope);
  const { bids } = selectDepth(useMarketStore.getState(), "BTCUSDT", 25);
  assert.deepEqual(bids, [["101", "2"], ["100.5", "5"]]);
  assert.equal(selectBestBid(useMarketStore.getState(), "BTCUSDT"), 101);
});

test("trades prepend newest-first and are capped", () => {
  const apply = useMarketStore.getState().applyEnvelope;
  for (let i = 0; i < 105; i++) {
    apply({ type: "trade", channel: "trades", symbol: "BTCUSDT", seq: i + 1, ts: i + 1, data: { price: String(i), size: "1", side: "buy" } } as Envelope);
  }
  const list = useMarketStore.getState().recentTrades["BTCUSDT"]!;
  assert.equal(list.length, 100);
  assert.equal(list[0]!.price, "104");
});

// ── liquidity ranking ───────────────────────────────────────────────────

/** A ticker with a given quote turnover, and a base volume deliberately the
 *  other way round: the test has to show which of the two the ranking reads. */
const priced = (turnover24h: string, volume24h: string) => ({
  lastPrice: "1", change24h: "0", high24h: "1", low24h: "1", volume24h, turnover24h,
});

test("mostLiquid ranks by quote turnover, not by base volume or listing order", () => {
  const symbols = ["BTCUSDT", "MEMEUSDT", "ETHUSDT"];
  const tickers = {
    // 3 BTC traded 100k of quote; 1.2M MEME coins traded 10k. Only the quote
    // comparison means anything across pairs of that size.
    BTCUSDT: priced("100000", "3"),
    MEMEUSDT: priced("10000", "1200000"),
    ETHUSDT: priced("50000", "400"),
  };
  assert.deepEqual(mostLiquid(symbols, tickers, 3), ["BTCUSDT", "ETHUSDT", "MEMEUSDT"]);
  assert.deepEqual(
    mostLiquid(["NEWUSDT", ...symbols], tickers, 3),
    ["BTCUSDT", "ETHUSDT", "MEMEUSDT"],
    "a pair the feed has not priced yet cannot outrank a market it has",
  );
});

test("topLiquid holds the ranking while the feed keeps ticking", () => {
  const symbols = ["BTCUSDT", "ETHUSDT"];
  const first = topLiquid(symbols, { BTCUSDT: priced("100", "1"), ETHUSDT: priced("200", "1") }, 2);
  assert.deepEqual(first, ["ETHUSDT", "BTCUSDT"]);
  // Same pairs priced, same symbol set, new values: the array a component memoises
  // on must not change identity, or the default list reorders under the pointer.
  const second = topLiquid(symbols, { BTCUSDT: priced("900", "1"), ETHUSDT: priced("30", "1") }, 2);
  assert.equal(second, first, "a ticker flush is not a change of market");
  // A pair the feed has only now reached changes the set, so the order may move.
  const third = topLiquid(symbols, { BTCUSDT: priced("900", "1"), ETHUSDT: priced("30", "1"), SOLUSDT: priced("9", "1") }, 2);
  assert.notEqual(third, first);
});
