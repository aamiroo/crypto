// Frontend formatting/precision contract: instrument metadata drives decimals,
// and `change24h` is always a percentage (the gateway did the conversion).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useMarketStore, flushTickerBatchNow } from "../frontend/lib/store/marketStore.ts";
import { getPriceDecimals, getQtyDecimals, precisionFor, setInstruments } from "../frontend/lib/utils/symbol.ts";
import { fmtChange, fmtPct, fmtPrice, fmtQty } from "../frontend/lib/utils/format.ts";
import type { Envelope, InstrumentInfo } from "../frontend/lib/types.ts";

const INSTRUMENTS: InstrumentInfo[] = [
  { symbol: "BTCUSDT", baseCoin: "BTC", priceDecimals: 1, qtyDecimals: 6 },
  { symbol: "PEPEUSDT", baseCoin: "PEPE", priceDecimals: 8, qtyDecimals: 0 },
];

beforeEach(() => {
  setInstruments(INSTRUMENTS);
  useMarketStore.setState({ tickers: {}, symbols: [], connected: false });
});

const env = (type: string, symbol: string, data: unknown, ts = 1): Envelope =>
  ({ type, channel: "ticker", symbol, seq: 1, ts, data } as Envelope);

test("precision: instrument metadata replaces the old hand-kept map", () => {
  assert.equal(getPriceDecimals("BTCUSDT"), 1);
  assert.equal(getQtyDecimals("BTCUSDT"), 6);
  assert.equal(getPriceDecimals("pepeusdt"), 8, "lookup is case-insensitive");
  assert.deepEqual(precisionFor("UNKNOWNUSDT"), { priceDecimals: 4, qtyDecimals: 2 });
  assert.deepEqual(precisionFor(), { priceDecimals: 4, qtyDecimals: 2 });
});

test("precision: prices are rounded to the venue tick size, with grouping", () => {
  assert.equal(fmtPrice("83150.34", "BTCUSDT"), "83,150.3");
  assert.equal(fmtQty("0.5", "BTCUSDT"), "0.500000");
  assert.equal(fmtPrice("0.00001234", "PEPEUSDT"), "0.00001234");
  assert.equal(fmtPrice("not-a-price", "BTCUSDT"), "—");
});

test("percent: change24h is read as a percentage, never rescaled", () => {
  assert.equal(fmtPct("2.23"), "+2.23%");
  assert.equal(fmtPct("-0.5"), "-0.50%", "a genuine half-percent move must not become -50%");
  assert.equal(fmtPct(0), "+0.00%");
  assert.equal(fmtPct("garbage"), "0.00%");
  assert.equal(fmtChange("12.3456"), "+12.35");
  assert.equal(fmtChange(-3, 1), "-3.0");
});

test("symbols envelope installs precision and the tradeable list", () => {
  useMarketStore.getState().applyEnvelope({
    type: "symbols",
    ts: 1,
    data: { venue: "bybit", instruments: INSTRUMENTS },
  } as Envelope);
  assert.deepEqual(useMarketStore.getState().symbols, ["BTCUSDT", "PEPEUSDT"]);
  assert.equal(getPriceDecimals("BTCUSDT"), 1);

  setInstruments([{ symbol: "BTCUSDT", baseCoin: "BTC", priceDecimals: 2, qtyDecimals: 3 }]);
  assert.equal(getPriceDecimals("BTCUSDT"), 2);
  assert.equal(getPriceDecimals("PEPEUSDT"), 4, "a refreshed registry drops delisted pairs to the default");
});

test("ticker: a stream tick without bid/ask keeps the last known level", () => {
  const store = useMarketStore.getState();
  store.applyEnvelope(env("ticker", "BTCUSDT", {
    symbol: "BTCUSDT", lastPrice: "100", change24h: "1.5", bidPrice: "99", askPrice: "101", ts: 1,
  }));
  flushTickerBatchNow();
  assert.equal(useMarketStore.getState().tickers.BTCUSDT?.bidPrice, "99");

  // Bybit's spot stream carries no bid/ask: omitting them must not blank the book.
  useMarketStore.getState().applyEnvelope(env("ticker", "BTCUSDT", {
    symbol: "BTCUSDT", lastPrice: "102", change24h: "1.7", ts: 2,
  }));
  flushTickerBatchNow();
  const t = useMarketStore.getState().tickers.BTCUSDT!;
  assert.equal(t.lastPrice, "102");
  assert.equal(t.bidPrice, "99");
  assert.equal(t.askPrice, "101");
});
