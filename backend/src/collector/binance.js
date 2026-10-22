import { WebSocket } from "ws";
import { bus, subject } from "../bus.js";

const WS_BASE = "wss://stream.binance.com:9443/stream";
const REST_BASE = "https://api.binance.com";

export class BinanceCollector {
  /** No desired-state sets like the Bybit collector keeps: the subscription list is
   *  frozen into the stream URL once in `run`, so the only mutable field is the
   *  venue tag that prefixes every bus subject. */
  constructor(logger) {
    this.logger = logger;
    this.venue = "binance";
  }

  /** Seeds every book from REST *before* opening the socket: the depth stream
   *  pushes diffs only, so without a snapshot the hub has no book to apply them
   *  to. Reconnects forever with backoff capped at 30s. */
  async run(symbols) {
    const streams = this._buildStreams(symbols);
    const url = `${WS_BASE}?streams=${streams.join("/")}`;
    this.logger.info("binance collector starting", { symbols });
    for (const sym of symbols) {
      this._fetchDepthSnapshot(sym).catch((err) =>
        this.logger.error("binance depth snapshot failed", { symbol: sym, err: err.message })
      );
    }
    let backoff = 1000;
    while (true) {
      try {
        await this._runOnce(url);
        return;
      } catch (err) {
        this.logger.warn("binance ws disconnected", { err: err.message, backoff });
        await this._sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  /** The only source of a Binance book: `run` fires these off concurrently and
   *  deliberately ignores failures, so one delisted or throttled symbol must not
   *  stop the others (or the socket) from seeding. */
  async _fetchDepthSnapshot(symbol) {
    const resp = await fetch(`${REST_BASE}/api/v3/depth?symbol=${symbol}&limit=1000`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    bus.pub(subject(this.venue, symbol, "orderbook.snapshot"), {
      venue: this.venue, symbol,
      bids: data.bids.map(([p, s]) => [p, s]),
      asks: data.asks.map(([p, s]) => [p, s]),
      venueSeq: data.lastUpdateId, ts: Date.now(),
    });
    this.logger.info("binance depth snapshot emitted", { symbol, lastUpdateId: data.lastUpdateId });
  }

  /** One socket attempt whose promise settles by rejecting only — `run` reads that
   *  as the reconnect signal. `alive` discards frames still in flight when the
   *  socket is being torn down, after `cleanup` has already run. */
  _runOnce(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let alive = true;
      const cleanup = () => { alive = false; ws.removeAllListeners(); try { ws.close(); } catch {} };
      ws.on("open", () => this.logger.info("binance ws connected"));
      ws.on("message", (raw) => {
        if (!alive) return;
        try { this._handleMessage(JSON.parse(raw.toString())); }
        catch (err) { this.logger.error("binance parse error", { err: err.message }); }
      });
      ws.on("error", (err) => { cleanup(); reject(err); });
      ws.on("close", () => { cleanup(); reject(new Error("ws closed")); });
    });
  }

  /** Opens all four streams for every symbol up front — unlike Bybit there is no
   *  demand-driven resubscribe here. `@depth@100ms` is the fast diff speed; without
   *  the suffix the same stream would push roughly once a second. */
  _buildStreams(symbols) {
    const out = [];
    for (const s of symbols) {
      const sym = s.toLowerCase();
      out.push(`${sym}@depth@100ms`, `${sym}@trade`, `${sym}@kline_1m`, `${sym}@ticker`);
    }
    return out;
  }

  /** Combined-stream frames all arrive wrapped as `{ stream, data }`, so routing is
   *  on the stream suffix. Kline uses `includes` because its interval is part of the
   *  stream name; the others match exactly. */
  _handleMessage(msg) {
    const { stream, data } = msg;
    if (!stream || !data) return;
    if (stream.endsWith("@depth@100ms")) this._handleDepth(data);
    else if (stream.endsWith("@trade")) this._handleTrade(data);
    else if (stream.includes("@kline_")) this._handleKline(data);
    else if (stream.endsWith("@ticker")) this._handleTicker(data);
  }

  /** Always a delta — this stream never carries a snapshot, so these frames are
   *  meaningless until `run` has seeded the book over REST. A level of size "0"
   *  means "price gone" and is applied by the hub. */
  _handleDepth(data) {
    const symbol = (data.s || "").toUpperCase();
    bus.pub(subject(this.venue, symbol, "orderbook.delta"), {
      venue: this.venue, symbol,
      bids: data.b || [],
      asks: data.a || [],
      venueSeq: data.u || 0, ts: data.E || Date.now(),
    });
  }

  /** `m` is the maker flag, not the aggressor side: when the buyer was the maker
   *  the seller lifted the book, so `m === true` maps to "sell". */
  _handleTrade(data) {
    const symbol = (data.s || "").toUpperCase();
    bus.pub(subject(this.venue, symbol, "trades"), {
      venue: this.venue, symbol,
      id: `binance-${data.t}-${data.a}`,
      price: String(data.p ?? "0"), size: String(data.q ?? "0"),
      side: data.m ? "sell" : "buy", ts: data.T || Date.now(),
    });
  }

  /** Published on the fixed `kline.1m` subject because 1m is the only interval
   *  `_buildStreams` opens; `k.x` is an explicit close flag, so `closed` needs no
   *  deriving from the candle times. */
  _handleKline(data) {
    const k = data.k;
    if (!k) return;
    const symbol = (data.s || "").toUpperCase();
    bus.pub(subject(this.venue, symbol, "kline.1m"), {
      venue: this.venue, symbol, interval: k.i || "1m",
      openTime: k.t || 0, closeTime: k.T || 0,
      open: String(k.o ?? "0"), high: String(k.h ?? "0"),
      low: String(k.l ?? "0"), close: String(k.c ?? "0"),
      volume: String(k.v ?? "0"), closed: !!k.x,
    });
  }

  /** Deliberately not routed through `normalizeTicker`: Binance already reports `P`
   *  as a percentage, so the fraction-to-percent scaling there would multiply it a
   *  second time. This stream has no bid/ask, so those fields stay absent. */
  _handleTicker(data) {
    const symbol = (data.s || "").toUpperCase();
    bus.pub(subject(this.venue, symbol, "ticker"), {
      venue: this.venue, symbol,
      lastPrice: String(data.c ?? "0"),
      indexPrice: String(data.c ?? "0"), markPrice: String(data.c ?? "0"),
      change24h: String(data.P ?? "0"), high24h: String(data.h ?? "0"),
      low24h: String(data.l ?? "0"), volume24h: String(data.v ?? "0"),
      ts: data.E || Date.now(),
    });
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}
