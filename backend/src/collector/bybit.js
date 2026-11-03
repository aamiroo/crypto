import { WebSocket } from "ws";
import { bus, subject } from "../bus.js";
import { normalizeTicker } from "./tickers.js";

const WS_URL = "wss://stream.bybit.com/v5/public/spot";
const BATCH_SIZE = 10; // Bybit spot WS limit: 10 topics per subscribe message
const ACK_TIMEOUT_MS = 30000;
const ACK_RETRY_MS = 5000;
const APP_TO_BYBIT = {
  "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
  "1h": "60", "4h": "240", "1d": "D", "1w": "W",
};
const BYBIT_TO_APP = {};
for (const [k, v] of Object.entries(APP_TO_BYBIT)) BYBIT_TO_APP[v] = k;

export class BybitCollector {
  /** Holds desired state, not socket state: tickers are the cheap always-on set,
   *  the two `_detail*` sets are what the gateway currently asks for, and all are
   *  replayed verbatim on every reconnect. */
  constructor(logger) {
    this.logger = logger;
    this.venue = "bybit";
    this._ws = null;
    this._alive = false;
    this._tickerSymbols = new Set();
    this._detailSymbols = new Set();    // symbols with orderbook+trade
    this._detailKlines = new Set();     // "SYMBOL|bybitIv" pairs
    this._pending = new Map();          // req_id -> { op, topics, at }
    this._retryTopics = new Set();
    this._retryTimer = null;
    this._ackTimer = null;
    this._reqSeq = 0;
    this._backoff = 1000;
    this._stopping = false;
    /** Kline frames dropped for a missing field, so "the venue never spoke" and
     *  "it spoke unusably" stay two different answers. */
    this._partial = 0;
  }

  /** Start with ticker symbols for ALL pairs (lightweight). */
  async run(tickerSymbols) {
    this._stopping = false;
    this._tickerSymbols = new Set(tickerSymbols);
    this.logger.info("bybit collector starting", { tickers: tickerSymbols.length });
    while (!this._stopping) {
      try {
        await this._runOnce();
        return;
      } catch (err) {
        if (this._stopping) return;
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

  /** Desired sets in, Bybit topic strings out. The kline key is `SYMBOL|interval`
   *  but the topic is `kline.<interval>.<symbol>`, so the halves swap places;
   *  book depth is pinned at 50 levels. */
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

  /** Bybit rejects a whole subscribe frame carrying more than BATCH_SIZE topics,
   *  so an unbatched send would silently lose the entire set. Each chunk gets its
   *  own `req_id` and stays in `_pending` until the ack resolves it. */
  _sendBatched(args, op) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < args.length; i += BATCH_SIZE) {
      const topics = args.slice(i, i + BATCH_SIZE);
      const reqId = `${op}-${this._reqSeq++}`;
      this._pending.set(reqId, { op, topics, at: Date.now() });
      try { this._ws.send(JSON.stringify({ op, args: topics, req_id: reqId })); } catch {
        this._pending.delete(reqId);
      }
    }
  }

  /** Bybit answers every subscribe/unsubscribe with an ack. A rejected batch
   *  (bad symbol, too many topics, permission) used to be discarded here, so
   *  panels could go silent with no trace. */
  _handleAck(msg) {
    const reqId = msg.req_id;
    const pending = reqId ? this._pending.get(reqId) : null;
    if (pending) this._pending.delete(reqId);
    const topics = pending?.topics ?? (Array.isArray(msg.topic) ? msg.topic : []);
    if (msg.success === false || msg.retCode !== undefined && msg.retCode !== 0) {
      this.logger.error("bybit subscription rejected", {
        op: msg.op, retMsg: msg.ret_msg || msg.retMsg, topics: topics.join(","),
      });
      if (msg.op === "subscribe" && topics.length) this._scheduleRetry(topics);
      return;
    }
    if (topics.length) this.logger.info("bybit subscription ok", { op: msg.op, count: topics.length });
  }

  /** Coalesces every rejected topic into one deferred re-subscribe instead of
   *  retrying batch by batch. The wanted-check runs when the timer fires, not
   *  here, so a symbol the client released in the interim is not revived. */
  _scheduleRetry(topics) {
    for (const t of topics) this._retryTopics.add(t);
    if (this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      const stillWanted = [...this._retryTopics].filter((t) => this._isWantedTopic(t));
      this._retryTopics.clear();
      if (stillWanted.length === 0) return;
      this.logger.info("bybit resubscribe retry", { count: stillWanted.length });
      this._sendBatched(stillWanted, "subscribe");
    }, ACK_RETRY_MS);
    this._retryTimer.unref?.();
  }

  /** Keeps a retry from resurrecting a channel the gateway stopped asking for.
   *  The symbol is the last segment because `orderbook.<depth>.<symbol>` carries
   *  the depth where the other topics carry the symbol. */
  _isWantedTopic(topic) {
    const parts = topic.split(".");
    const sym = parts[parts.length - 1];
    if (topic.startsWith("kline.")) return this._detailKlines.has(`${sym}|${parts[1]}`);
    if (topic.startsWith("orderbook.")) return this._detailSymbols.has(sym);
    if (topic.startsWith("publicTrade.")) return this._detailSymbols.has(sym);
    if (topic.startsWith("tickers.")) return this._tickerSymbols.has(sym);
    return false;
  }

