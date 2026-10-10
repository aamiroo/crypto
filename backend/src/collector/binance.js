import { WebSocket } from "ws";
import { bus, subject } from "../bus.js";

const WS_BASE = "wss://stream.binance.com:9443/stream";
const REST_BASE = "https://api.binance.com";

export class BinanceCollector {
  constructor(logger) {
    this.logger = logger;
    this.venue = "binance";
  }

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

  _buildStreams(symbols) {
    const out = [];
    for (const s of symbols) {
      const sym = s.toLowerCase();
      out.push(`${sym}@depth@100ms`, `${sym}@trade`, `${sym}@kline_1m`, `${sym}@ticker`);
    }
    return out;
  }

  _handleMessage(msg) {
    const { stream, data } = msg;
    if (!stream || !data) return;
    if (stream.endsWith("@depth@100ms")) this._handleDepth(data);
    else if (stream.endsWith("@trade")) this._handleTrade(data);
    else if (stream.includes("@kline_")) this._handleKline(data);
    else if (stream.endsWith("@ticker")) this._handleTicker(data);
  }

  _handleDepth(data) {
    const symbol = (data.s || "").toUpperCase();
    bus.pub(subject(this.venue, symbol, "orderbook.delta"), {
      venue: this.venue, symbol,
      bids: data.b || [],
      asks: data.a || [],
      venueSeq: data.u || 0, ts: data.E || Date.now(),
    });
  }

  _handleTrade(data) {
    const symbol = (data.s || "").toUpperCase();
    bus.pub(subject(this.venue, symbol, "trades"), {
      venue: this.venue, symbol,
      id: `binance-${data.t}-${data.a}`,
      price: String(data.p ?? "0"), size: String(data.q ?? "0"),
      side: data.m ? "sell" : "buy", ts: data.T || Date.now(),
    });
  }

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
