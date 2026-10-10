import { WebSocket } from "ws";
import { bus, subject } from "../bus.js";

const WS_URL = "wss://stream.bybit.com/v5/public/spot";
const BATCH_SIZE = 10; // Bybit spot WS limit: 10 topics per subscribe message
const APP_TO_BYBIT = {
  "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
  "1h": "60", "4h": "240", "1d": "D", "1w": "W",
};
const BYBIT_TO_APP = {};
for (const [k, v] of Object.entries(APP_TO_BYBIT)) BYBIT_TO_APP[v] = k;

export class BybitCollector {
  constructor(logger) {
    this.logger = logger;
    this.venue = "bybit";
    this._ws = null;
    this._alive = false;
    this._tickerSymbols = new Set();
    this._detailSymbols = new Set();    // symbols with orderbook+trade
    this._detailKlines = new Set();     // "SYMBOL|bybitIv" pairs
    this._backoff = 1000;
  }

  /** Start with ticker symbols for ALL pairs (lightweight). */
  async run(tickerSymbols) {
    this._tickerSymbols = new Set(tickerSymbols);
    this.logger.info("bybit collector starting", { tickers: tickerSymbols.length });
    while (true) {
      try {
        await this._runOnce();
        return;
      } catch (err) {
        this.logger.warn("bybit ws disconnected", { err: err.message });
        await this._sleep(this._backoff);
        this._backoff = Math.min(this._backoff * 2, 30000);
      }
    }
  }

