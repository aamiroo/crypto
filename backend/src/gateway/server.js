import http from "node:http";
import { gzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { Hub } from "./hub.js";
import { INTERVALS, intervalMs } from "../intervals.js";
import { createKlinesStore } from "./klinesStore.js";
import { createKlineCrawler } from "./klineCrawler.js";
import { bus, subject } from "../bus.js";

const WS_PATH = "/ws";
const BYBIT_REST = process.env.BYBIT_REST || "https://api.bybit.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const CHANNELS = ["orderbook", "trades", "kline", "ticker"];
const SYMBOL_RE = /^[A-Z0-9]{3,20}$/;
const MAX_KLINES = 1000;

// App interval → Bybit v5 kline interval
const APP_TO_BYBIT = {
  "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
  "1h": "60", "4h": "240", "1d": "D", "1w": "W",
};

/** Every REST reply goes through here, so the CORS headers are never forgotten. */
function cors(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", Vary: "Accept-Encoding", ...CORS });
  res.end(JSON.stringify(body));
}

/** Bodies below this are not worth a compression pass: a kline page is ~170 KB
 *  of repeated field names, an error envelope is ~30 bytes. */
const GZIP_MIN_BYTES = 1024;

/** The one place a response is compressed, so a body can never be gzipped
 *  twice. Level 1 is deliberate: on a full 1000-candle page it gives 29 KB
 *  against 24 KB at level 6, for 1.3 ms instead of 2.3 ms — on the path that
 *  answers the chart. */
function respond(req, res, status, body) {
  const text = JSON.stringify(body);
  const enc = String(req.headers["accept-encoding"] ?? "");
  if (text.length >= GZIP_MIN_BYTES && /\bgzip\b/i.test(enc)) {
    const gz = gzipSync(Buffer.from(text), { level: 1 });
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Content-Length": String(gz.length),
      Vary: "Accept-Encoding",
      ...CORS,
    });
    res.end(gz);
    return;
  }
  cors(res, status, body);
}

/** Reject anything that is not a well-formed instrument id before it reaches
 *  the exchange URL or the bus. */
function parseSymbol(raw, fallback) {
  const s = String(raw ?? fallback ?? "").trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}

/** Only intervals the app itself models are accepted; anything else is null. */
function parseInterval(raw) {
  const iv = String(raw ?? "").trim().toLowerCase();
  return INTERVALS.includes(iv) ? iv : null;
}

/** Candle count clamped to [1, MAX_KLINES]; null when it is not a number. */
function parseLimit(raw) {
  const n = Number.parseInt(String(raw ?? 500), 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_KLINES) : null;
}

/** Optional "return candles before this instant" bound, in ms epoch. */
function parseEndTime(raw) {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 4102444800000) return { ok: false, value: null };
  return { ok: true, value: Math.floor(n) };
}

const KLINES_CACHE_TTL_MS = 2000;
const KLINES_MIN_SPACING_MS = 150; // minimum gap between outbound Bybit calls
const KLINES_CIRCUIT_MS = 8000; // cool-off after a 403/429 before retrying Bybit
const KLINES_CACHE_MAX = 400;
/** One window must cost the browser milliseconds, not seconds. A network that
 *  refuses us answers in under 100 ms; what actually stalls a request is an
 *  attempt that hangs, so each one is capped hard and the whole probe is over
 *  in ~2.5 s — after which the mirror answers anyway. */
const KLINES_ATTEMPTS = 3;
const KLINES_ATTEMPT_TIMEOUT_MS = 1200;
const KLINES_BUDGET_MS = 2500;
/** After a probe for one (symbol, interval) fails, that window is not probed
 *  again on every read: the mirror answers and the next attempt waits this out,
 *  doubling to a cap. Without it the refresh tick, the selection pre-warm and
 *  every stale-while-revalidate re-probe re-open a doomed request several times
 *  a minute per pair — measured at 227 failed rounds in 54 minutes of log. */