  /** One connection attempt whose promise only ever settles by rejecting:
   *  `error` and `close` both fire, so `settle` keeps the first and `run` reads
   *  the rejection as "back off and reconnect". */
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
        if (this._ackTimer) { clearInterval(this._ackTimer); this._ackTimer = null; }
        this._pending.clear();
        ws.removeAllListeners();
        try { ws.close(); } catch {}
      };

      ws.on("open", () => {
        this._backoff = 1000;
        this._pending.clear();
        this._retryTopics.clear();
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
        // An ack that never arrives is a silently dead subscription.
        this._ackTimer = setInterval(() => {
          const now = Date.now();
          for (const [id, p] of this._pending) {
            if (now - p.at < ACK_TIMEOUT_MS) continue;
            this._pending.delete(id);
            if (p.op !== "subscribe") continue;
            this.logger.warn("bybit subscription unacked", { topics: p.topics.join(",") });
            this._scheduleRetry(p.topics);
          }
        }, ACK_TIMEOUT_MS);
        this._ackTimer.unref?.();
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
          if (msg.op === "subscribe" || msg.op === "unsubscribe") {
            this._handleAck(msg);
            return;
          }
          if (msg.op === "pong") return;
          this._handleMessage(msg);
        } catch (err) {
          this.logger.error("bybit parse error", { err: err.message });
        }
      });

      ws.on("error", (err) => { cleanup(); settle(() => reject(err)); });
      ws.on("close", () => { cleanup(); settle(() => reject(new Error("ws closed"))); });
    });
  }

  /** Only data frames get here — app pings, pongs and subscribe acks are consumed
   *  in `_runOnce`. Routing is by topic prefix because `data` names no channel. */
  _handleMessage(msg) {
    const topic = msg.topic || "";
    if (!topic || !msg.data) return;

    if (topic.startsWith("orderbook.")) this._handleOrderbook(msg);
    else if (topic.startsWith("publicTrade.")) this._handleTrade(msg);
    else if (topic.startsWith("kline.")) this._handleKline(msg);
    else if (topic.startsWith("tickers.")) this._handleTicker(msg);
  }

  /** `msg.type` alone decides snapshot vs delta, and the two are published on
   *  different subjects so the hub either replaces or patches its book. `venueSeq`
   *  is the exchange's counter; clients only ever see the gateway's seq. */
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

  /** `publicTrade` batches several fills into one frame, so this emits one bus
   *  event per element rather than one per message; `t.T` is the exchange time and
   *  doubles as the id fallback. */
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

  /** Symbol and interval live only in the topic, so both are parsed back out and
   *  the Bybit code mapped to the app's form — the bus subject is what the
   *  gateway's kline listeners bind to. `confirm` is the only close flag.
   *
   *  A frame missing any OHLCV field is dropped, never filled in. `?? "0"` used to
   *  turn an absent price into a candle priced at zero, which the mirror accepted
   *  (it only required `>= 0`) and the browser rejected — so the invented bar took
   *  the slot of the real one and the hole could never be healed. `start`/`end` are
   *  taken as the venue sends them; Bybit's `end` is the inclusive last
   *  millisecond (`start + span - 1`), the same convention the REST path uses. */
  _handleKline(msg) {
    const k = Array.isArray(msg.data) ? msg.data[0] : msg.data;
    if (!k) return;
    const topic = msg.topic || "";
    const topicParts = topic.split(".");
    const symbol = topicParts.length >= 3 ? topicParts[2].toUpperCase() : "";
    const bybitInterval = topicParts.length >= 2 ? topicParts[1] : "1";
    const interval = BYBIT_TO_APP[bybitInterval] || "1m";
    if (!symbol) return;
    const fields = [k.start, k.end, k.open, k.high, k.low, k.close, k.volume];
    if (fields.some((v) => v === undefined || v === null || v === "" || !Number.isFinite(Number(v)))) {
      this._partial += 1;
      if (this._partial === 1 || this._partial % 100 === 0) {
        this.logger.warn("bybit kline frame dropped", { topic, partial: this._partial });
      }
      return;
    }
    bus.pub(subject(this.venue, symbol, `kline.${interval}`), {
      venue: this.venue, symbol,
      interval,
      openTime: Number(k.start), closeTime: Number(k.end),
      open: String(k.open), high: String(k.high),
      low: String(k.low), close: String(k.close),
      volume: String(k.volume), closed: !!k.confirm,
    });
  }

  /** The spot ticker frame is the one topic using long field names (`d.symbol`, not
   *  `d.s`) and a fractional 24h change; `normalizeTicker` fixes the percent scale
   *  and drops the bid/ask this stream never fills. */
  _handleTicker(msg) {
    const d = msg.data;
    const symbol = (d.symbol || "").toUpperCase();
    if (!symbol) return;
    bus.pub(subject(this.venue, symbol, "ticker"), normalizeTicker(this.venue, {
      symbol: d.symbol,
      lastPrice: d.lastPrice,
      bidPrice: d.bid1Price,
      askPrice: d.ask1Price,
      change24h: d.price24hPcnt,
      high24h: d.highPrice24h,
      low24h: d.lowPrice24h,
      volume24h: d.volume24h,
      turnover24h: d.turnover24h,
    }, msg.ts || Date.now()));
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** Stop the feed: no reconnect, no timers, socket closed. */
  close() {
    this._stopping = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._ackTimer) { clearInterval(this._ackTimer); this._ackTimer = null; }
    this._pending.clear();
    this._retryTopics.clear();
    if (this._ws) {
      try { this._ws.removeAllListeners(); this._ws.close(); } catch {}
    }
  }
}
