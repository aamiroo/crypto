import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useMarketStore, selectDepth, selectBestBid, selectBestAsk } from "../frontend/lib/store/marketStore.ts";
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
