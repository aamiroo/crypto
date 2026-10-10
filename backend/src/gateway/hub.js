import { Sequencer } from "./sequencer.js";

export class Hub {
  constructor(logger) {
    this.logger = logger;
    this.clients = new Set();
    this.subs = new Map();      // topic -> Set<Client>
    this.seq = new Sequencer();
    this.books = new Map();     // topic -> { seq, ts, bids: Map, asks: Map }
    this.klineHistory = new Map(); // topic -> kline[] (last 500 for replay)
  }

  register(c) { this.clients.add(c); }

  unregister(c) {
    this.clients.delete(c);
    for (const set of this.subs.values()) set.delete(c);
  }

  subscribe(c, channel, symbol, interval) {
    const t = topicKey(channel, symbol, interval);
    if (!this.subs.has(t)) this.subs.set(t, new Set());
    this.subs.get(t).add(c);
    if (channel === "orderbook") {
      // Rebuild the snapshot from the server-side book at the CURRENT seq so
      // the first delta the new subscriber sees is exactly seq+1 (a cached
      // snapshot from an earlier seq would silently corrupt their book).
      const book = this.books.get(topicKey(channel, symbol));
      if (book) c.send(snapshotEnv(symbol, book));
    } else if (channel === "kline") {
      const hist = this.klineHistory.get(t);
      if (hist) for (const env of hist) c.send(env);
    }
  }

  unsubscribe(c, channel, symbol, interval) {
    const set = this.subs.get(topicKey(channel, symbol, interval));
    if (set) set.delete(c);
  }

  broadcastSnapshot(channel, symbol, ts, data) {
    const seq = this.seq.next(channel, symbol);
    const env = { type: `${channel}_snapshot`, channel, symbol, seq, ts, data };
    const t = topicKey(channel, symbol);
    this.books.set(t, {
      seq, ts,
      bids: new Map(data.bids || []),
      asks: new Map(data.asks || []),
    });
    this._broadcast(t, env);
  }

  broadcastDelta(channel, symbol, ts, data) {
    const seq = this.seq.next(channel, symbol);
    const env = { type: `${channel}_delta`, channel, symbol, seq, ts, data };
    const t = topicKey(channel, symbol);
    const book = this.books.get(t);
    if (book) {
      applyLevels(book.bids, data.bids);
      applyLevels(book.asks, data.asks);
      book.seq = seq;
      book.ts = ts;
    }
    this._broadcast(t, env);
  }

  broadcastEvent(msgType, channel, symbol, ts, data) {
    const seq = this.seq.next(channel, symbol);
    const env = { type: msgType, channel, symbol, seq, ts, data };
    this._broadcast(topicKey(channel, symbol), env);
  }

  broadcastKline(symbol, ts, data) {
    const interval = data.interval || "1m";
    const seq = this.seq.next("kline", symbol, interval);
    const env = { type: "kline", channel: "kline", symbol, seq, ts, data };
    const t = topicKey("kline", symbol, interval);
    // Cache klines for replay
    let hist = this.klineHistory.get(t);
    if (!hist) { hist = []; this.klineHistory.set(t, hist); }
    hist.push(env);
    if (hist.length > 500) hist.splice(0, hist.length - 500);
    this._broadcast(t, env);
  }

  _broadcast(topic, env) {
    const set = this.subs.get(topic);
    if (!set) return;
    for (const c of set) {
      if (!c.send(env)) this.logger.warn("dropping slow client", { topic });
    }
  }
}

function snapshotEnv(symbol, book) {
  return {
    type: "orderbook_snapshot",
    channel: "orderbook",
    symbol,
    seq: book.seq,
    ts: book.ts,
    data: { bids: [...book.bids], asks: [...book.asks] },
  };
}

function applyLevels(target, levels) {
  if (!Array.isArray(levels)) return;
  for (const [price, size] of levels) {
    if (parseFloat(size) === 0) target.delete(price);
    else target.set(price, size);
  }
}

/** Build subscription key. channel:symbol[:interval] */
function topicKey(channel, symbol, interval) {
  return interval ? `${channel}:${symbol}:${interval}` : `${channel}:${symbol}`;
}