  /** Diff-based sync of detail channels. The gateway owns the desired state
   *  (symbols for orderbook/trade, plus exact symbol+interval kline pairs);
   *  this only computes the Bybit topic delta. */
  sync(symbols, klinePairs) {
    const wantSym = new Set(symbols.map((s) => s.toUpperCase()));
    const wantK = new Set(klinePairs.map(([s, iv]) => `${s.toUpperCase()}|${APP_TO_BYBIT[iv] || "1"}`));
    const before = this._topics(this._detailSymbols, this._detailKlines);
    const after = this._topics(wantSym, wantK);
    const sub = [...after].filter((t) => !before.has(t));
    const unsub = [...before].filter((t) => !after.has(t));
    if (sub.length === 0 && unsub.length === 0) return;

    this._detailSymbols = wantSym;
    this._detailKlines = wantK;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      if (unsub.length) this._sendBatched(unsub, "unsubscribe");
      if (sub.length) this._sendBatched(sub, "subscribe");
    }
    this.logger.info("detail synced", { symbols: wantSym.size, klines: wantK.size });
  }

  _topics(symbols, klines) {
    const out = new Set();
    for (const s of symbols) {
      out.add(`orderbook.50.${s}`);
      out.add(`publicTrade.${s}`);
    }
    for (const p of klines) {
      const i = p.indexOf("|");
      out.add(`kline.${p.slice(i + 1)}.${p.slice(0, i)}`);
    }
    return out;
  }

  _sendBatched(args, op) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < args.length; i += BATCH_SIZE) {
      try { this._ws.send(JSON.stringify({ op, args: args.slice(i, i + BATCH_SIZE) })); } catch {}
    }
  }

  _runOnce() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn) => { if (!settled) { settled = true; fn(); } };
      const ws = new WebSocket(WS_URL);
      this._ws = ws;
      this._alive = true;
      let pingTimer = null;
      const cleanup = () => {
        this._alive = false;
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        ws.removeAllListeners();
        try { ws.close(); } catch {}
      };

      ws.on("open", () => {
        this._backoff = 1000;
        this.logger.info("bybit ws connected", { tickers: this._tickerSymbols.size, detail: this._detailSymbols.size });
        // Subscribe tickers for ALL symbols
        this._sendBatched([...this._tickerSymbols].map((s) => `tickers.${s}`), "subscribe");
        // Re-subscribe detail channels on reconnect
        if (this._detailSymbols.size > 0 || this._detailKlines.size > 0) {
          this._sendBatched([...this._topics(this._detailSymbols, this._detailKlines)], "subscribe");
        }
        // Keep-alive: send WS-level pings every 15s to prevent Bybit idle disconnect
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) { try { ws.ping(); } catch {} }
        }, 15000);
      });

      ws.on("message", (raw) => {
        if (!this._alive) return;
        try {
          const msg = JSON.parse(raw.toString());
          // Respond to Bybit application-level pings
          if (msg.op === "ping") {
            try { ws.send(JSON.stringify({ op: "pong", req_id: msg.req_id })); } catch {}
            return;
          }
          if (msg.op === "subscribe" || msg.op === "unsubscribe" || msg.success !== undefined) return;
          this._handleMessage(msg);
        } catch (err) {
          this.logger.error("bybit parse error", { err: err.message });
        }
      });

      ws.on("error", (err) => { cleanup(); settle(() => reject(err)); });
      ws.on("close", () => { cleanup(); settle(() => reject(new Error("ws closed"))); });
    });
  }

  _handleMessage(msg) {
    const topic = msg.topic || "";
    if (!topic || !msg.data) return;

    if (topic.startsWith("orderbook.")) this._handleOrderbook(msg);
    else if (topic.startsWith("publicTrade.")) this._handleTrade(msg);
    else if (topic.startsWith("kline.")) this._handleKline(msg);
    else if (topic.startsWith("tickers.")) this._handleTicker(msg);
  }

  _handleOrderbook(msg) {
    const d = msg.data;
    const symbol = (d.s || "").toUpperCase();
    const isSnapshot = msg.type === "snapshot";
    const channel = "orderbook";
    const evType = isSnapshot ? "orderbook.snapshot" : "orderbook.delta";
    bus.pub(subject(this.venue, symbol, evType), {
      venue: this.venue, symbol,
      bids: d.b || [],
      asks: d.a || [],
      venueSeq: d.seq || d.u || 0, ts: msg.ts || Date.now(),
    });
  }

  _handleTrade(msg) {
    const trades = Array.isArray(msg.data) ? msg.data : [msg.data];
    for (const t of trades) {
      const symbol = (t.s || "").toUpperCase();
      bus.pub(subject(this.venue, symbol, "trades"), {
        venue: this.venue, symbol,
        id: t.i || `bybit-${t.T}`,
        price: String(t.p ?? "0"), size: String(t.v ?? "0"),
        side: (t.S || "Buy").toLowerCase(), ts: t.T || Date.now(),
      });
    }
  }

  _handleKline(msg) {
    const k = Array.isArray(msg.data) ? msg.data[0] : msg.data;
    if (!k) return;
    const topic = msg.topic || "";
    const topicParts = topic.split(".");
    const symbol = topicParts.length >= 3 ? topicParts[2].toUpperCase() : "";
    const bybitInterval = topicParts.length >= 2 ? topicParts[1] : "1";
    const interval = BYBIT_TO_APP[bybitInterval] || "1m";
    bus.pub(subject(this.venue, symbol, `kline.${interval}`), {
      venue: this.venue, symbol,
      interval,
      openTime: k.start || 0, closeTime: k.end || 0,
      open: String(k.open ?? "0"), high: String(k.high ?? "0"),
      low: String(k.low ?? "0"), close: String(k.close ?? "0"),
      volume: String(k.volume ?? "0"), closed: !!k.confirm,
    });
  }

  _handleTicker(msg) {
    const d = msg.data;
    const symbol = (d.symbol || "").toUpperCase();
    bus.pub(subject(this.venue, symbol, "ticker"), {
      venue: this.venue, symbol,
      lastPrice: String(d.lastPrice ?? "0"),
      bidPrice: String(d.bid1Price ?? "0"),
      askPrice: String(d.ask1Price ?? "0"),
      indexPrice: String(d.lastPrice ?? "0"), markPrice: String(d.lastPrice ?? "0"),
      change24h: String(d.price24hPcnt ?? "0"),
      high24h: String(d.highPrice24h ?? "0"),
      low24h: String(d.lowPrice24h ?? "0"),
      volume24h: String(d.volume24h ?? "0"),
      turnover24h: String(d.turnover24h ?? "0"),
      ts: msg.ts || Date.now(),
    });
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}
