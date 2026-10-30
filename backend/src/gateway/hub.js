import { Sequencer } from "./sequencer.js";

const KLINES_REPLAY = 500;      // distinct bars kept for the kline snapshot replay
const KLINES_TOPICS_MAX = 256;  // (symbol, interval) histories kept in memory
const BOOK_TTL_MS = 5 * 60_000; // idle order books dropped after this
const LATEST_TTL_MS = 10 * 60_000;
const SWEEP_MS = 60_000;

export class Hub {
  /** Three caches back the three replay paths in `subscribe`: `books` is keyed
   *  without interval and always rebuilt at the current seq, `latest` holds one
   *  envelope per topic, `klineHistory` collapses the ticks of each topic into one
   *  bar per openTime and is LRU-capped. The sweep timer is unref'd so it can
   *  never hold the process open on its own. */
  constructor(logger, opts = {}) {
    this.logger = logger;
    this.bookTtlMs = opts.bookTtlMs ?? BOOK_TTL_MS;
    this.latestTtlMs = opts.latestTtlMs ?? LATEST_TTL_MS;
    this.clients = new Set();
    this.subs = new Map();        // topic -> Set<Client>
    this.seq = new Sequencer();
    this.books = new Map();       // topic -> { seq, ts, bids: Map, asks: Map }
    this.klineHistory = new Map(); // topic -> { seq, ts, interval, bars: Map }
    this.latest = new Map();      // topic -> { ts, env } for ticker/trade replay
    this._sweep = setInterval(() => this.sweep(), opts.sweepMs ?? SWEEP_MS);
    this._sweep.unref?.();
  }

  /** The client object itself is the identity key everywhere: it must expose
   *  `send(env)` returning false once the socket is unusable, and the same
   *  reference has to reach `unregister` or its subscriptions leak. */
  register(c) { this.clients.add(c); }

  /** No per-client index exists, so every topic set has to be scanned. Sets left
   *  empty are deleted instead of kept as tombstones, so a departed client cannot
   *  pin a topic key (and its book) in the maps. */
  unregister(c) {
    this.clients.delete(c);
    for (const [topic, set] of this.subs) {
      set.delete(c);
      if (set.size === 0) this.subs.delete(topic);
    }
  }

  /** Number of clients currently listening on a topic. */
  _audience(topic) {
    const set = this.subs.get(topic);
    return set ? set.size : 0;
  }