const KLINES_WINDOW_COOL_MS = 20000;
const KLINES_WINDOW_COOL_MAX_MS = 300000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The `/api/klines` upstream path: request de-duplication, a tiny cache and a
 * serialized, budget-bounded retry queue.
 *
 * Bybit punishes concurrent/rapid REST bursts with HTTP 403, while the client
 * legitimately fires several kline requests at once (remounts, timeframe
 * switches, older-page loads). So identical requests share one upstream call,
 * outbound calls are spaced, and after a 403/429 the queue pauses for a
 * cool-off instead of hammering the limiter into a longer ban.
 *
 * `store` holds the last window the venue actually served. A venue failure is
 * no reason to hand the terminal an empty chart — historical candles never
 * change and the live tail arrives over the websocket — so the cache fallback
 * is both safe and useful, including right after a restart.
 *
 * `background` marks the probes nobody is waiting on (the refresh tick, the
 * selection pre-warm, the revalidation behind a mirror answer). Those are the
 * ones that pile up while the venue refuses us, so they are the ones the
 * cool-offs silence.
 */
function createKlinesFetcher({ store, logger }) {
  const cache = new Map(); // key -> { at, data }
  const inflight = new Map(); // key -> Promise
  const windowCool = new Map(); // "SYM|iv" -> { until, delay }
  let tail = Promise.resolve(); // serializes outbound Bybit requests
  let lastOut = 0;
  let circuitUntil = 0;
  let circuitErr = null; // why the cool-off was opened, for the first request inside it

  // Read per gateway, like the refresh interval: an operator (or a test) has to
  // be able to watch the recovery path without waiting minutes for it.
  const windowCoolMs = Math.max(0, Number(process.env.KLINE_COOL_MS || KLINES_WINDOW_COOL_MS));
  const windowCoolMaxMs = Math.max(windowCoolMs, Number(process.env.KLINE_COOL_MAX_MS || KLINES_WINDOW_COOL_MAX_MS));
  const circuitMs = Math.max(0, Number(process.env.KLINE_CIRCUIT_MS || KLINES_CIRCUIT_MS));

  /** Is this window still in the cool-off its last failed probe opened? */
  function windowCooling(symbol, interval) {
    const c = windowCool.get(`${symbol}|${interval}`);
    return !!c && c.until > Date.now();
  }

  /** Open (and widen) the cool-off for one window after a failed probe. */
  function coolWindow(symbol, interval) {
    const key = `${symbol}|${interval}`;
    const prev = windowCool.get(key);
    const delay = Math.min(prev ? prev.delay * 2 : windowCoolMs, windowCoolMaxMs);
    windowCool.set(key, { until: Date.now() + delay, delay });
  }

  /** The venue answered for this window: probe it normally again. */
  function warmWindow(symbol, interval) {
    windowCool.delete(`${symbol}|${interval}`);
  }

  /** Background work must not occupy the serialized lane while the venue is in
   *  its global cool-off — a client's own request would queue behind it. */
  function backgroundShouldWait() {
    return circuitUntil > Date.now();
  }

  function enqueue(task) {
    const run = tail.then(task, task);
    tail = run.then(() => {}, () => {});
    return run;
  }

  /** Wait for the shared outbound slot: the cool-off first, then the minimum
   *  spacing between two Bybit calls. False when the cool-off outlasts what is
   *  left of the budget, i.e. stop trying rather than overrun or re-probe. */
  async function pause(budgetLeftMs) {
    const coolOff = circuitUntil - Date.now();
    if (coolOff >= budgetLeftMs) return false;
    if (coolOff > 0) await sleep(coolOff);
    const since = Date.now() - lastOut;
    if (since < KLINES_MIN_SPACING_MS) await sleep(KLINES_MIN_SPACING_MS - since);
    lastOut = Date.now();
    return true;
  }

  /** Drop entries the client is not asking for any more, then, if a burst of
   *  distinct keys still left us oversized, keep the newest. */
  function trimCache() {
    if (cache.size <= KLINES_CACHE_MAX) return;
    for (const [k, v] of cache) {
      if (Date.now() - v.at > KLINES_CACHE_TTL_MS) cache.delete(k);
    }
    while (cache.size > KLINES_CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  /** The newest candles on hand for a "what is recent" read.
   *
   *  The store only calls a window *current* while its newest bar still reaches
   *  the present, and it is right to refuse that claim for a window the stream
   *  stopped feeding hours ago. Answering the read with nothing would be wrong
   *  twice over: the client asked for the newest page, these are the newest bars
   *  we hold, and `source: "mirror"` already tells it the page is what we last
   *  had rather than what Bybit just served. Refusing is what leaves a chart
   *  empty while the venue is blocked. */
  function recentHeld(symbol, interval, limit) {
    const live = store?.candles(symbol, interval, limit);
    if (live && live.length) return live;
    return store?.candlesBefore(symbol, interval, Date.now(), limit) ?? null;
  }

  /** Resolves `{ data, source }`, where `source` is `"venue"` for a page Bybit
   *  just served and `"mirror"` for the last-good window on hand. The client
   *  needs the difference: a short venue page means the exchange has nothing
   *  older, while a short mirror page only means we have not mirrored that deep
   *  yet — treating the two alike ends scroll-back at the wrong place. */
  function fetchKlines(symbol, interval, limit, endTime, opts = {}) {
    const key = `${symbol}|${interval}|${limit}|${endTime || ""}`;

    // Nobody is waiting on this one: it exists to fill the mirror. So it ignores
    // the read cache (a fresh cached answer is no reason to skip a harvest) but
    // obeys both cool-offs, which is what keeps the refresh tick and the
    // pre-warm from queueing doomed probes in front of a client.
    if (opts.background) {
      if (windowCooling(symbol, interval) || backgroundShouldWait()) return Promise.resolve(null);
      return upstream(key, symbol, interval, limit, endTime, true);
    }

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < KLINES_CACHE_TTL_MS) return Promise.resolve(hit);

    // Only a window ending "now" can stand in for a recent page; a backfill page
    // must genuinely go fetch older bars.
    const mirror = endTime ? null : recentHeld(symbol, interval, limit);
    const cooling = windowCooling(symbol, interval);

    // A backfill page we already hold in full is not a reason to call the venue:
    // historical candles never change, and this is what makes scroll-back local.
    if (endTime) {
      const held = store?.candlesBefore(symbol, interval, endTime, limit);
      if (held && held.length >= limit) {
        const page = { data: held, source: "mirror" };
        cache.set(key, { at: Date.now(), ...page });
        trimCache();
        return Promise.resolve(page);
      }
      return upstream(key, symbol, interval, limit, endTime);
    }

    // A window the venue really served is a correct chart right now: historical
    // bars never change and the live tail arrives over the websocket. So answer
    // from the mirror at once and re-probe behind the response — measured, this
    // is what turns a 6 s chart into a 1 ms one while the venue is blocked.
    // A window in its cool-off is answered the same way: the last probe failed,
    // so the client must not pay again for the same refusal.
    if (mirror && mirror.length && (store?.venueBacked(symbol, interval) || cooling)) {
      cache.set(key, { at: Date.now(), data: mirror, source: "mirror" });
      trimCache();
      if (!cooling && !backgroundShouldWait()) {
        void upstream(key, symbol, interval, limit, endTime, true).catch(() => {});
      }
      return Promise.resolve({ data: mirror, source: "mirror" });
    }
    return upstream(key, symbol, interval, limit, endTime);
  }

  /** The queued upstream attempt for one key, shared by every caller waiting on
   *  it (including the background revalidation of an already-served window). */
  function upstream(key, symbol, interval, limit, endTime, background = false) {
    const pending = inflight.get(key);
    if (pending) return pending;

    const task = enqueue(async () => {
      const started = Date.now();
      let lastErr;
      for (let attempt = 0; attempt < KLINES_ATTEMPTS; attempt++) {
        const left = KLINES_BUDGET_MS - (Date.now() - started);
        if (left <= KLINES_MIN_SPACING_MS) break;
        if (!(await pause(left))) break;
        try {
          const data = await fetchFromVenue(symbol, interval, limit, endTime,
            Math.min(KLINES_ATTEMPT_TIMEOUT_MS, left));
          circuitUntil = 0;
          circuitErr = null;
          warmWindow(symbol, interval);
          cache.set(key, { at: Date.now(), data, source: "venue" });
          trimCache();
          // Only the window ending "now" is a usable fallback for "recent"; an
          // older page deepens the mirror's history instead of replacing it.
          if (endTime) store?.rememberOlder(symbol, interval, data);
          else store?.remember(symbol, interval, data);
          return { data, source: "venue" };
        } catch (err) {
          lastErr = err;
          if (/403|429/.test(err.message)) {
            circuitUntil = Date.now() + circuitMs;
            circuitErr = err;
          } else if (!/fetch failed|timeout|ECONN|socket|abort/i.test(err.message)) throw err;
        }
      }
      // This window is refused right now. Give it a cool-off so the next reads
      // — and the next refresh tick — answer from the mirror instead of
      // queueing another doomed probe behind it.
      coolWindow(symbol, interval);
      // What we hold is still an answer: the recent window for a "recent" read,
      // the older candles we have actually mirrored for a backfill read. A short
      // backfill is reported as a mirror page, not as the end of history — the
      // client must be able to tell "we have not mirrored that deep" from "the
      // exchange has nothing older".
      const fallback = endTime
        ? store?.candlesBefore(symbol, interval, endTime, limit)
        : recentHeld(symbol, interval, limit);
      const reason = lastErr ?? circuitErr;
      if (fallback && fallback.length) {
        // Only worth a log when the mirror was the answer the client needed; a
        // background revalidation of an already-served window is routine.
        if (!background && !store?.venueBacked(symbol, interval)) {
          logger.warn("klines served from cache", {
            symbol, interval, err: String(reason?.message ?? reason ?? "budget"),
          });
        }
        // Cache what we actually answered, so the next read of the same window
        // is instant instead of paying for another doomed probe.
        cache.set(key, { at: Date.now(), data: fallback, source: "mirror" });
        trimCache();
        return { data: fallback, source: "mirror" };
      }
      throw reason ?? new Error("Bybit request unavailable");
    }).finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
  }

  /** Could an older page for this window actually be fetched right now? While
   *  the venue refuses it (window cool-off) or refuses everything (circuit), the
   *  answer is no — and the client should not spend a round trip finding out. */
  function canGoOlder(symbol, interval) {
    return !windowCooling(symbol, interval) && !backgroundShouldWait();
  }

  return { fetchKlines, canGoOlder };
}

/**
 * One upstream kline call. Bybit answers newest-first with string prices, so
 * chronological order and the envelope shape are normalised here — clients
 * never see the venue's ordering.
 */
async function fetchFromVenue(symbol, interval, limit, endTime, timeoutMs) {
  const params = new URLSearchParams({
    category: "spot",
    symbol,
    interval: APP_TO_BYBIT[interval],
    limit: String(limit),
  });
  // Optional backfill window: candles strictly before `endTime` (ms).
  if (endTime) params.set("end", String(endTime));
  const r = await fetch(`${BYBIT_REST}/v5/market/kline?${params}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; CryptoTerminal/1.0)" },
  });
  if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(j.retMsg || `Bybit error ${j.retCode}`);
  const list = j.result?.list;
  if (!Array.isArray(list)) throw new Error("No kline data");
  const ms = intervalMs(interval);
  const now = Date.now();
  // Bybit returns newest-first; reverse for chronological order
  return list.reverse().map((c) => ({
    interval,
    openTime: Number(c[0]),
    closeTime: Number(c[0]) + ms - 1,
    open: String(c[1]),
    high: String(c[2]),
    low: String(c[3]),
    close: String(c[4]),
    volume: String(c[5]),
    // The last row of every window is the candle still forming. Labelling it
    // closed makes the client treat a partial bar as final and let a REST
    // refresh rewind the live one.
    closed: Number(c[0]) + ms <= now,
  }));
}

/**
 * Keep the cached windows of *watched* pairs fresh without the client asking.
 *
 * The venue rejects some periods outright — its CDN refuses a share of
 * connections from some networks, and which ones it lets through changes over
 * minutes. A chart that only loads when the user happens to press Retry is the
 * "loading never works" the terminal gets blamed for, so the gateway re-pulls
 * the recent window for the pairs clients are actually viewing until it lands,
 * and serves that cache in the meantime.
 *
 * Rate limits still apply: this goes through the same serialized queue, so a
 * 403 cool-off silences it for a whole round rather than adding pressure.
 */
export function startKlineWindowRefresh({ refreshWindow, demand, intervalMs, logger }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // An idle terminal has no demand, so this loop sends nothing at all.
      for (const [symbol, interval] of demand()) await refreshWindow(symbol, interval);
    } catch (err) {
      logger.warn("kline window refresh failed", { err: err.message });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * @param instruments  Instruments registry (live symbol + precision metadata)
 * @param venues       Venues to bridge from the bus
 * @param logger
 * @param collector    Optional collector, synced to whichever symbol a client
 *                     selects (orderbook/trades/kline are heavy, so they are
 *                     only streamed on demand)
 * @param klines       The candle-window mirror (see klinesStore.js); created per
 *                     gateway when the host has no loaded one to pass in.
 * @param crawler      The history crawl, built over that mirror and fetcher when
 *                     the host does not supply one. A test that only wants to
 *                     watch the client-facing request path passes a no-op, since
 *                     the default is background upstream work on another timer.
 *
 * Clients are served from that mirror and, behind the response, the history
 * crawl (see klineCrawler.js) deepens whichever windows are actually being read.
 */
export function createGateway(instruments, venues, logger, collector, klines, crawler) {
  const hub = new Hub(logger);
  const server = http.createServer();
  const bridged = new Set();
  const klinesStore = klines ?? createKlinesStore({ logger });
  const fetcher = createKlinesFetcher({ store: klinesStore, logger });
  const fetchKlines = fetcher.fetchKlines;

  /* ── history crawl ───────────────────────────────────────────── */
  // The crawl goes out through the same lane a client does: same serialized
  // queue, same per-window cool-off, same in-flight de-duplication. So a page a
  // scroll-back is already fetching is joined, never fetched twice, and a venue
  // that refuses us silences the crawl as hard as it silences the refresh tick.
  const historyCrawl = crawler ?? createKlineCrawler({
    store: klinesStore,
    fetchPage: (symbol, interval, limit, endTime, opts) =>
      fetcher.fetchKlines(symbol, interval, limit, endTime, opts),
    logger,
  });

  /* ── bus → hub bridge ────────────────────────────────────────── */
  function bridge(symbol) {
    if (bridged.has(symbol)) return;
    bridged.add(symbol);
    for (const venue of venues) {
      bus.on(subject(venue, symbol, "orderbook.snapshot"), (e) => hub.broadcastSnapshot("orderbook", symbol, e.ts, e));
      bus.on(subject(venue, symbol, "orderbook.delta"),   (e) => hub.broadcastDelta("orderbook", symbol, e.ts, e));
      bus.on(subject(venue, symbol, "trades"),            (e) => hub.broadcastEvent("trade", "trades", symbol, e.ts, e));
      bus.on(subject(venue, symbol, "ticker"),            (e) => hub.broadcastEvent("ticker", "ticker", symbol, e.ts, e));
      for (const iv of INTERVALS) {
        // The stream is also the mirror's live feed: candles that arrive here are
        // the only history the gateway has while the venue's REST is unreachable.
        bus.on(subject(venue, symbol, `kline.${iv}`), (e) => {
          hub.broadcastKline(symbol, e.ts, e);
          klinesStore.append(symbol, iv, e);
        });
      }
    }
  }

  /** Re-run after instrument discovery: `bridge` is idempotent, so only the
   *  symbols that appeared get new bus listeners. */
  function syncBridge() {
    for (const sym of instruments.symbols) bridge(sym);
  }
  syncBridge();
  instruments.onChange = syncBridge;

  /* ── REST ────────────────────────────────────────────────────── */

  /** What a client may conclude from this page. `venueBacked` says the candles
   *  are real exchange history, not just the websocket tail — the two are the
   *  same length, so the count alone cannot tell them apart. `canGoOlder` says
   *  whether an older page behind it has any chance of being fetched now: not
   *  while the venue refuses this window, and not once the crawl has reached the
   *  depth the policy asks for or the exchange has ended the range. `source`
   *  separates a short page the venue *ended* from a short page that is only how
   *  deep our mirror goes — the first is the end of history, the second is not,
   *  and scroll-back has to know which one it just hit. `history` is the same
   *  progress the crawl runs on, for anything that wants to show it. */
  function pageMeta(symbol, interval, page) {
    const p = klinesStore.progress(symbol, interval);
    return {
      // A history page is venue-backed when the venue served it, or when the
      // mirror it came from was filled by an earlier venue page. A window the
      // websocket only streamed into has no exchange history behind it, and
      // claiming otherwise would let a client widen it for nothing.
      venueBacked: page.source === "venue" || klinesStore.venueBacked(symbol, interval),
      canGoOlder: p.status !== "exhausted" && p.bars < p.target && fetcher.canGoOlder(symbol, interval),
      source: page.source,
      history: {
        target: p.target,
        // Three different numbers on purpose: what we hold, how much of it the
        // venue actually served, and what history says about the rest.
        bars: p.bars,
        venueBars: p.venueBars,
        status: p.status,
        cursor: p.cursor,
        // How many venue pages this window cost, so "deep history" and "many
        // upstream requests" can be read side by side instead of inferred.
        pages: p.pages,
        error: p.lastError,
      },
    };
  }

  server.on("request", async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    if (req.method !== "GET") { cors(res, 405, { error: "method_not_allowed" }); return; }

    if (u.pathname === "/healthz") {
      respond(req, res, 200, { ok: true, venue: venues[0], instruments: instruments.symbols.length, source: instruments.source });
      return;
    }

    if (u.pathname === "/api/symbols") {
      respond(req, res, 200, { data: { venue: venues[0], instruments: instruments.list() } });
      return;
    }

    if (u.pathname === "/api/klines") {
      const sym = parseSymbol(u.searchParams.get("symbol"), "BTCUSDT");
      if (!sym) { cors(res, 400, { error: "BAD_SYMBOL" }); return; }
      if (!instruments.has(sym)) { cors(res, 404, { error: "UNKNOWN_SYMBOL", symbol: sym }); return; }
      const iv = parseInterval(u.searchParams.get("interval") ?? "1m");
      if (!iv) { cors(res, 400, { error: "BAD_INTERVAL", allowed: INTERVALS }); return; }
      const lim = parseLimit(u.searchParams.get("limit"));
      if (lim === null) { cors(res, 400, { error: "BAD_LIMIT" }); return; }
      const end = parseEndTime(u.searchParams.get("endTime"));
      if (!end.ok) { cors(res, 400, { error: "BAD_END_TIME" }); return; }
      try {
        const page = await fetchKlines(sym, iv, lim, end.value);
        respond(req, res, 200, { data: page.data, meta: pageMeta(sym, iv, page) });
        // Someone is reading this window, so it is the window worth deepening.
        // After the response, never before it: the crawl answers the chart from
        // the mirror while the pages arrive, and `trigger` is idempotent, so ten
        // clients on one pair still mean one crawl.
        historyCrawl.trigger(sym, iv);
      } catch (e) {
        logger.error("klines", { err: e.message, symbol: sym, interval: iv });
        cors(res, 502, { error: e.message });
      }
      return;
    }

    cors(res, 404, { error: "not found" });
  });

  /* ── WebSocket ───────────────────────────────────────────────── */
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://localhost").pathname !== WS_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const clientSym = new Map();                 // client -> selected symbol
  const clientKline = new Map();               // client -> Map<symbol, appInterval>

  /** Push the current demand into the collector: orderbook/trades follow the
   *  symbol each client selected, klines the exact (symbol, interval) pairs.
   *  The venue's heavy streams stay closed until a client actually asks. */
  function syncDetail() {
    const syms = new Set(clientSym.values());
    const pairs = [];
    for (const m of clientKline.values()) {
      for (const [sym, iv] of m) pairs.push([sym, iv]);
    }
    collector?.sync([...syms], pairs);
    // Start filling a newly watched window now instead of on the next refresh
    // tick (up to 20 s away), so the first page is ready when the browser asks.
    // Marked background: while the venue refuses us, this is exactly the traffic
    // that must not take the lane a client is waiting on — and one entry per
    // watched pair, not one per client that watches it.
    for (const [sym, iv] of klineDemand()) {
      // The tail page first: it anchors the window the crawl then walks older
      // from. Chaining the trigger to it means a newly watched pair starts
      // deepening immediately instead of waiting for the next refresh tick.
      void fetchKlines(sym, iv, 1000, null, { background: true })
        .then(() => historyCrawl.trigger(sym, iv))
        .catch(() => { historyCrawl.trigger(sym, iv); });
    }
  }

  /** The (symbol, interval) pairs clients are watching, without duplicates. */
  const klineDemand = () => {
    const out = new Map();
    for (const m of clientKline.values()) {
      for (const [sym, iv] of m) out.set(`${sym}|${iv}`, [sym, iv]);
    }
    return [...out.values()];
  };

  // 1000 is the largest page the venue serves and the depth the terminal asks
  // for on open, so a refresh fills exactly the window the next request reads.
  const stopKlineRefresh = startKlineWindowRefresh({
    intervalMs: Number(process.env.KLINE_REFRESH_MS || 20000),
    logger,
    demand: klineDemand,
    refreshWindow: async (symbol, interval) => {
      try { await fetchKlines(symbol, interval, 1000, null, { background: true }); }
      catch { /* the client's own request is what reports a failure */ }
      // A pair still watched after a whole refresh round is a pair the terminal
      // is charting: keep the history walk going while that is true. `trigger`
      // no-ops on a window that is already crawling, cooling or done.
      historyCrawl.trigger(symbol, interval);
    },
  });

  /** One error shape for every unknown-symbol path (input is echoed truncated). */
  function rejectSymbol(client, raw) {
    sendError(client, "UNKNOWN_SYMBOL", `unknown symbol: ${String(raw ?? "").slice(0, 32)}`);
    return null;
  }

  wss.on("connection", (ws) => {
    const client = {
      ws,
      send: (env) => {
        if (ws.readyState !== 1) return false;
        try { ws.send(JSON.stringify(env)); return true; } catch { return false; }
      },
    };
    hub.register(client);
    logger.info("ws connected");
    client.send({
      type: "symbols", ts: Date.now(),
      data: { venue: venues[0], instruments: instruments.list() },
    });

    const release = () => {
      const hadSym = clientSym.delete(client);
      const hadKline = clientKline.delete(client);
      hub.unregister(client);
      if (hadSym || hadKline) syncDetail();
    };

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { sendError(client, "BAD_JSON", "invalid"); return; }
      if (msg.type === "ping") {
        client.send({ type: "pong", ts: Date.now() });
      } else if (msg.type === "subscribe" && Array.isArray(msg.channels)) {
        for (const ch of msg.channels) {
          if (!ch?.channel || !ch?.symbol) { sendError(client, "BAD_REQUEST", "channel and symbol required"); continue; }
          if (!CHANNELS.includes(ch.channel)) { sendError(client, "BAD_CHANNEL", `unknown channel: ${ch.channel}`); continue; }
          const sym = parseSymbol(ch.symbol);
          if (!sym) { rejectSymbol(client, ch.symbol); continue; }
          if (!instruments.has(sym)) { rejectSymbol(client, sym); continue; }
          let iv;
          if (ch.channel === "kline") {
            iv = parseInterval(ch.interval);
            if (!iv) { sendError(client, "BAD_INTERVAL", `unknown interval: ${String(ch.interval ?? "").slice(0, 16)}`); continue; }
          }
          hub.subscribe(client, ch.channel, sym, iv);
          if (iv) {
            let m = clientKline.get(client);
            if (!m) { m = new Map(); clientKline.set(client, m); }
            m.set(sym, iv);
          }
        }
        syncDetail();
      } else if (msg.type === "unsubscribe" && Array.isArray(msg.channels)) {
        for (const ch of msg.channels) {
          if (!ch?.channel || !ch?.symbol) continue;
          const sym = parseSymbol(ch.symbol);
          if (!sym) continue;
          let iv;
          if (ch.channel === "kline") {
            iv = parseInterval(ch.interval);
            if (!iv) { sendError(client, "BAD_INTERVAL", `unknown interval: ${String(ch.interval ?? "").slice(0, 16)}`); continue; }
            clientKline.get(client)?.delete(sym);
          }
          hub.unsubscribe(client, ch.channel, sym, iv);
        }
        syncDetail();
      } else if (msg.type === "select_symbol" && msg.symbol) {
        const sym = parseSymbol(msg.symbol);
        if (!sym) { sendError(client, "BAD_REQUEST", "invalid symbol"); return; }
        if (!instruments.has(sym)) { rejectSymbol(client, sym); return; }
        if (clientSym.get(client) === sym) return;
        clientSym.set(client, sym);
        syncDetail();
      } else if (msg.type) {
        sendError(client, "BAD_REQUEST", `unknown message type: ${String(msg.type).slice(0, 32)}`);
      }
    });

    ws.on("close", () => { release(); logger.info("ws disconnected"); });
    // An error is always followed by close, but release eagerly so a client
    // that never fires close cannot pin its symbol subscriptions forever.
    ws.on("error", (err) => { logger.warn("ws error", { err: err.message }); release(); });
  });

  wss.on("close", () => { stopKlineRefresh(); historyCrawl.stop(); hub.stop(); });
  server.on("close", () => { stopKlineRefresh(); historyCrawl.stop(); hub.stop(); });

  return { server, hub, syncBridge, klines: klinesStore, klineCrawler: historyCrawl };
}

/** Protocol error envelope: `{ code, message }` (see docs/PROTOCOL.md). Clients
 *  surface these as toasts, so `code` stays stable and machine-readable. */
function sendError(c, code, message, extra) {
  c.send({ type: "error", ts: Date.now(), data: { code, message, ...extra } });
}