  /** Idempotent, and the whole recovery mechanism: a client that sees a seq gap
   *  re-subscribes and gets state rebuilt at the current seq, so this must never
   *  replay a frame cached under an older one. */
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
      // One collapsed frame, not the ≤500 individual ticks the venue happened to
      // push: each replayed frame used to be a separate store commit and a
      // separate chart diff on the client.
      const snap = this.klineHistory.get(t);
      if (snap && snap.bars.size > 0) c.send(klineSnapshotEnv(symbol, snap));
    } else {
      // Ticker/trade streams are sparse per symbol (Bybit only pushes tickers
      // for traded pairs), so replay the last known value immediately. Without
      // this the watchlist stays empty until the exchange happens to speak.
      const last = this.latest.get(t);
      if (last && Date.now() - last.ts <= this.latestTtlMs) c.send(last.env);
    }
  }

  /** Mirrors `subscribe`'s cleanup: an empty set is removed so `_audience` reports
   *  zero and `sweep` is then allowed to evict the topic's cached book or history. */
  unsubscribe(c, channel, symbol, interval) {
    const t = topicKey(channel, symbol, interval);
    const set = this.subs.get(t);
    if (!set) return;
    set.delete(c);
    if (set.size === 0) this.subs.delete(t);
  }

  /** The venue's own sequence is discarded here: `seq` is minted by this gateway so
   *  the client contract survives an exchange swap. The stored book replaces any
   *  previous one, which is what makes the next delta exactly `seq + 1`. */
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

  /** Mints a seq and fans out even when no book is held (idle-swept, or a delta
   *  that beat its snapshot). Those levels are then merged nowhere, so a late
   *  subscriber gets no snapshot until the venue pushes a fresh one. */
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

  /** Shared by trades and tickers, which have no accumulated state: `latest` keeps
   *  only the last envelope per topic, so a subscriber arriving later replays one
   *  value, not history. */
  broadcastEvent(msgType, channel, symbol, ts, data) {
    const seq = this.seq.next(channel, symbol);
    const env = { type: msgType, channel, symbol, seq, ts, data };
    const t = topicKey(channel, symbol);
    this.latest.set(t, { ts, env });
    this._broadcast(t, env);
  }

  /** `seq` is per (symbol, interval) because the client keys its gap detection the
   *  same way — 1m and 4h must not share a counter. The delete-then-set pair is the
   *  LRU touch that lets `sweep` evict quiet topics first. */
  broadcastKline(symbol, ts, data) {
    const interval = data.interval || "1m";
    const seq = this.seq.next("kline", symbol, interval);
    const env = { type: "kline", channel: "kline", symbol, seq, ts, data };
    const t = topicKey("kline", symbol, interval);
    let snap = this.klineHistory.get(t);
    if (!snap) {
      snap = { seq, ts, interval, bars: new Map() };
    } else {
      // LRU touch: re-insert so `sweep` walks the least-recently-written first.
      this.klineHistory.delete(t);
    }
    this.klineHistory.set(t, snap);
    snap.seq = seq;
    snap.ts = ts;
    snap.interval = interval;
    const openTime = Number(data.openTime);
    if (Number.isFinite(openTime)) {
      // Collapsed on write: the venue repeats the same candle several times before
      // it closes, and the newest tick is the truth for it, so the cache is bounded
      // by bar count rather than by tick count. Bars arrive ascending, so the
      // insertion order is the time order and the first key is the oldest bar.
      snap.bars.set(openTime, data);
      while (snap.bars.size > KLINES_REPLAY) snap.bars.delete(snap.bars.keys().next().value);
    }
    this._broadcast(t, env);
  }

  /** A false from `send` means that client's socket is no longer writable, so the
   *  frame is simply lost for it — it stays subscribed until `close` or `error`
   *  fires `unregister`, which is the only path that cleans up. */
  _broadcast(topic, env) {
    const set = this.subs.get(topic);
    if (!set) return;
    for (const c of set) {
      if (!c.send(env)) this.logger.warn("dropping slow client", { topic });
    }
  }

  /** Drop caches nobody is watching any more — the unbounded growth that made
   *  the process creep for days. */
  sweep() {
    const now = Date.now();
    for (const [topic, set] of this.subs) {
      if (set.size === 0) this.subs.delete(topic);
    }
    for (const [topic, book] of this.books) {
      if (this._audience(topic) === 0 && now - book.ts > this.bookTtlMs) this.books.delete(topic);
    }
    for (const [topic, last] of this.latest) {
      if (now - last.ts > this.latestTtlMs) this.latest.delete(topic);
    }
    // LRU cap on kline histories: evict the least-recently-used topics that no
    // one is watching, so a long tail of symbols cannot grow without bound.
    // Watched topics are skipped rather than stopping the sweep.
    if (this.klineHistory.size > KLINES_TOPICS_MAX) {
      for (const topic of [...this.klineHistory.keys()]) {
        if (this.klineHistory.size <= KLINES_TOPICS_MAX) break;
        if (this._audience(topic) > 0) continue;
        this.klineHistory.delete(topic);
      }
    }
  }

  /** Kills the sweeper when the server shuts down; both the wss and http close
   *  handlers call it, so it has to stay safe to repeat. Caches are untouched. */
  stop() { clearInterval(this._sweep); }
}

/** Rebuilt from the hub's own book, so a client that subscribes late still gets
 *  a snapshot carrying the current `seq` — the sequence-recovery contract then
 *  holds for it too. */
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

/** The collapsed bars of one topic as a single frame. `seq` is the newest minted
 *  for this topic, so the first live kline after it is exactly `seq + 1` and the
 *  client's gap test stays honest — and `interval` sits at the top of `data`
 *  because the client keys sequence recovery on (channel, symbol, interval): put
 *  it only inside each candle and every bar reads as a gap. */
function klineSnapshotEnv(symbol, snap) {
  return {
    type: "kline_snapshot",
    channel: "kline",
    symbol,
    seq: snap.seq,
    ts: snap.ts,
    data: {
      interval: snap.interval,
      candles: [...snap.bars.values()].sort((a, b) => Number(a.openTime) - Number(b.openTime)),
    },
  };
}

/** Merge levels into a book map. Size 0 deletes the price: that is how a delta
 *  marks a level as gone, and keeping it would corrupt the accumulated depth. */
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
