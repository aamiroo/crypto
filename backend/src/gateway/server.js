import http from "node:http";
import { gzipSync, gzip } from "node:zlib";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { Hub } from "./hub.js";
import { INTERVALS, intervalMs } from "../intervals.js";
import { toValidTuple } from "../candleValidation.js";
import { createKlinesStore } from "./klinesStore.js";
import { createKlineCrawler } from "./klineCrawler.js";
import { bus, subject } from "../bus.js";

const gzipAsync = promisify(gzip);

const WS_PATH = "/ws";
const BYBIT_REST = process.env.BYBIT_REST || "https://api.bybit.com";
/** api.bybit.com sits behind a CloudFront distribution that answers some
 *  networks with a flat 403. These are Bybit's own alternate REST hosts, tried
 *  in order when the primary refuses the connection. An operator-pinned
 *  BYBIT_REST is honoured alone: a test or a private proxy must never have its
 *  failures silently rerouted to the public venue. */
const BYBIT_HOSTS = process.env.BYBIT_REST
  ? [BYBIT_REST]
  : [BYBIT_REST, "https://api.bytick.com", "https://api.bybit.nl", "https://api.bybit.kz"];
/** The host that answered last, probed first on the next call. */
let venueHostIndex = 0;
/** A host that just refused us is skipped for a while, so probes settle on the
 *  one that answers instead of re-trying a banned host every cycle. Without this
 *  the global circuit keeps re-opening on the same blocked host and the history
 *  crawl — which only goes out while the circuit is clear — never gets a turn.
 *  A geo-block lasts minutes, so the skip is sized like the crawl's own backoff
 *  cap: long enough that the working host gets an uninterrupted run to heal. */
const HOST_BLOCK_MS = 300_000;
const hostBlockedUntil = BYBIT_HOSTS.map(() => 0);
function pickVenueHost() {
  const n = BYBIT_HOSTS.length;
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const idx = (venueHostIndex + i) % n;
    if (hostBlockedUntil[idx] <= now) return idx;
  }
  return venueHostIndex;
}
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

/** Every REST reply goes through here, so the CORS headers are never forgotten.
 *  `text` is what the caller already serialised: a body is stringified once, not
 *  once per encoding it might be sent in. */
function cors(res, status, body, text) {
  res.writeHead(status, { "Content-Type": "application/json", Vary: "Accept-Encoding", ...CORS });
  res.end(text ?? JSON.stringify(body));
}

/** Bodies below this are not worth a compression pass: a kline page is ~170 KB
 *  of repeated field names, an error envelope is ~30 bytes. */
const GZIP_MIN_BYTES = 1024;
/** Above this the deflate goes to the thread pool instead of the event loop:
 *  a full page is the biggest thing the terminal sends, and compressing it on
 *  the loop is CPU taken from every other chart waiting to be painted. */
const GZIP_ASYNC_BYTES = 32 * 1024;
/** How many already-compressed payloads are kept. At ~30 KB a page this is a
 *  few hundred kB for the windows a client is actually looking at, and the LRU
 *  is what stops a scroll through the whole market from growing it. */
const GZIP_CACHE_MAX = 24;

/** Response payloads that have already been deflated, keyed by what the caller
 *  says identifies them (see `respond`). The key is only a hint: an entry is
 *  reused only after the serialised body is compared byte for byte, so a stale
 *  or colliding key can cost a compression pass but can never send the wrong
 *  page. */
const gzipCache = new Map();

function gzipCachePut(key, text, buf) {
  if (!key) return;
  gzipCache.set(key, { text, buf });
  while (gzipCache.size > GZIP_CACHE_MAX) gzipCache.delete(gzipCache.keys().next().value);
}

/** The one place a response is compressed, so a body can never be gzipped
 *  twice. Level 1 is deliberate: on a full 1000-candle page it gives 29 KB
 *  against 24 KB at level 6, for 1.3 ms instead of 2.3 ms — on the path that
 *  answers the chart. A repeated read of the same window (the 2 s cache, a
 *  second client, a browser retry) must not pay even that 1.3 ms: the deflated
 *  body is kept per response identity and reused while the bytes match. */
async function respond(req, res, status, body, cacheKey) {
  const text = JSON.stringify(body);
  const enc = String(req.headers["accept-encoding"] ?? "");
  if (text.length < GZIP_MIN_BYTES || !/\bgzip\b/i.test(enc)) {
    cors(res, status, body, text);
    return;
  }
  const hit = cacheKey ? gzipCache.get(cacheKey) : null;
  if (hit && hit.text === text) {
    // Refresh the LRU position of a page that keeps being asked for.
    gzipCache.delete(cacheKey);
    gzipCache.set(cacheKey, hit);
    sendGzipped(res, status, hit.buf);
    return;
  }
  const gz = text.length >= GZIP_ASYNC_BYTES
    ? await gzipAsync(Buffer.from(text), { level: 1 })
    : gzipSync(Buffer.from(text), { level: 1 });
  gzipCachePut(cacheKey, text, gz);
  sendGzipped(res, status, gz);
}

function sendGzipped(res, status, gz) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Encoding": "gzip",
    "Content-Length": String(gz.length),
    Vary: "Accept-Encoding",
    ...CORS,
  });
  res.end(gz);
}

/** Reject anything that is not a well-formed instrument id before it reaches
 *  the exchange URL or the bus. There is no default: a request that does not say
 *  which pair it wants is a broken client, and quietly answering it with another
 *  symbol's candles is how a chart ends up showing BTC under an ETH header. */
function parseSymbol(raw) {
  const s = String(raw ?? "").trim().toUpperCase();
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

/**
 * The `/api/klines` upstream path: request de-duplication, a tiny cache and a
 * rate-limited, budget-bounded retry queue with two priorities.
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
 * selection pre-warm, the crawl, the revalidation behind a mirror answer). Those
 * are the ones that pile up while the venue refuses us, so they are the ones the
 * cool-offs silence — and the ones an interactive request overtakes in the lane.
 */
function createKlinesFetcher({ store, logger }) {
  const cache = new Map(); // key -> { at, data }
  const inflight = new Map(); // key -> Promise
  const windowCool = new Map(); // "SYM|iv" -> { until, delay }
  let lastOut = 0;
  let circuitUntil = 0;
  let circuitErr = null; // why the cool-off was opened, for the first request inside it

  /* ── the lane: one outbound slot, two queues ─────────────────────────
   * Exactly one request may be in flight to Bybit at a time: its REST burst
   * protection is a concurrency limit as much as a rate limit, and the
   * cool-off/backoff behaviour below only makes sense against a single outbound
   * stream. What starved clients was not the slot, it is that the slot used to
   * be handed to a whole *probe* — every retry, every cool-off sleep, every
   * crawl page — on one promise chain. A 1 m window is ten crawl pages at
   * 750 ms, so a chart opening a different pair queued behind ~9 s of work it
   * had no interest in.
   *
   * Now the slot is granted per attempt, and two queues feed it:
   *   hi — a client is waiting on the answer
   *   bg — crawl pages, the refresh tick, the selection pre-warm, and the
   *        revalidation behind an already-served mirror page
   * The head of `hi` is picked first whenever the slot frees, so a client jumps
   * ahead of everything queued behind it; background work additionally waits
   * out the full minimum spacing after *any* send, so it can never crowd a
   * client out either. Waits happen in the queue, never while holding the slot:
   * a cool-off is not a reason for the lane to be busy for 8 s. */
  const hiQueue = [];
  const bgQueue = [];
  let slot = null;        // the item currently holding the outbound slot
  let laneTimer = null;   // armed to re-pump once the earliest reason clears
  let laneWake = 0;       // when that timer fires
  let closed = false;     // the gateway is shutting its lane down
  const lane = { hi: 0, bg: 0, yielded: 0, expired: 0 };

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

  /** How long the head item still may not go out, or null when it must stop
   *  waiting because its own budget would run out first. */
  function laneDelay(item, now) {
    const left = item.deadline - now;
    if (left <= 0) return null;
    let wait = 0;
    const cool = circuitUntil - now;
    if (cool > 0) {
      // A ban the item would still be sitting in when it ran out of budget is a
      // ban it should not start waiting for: answer from the mirror instead.
      if (cool >= left) return null;
      wait = cool;
    }
    // Venue-friendly spacing, unchanged: two sends never closer than this. It is
    // measured from the last send of either lane, which is also what makes a
    // background page yield after a client's request.
    const since = now - lastOut;
    if (since < KLINES_MIN_SPACING_MS) wait = Math.max(wait, KLINES_MIN_SPACING_MS - since);
    return wait;
  }

  /** The item that owns the next send: always an interactive one when any is
   *  waiting, and background work only when no client is queued at all. While
   *  the venue is in its global cool-off the background lane is parked: sending
   *  crawl traffic into a ban only extends it, and the crawl reads that as
   *  "the lane did not go out" and backs off. */
  function headItem() {
    if (hiQueue.length) {
      if (bgQueue.length) lane.yielded += 1;
      return { item: hiQueue[0], queue: hiQueue };
    }
    if (bgQueue.length && !backgroundShouldWait()) return { item: bgQueue[0], queue: bgQueue };
    return null;
  }

  /** Drop items whose budget ran out while they waited: a client that could not
   *  get a slot in `KLINES_BUDGET_MS` is better served by the mirror answer it
   *  can make immediately than by a request that would overrun both. */
  function expire(now) {
    for (const q of [hiQueue, bgQueue]) {
      while (q.length && q[0].deadline <= now) {
        const item = q.shift();
        lane.expired += 1;
        item.resolve(false);
      }
    }
  }

  function pump() {
    if (closed || slot || laneTimer) return;
    const now = Date.now();
    expire(now);
    const head = headItem();
    if (!head) return;
    const delay = laneDelay(head.item, Date.now());
    if (delay === null) {
      head.queue.shift();
      lane.expired += 1;
      head.item.resolve(false);
      return pump();
    }
    if (delay > 0) {
      laneWake = Date.now() + delay;
      const t = setTimeout(() => { laneTimer = null; pump(); }, delay);
      t.unref?.();
      laneTimer = t;
      return;
    }
    head.queue.shift();
    slot = head.item;
    lastOut = Date.now();
    if (head.item.background) lane.bg += 1; else lane.hi += 1;
    head.item.resolve(true);
  }

  /** Ask for the outbound slot for one attempt. Resolves true when the caller
   *  owns it (it must `release` when the attempt is over) and false when the
   *  lane says the attempt should not go out at all. */
  function takeLane({ background = false, budgetMs = KLINES_BUDGET_MS } = {}) {
    // A gateway that is closing has nobody to serve: refuse rather than let a
    // retry go out on a socket nobody is listening to any more.
    if (closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const item = { resolve, background, deadline: Date.now() + Math.max(0, budgetMs) };
      (background ? bgQueue : hiQueue).push(item);
      // A parked lane wakes for the *first* reason; a client request parked
      // behind a long cool-off would otherwise sleep past its own budget.
      if (laneTimer && laneWake > item.deadline) {
        clearTimeout(laneTimer);
        laneTimer = null;
      }
      pump();
    });
  }

  /** Retire the lane: every parked attempt is refused at once, so a probe that
   *  started just before shutdown cannot still be spending its retries after it
   *  (which would be an upstream request on a dead gateway's behalf, and in a
   *  test suite an unattributable call in somebody else's stub). */
  function stop() {
    closed = true;
    if (laneTimer) { clearTimeout(laneTimer); laneTimer = null; }
    for (const q of [hiQueue, bgQueue]) {
      while (q.length) q.shift().resolve(false);
    }
  }

  function release() {
    slot = null;
    pump();
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
    // The crawl is excepted: its gap pages ask for a range the mirror is missing
    // by definition, and `candlesBefore` would hand back the bars *before* the
    // hole — a full page that heals nothing. Only the venue can fill a gap.
    if (endTime) {
      const held = store?.candlesBefore(symbol, interval, endTime, limit);
      if (held && held.length >= limit && !opts.background) {
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
    const task = probe(key, symbol, interval, limit, endTime, background)
      .finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  }

  /** One window's probe: at most `KLINES_ATTEMPTS` attempts, inside
   *  `KLINES_BUDGET_MS` in total, each of which first has to win the lane. */
  async function probe(key, symbol, interval, limit, endTime, background) {
    const started = Date.now();
    let lastErr;
    for (let attempt = 0; attempt < KLINES_ATTEMPTS; attempt++) {
      const left = KLINES_BUDGET_MS - (Date.now() - started);
      if (left <= KLINES_MIN_SPACING_MS) break; // no room left for a real attempt
      const mine = await takeLane({ background, budgetMs: left });
      if (!mine) break; // the lane said: this one is not going out
      try {
        const data = await fetchFromVenue(symbol, interval, limit, endTime,
          Math.min(KLINES_ATTEMPT_TIMEOUT_MS, left), logger);
        return served(key, symbol, interval, endTime, data);
      } catch (err) {
        lastErr = err;
        if (/403|429/.test(err.message)) {
          circuitUntil = Date.now() + circuitMs;
          circuitErr = err;
        } else if (!/fetch failed|timeout|ECONN|socket|abort/i.test(err.message)) throw err;
      } finally {
        release();
      }
    }
    return fromMirror(key, symbol, interval, limit, endTime, background, lastErr);
  }

  /** A page the venue actually served: clear both cool-offs, answer, mirror it. */
  function served(key, symbol, interval, endTime, data) {
    circuitUntil = 0;
    circuitErr = null;
    warmWindow(symbol, interval);
    cache.set(key, { at: Date.now(), data, source: "venue" });
    trimCache();
    // Only the window ending "now" is a usable fallback for "recent"; an
    // older page deepens the mirror's history instead of replacing it.
    let added = 0;
    if (endTime) {
      added = store?.rememberOlder(symbol, interval, data) ?? 0;
    } else {
      store?.remember(symbol, interval, data);
    }
    return { data, source: "venue", added };
  }

  /** The probe never landed. What we hold is still an answer: the recent window
   *  for a "recent" read, the older candles we have actually mirrored for a
   *  backfill read. A short backfill is reported as a mirror page, not as the end
   *  of history — the client must be able to tell "we have not mirrored that
   *  deep" from "the exchange has nothing older". */
  function fromMirror(key, symbol, interval, limit, endTime, background, lastErr) {
    // This window is refused right now. Give it a cool-off so the next reads
    // — and the next refresh tick — answer from the mirror instead of
    // queueing another doomed probe behind it.
    coolWindow(symbol, interval);
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
  }

  /** Could an older page for this window actually be fetched right now? While
   *  the venue refuses it (window cool-off) or refuses everything (circuit), the
   *  answer is no — and the client should not spend a round trip finding out. */
  function canGoOlder(symbol, interval) {
    return !windowCooling(symbol, interval) && !backgroundShouldWait();
  }

  /** What the lane has done, for the tests that assert a client request really
   *  did overtake queued background work rather than merely being faster. */
  function laneStats() {
    return {
      hi: lane.hi,
      bg: lane.bg,
      // Sends that went out for a client while background work was waiting: the
      // yield, counted.
      yielded: lane.yielded,
      expired: lane.expired,
      queued: { hi: hiQueue.length, bg: bgQueue.length },
      busy: !!slot,
    };
  }

  return { fetchKlines, canGoOlder, laneStats, stop };
}

/**
 * One upstream kline call. Bybit answers newest-first with string prices, so
 * chronological order and the envelope shape are normalised here — clients
 * never see the venue's ordering.
 */
async function fetchFromVenue(symbol, interval, limit, endTime, timeoutMs, logger) {
  const params = new URLSearchParams({
    category: "spot",
    symbol,
    interval: APP_TO_BYBIT[interval],
    limit: String(limit),
  });
  // Optional backfill window: candles strictly before `endTime` (ms).
  if (endTime) params.set("end", String(endTime));
  // One host per attempt: the lane's cool-offs are what pace retries, so a
  // blocked venue must not cost one send per alternate inside a single probe.
  // A host that refuses the connection, hangs, or answers with a block page
  // instead of JSON is skipped for a while; the next attempt goes to the next
  // official host until one answers, and that host then stays in use.
  const idx = pickVenueHost();
  let j;
  try {
    const r = await fetch(`${BYBIT_HOSTS[idx]}/v5/market/kline?${params}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CryptoTerminal/1.0)" },
    });
    if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);
    j = await r.json();
  } catch (err) {
    hostBlockedUntil[idx] = Date.now() + HOST_BLOCK_MS;
    venueHostIndex = (idx + 1) % BYBIT_HOSTS.length;
    throw err;
  }
  venueHostIndex = idx;
  hostBlockedUntil[idx] = 0;
  if (j.retCode !== 0) throw new Error(j.retMsg || `Bybit error ${j.retCode}`);
  const list = j.result?.list;
  if (!Array.isArray(list)) throw new Error("No kline data");
  const ms = intervalMs(interval);
  const now = Date.now();
  // Bybit returns newest-first; reverse for chronological order
  const out = [];
  let rejected = 0;
  for (const c of list.reverse()) {
    const openTime = Number(c[0]);
    const candle = {
      interval,
      openTime,
      closeTime: openTime + ms - 1,
      open: String(c[1]),
      high: String(c[2]),
      low: String(c[3]),
      close: String(c[4]),
      volume: String(c[5]),
      // The last row of every window is the candle still forming. Labelling it
      // closed makes the client treat a partial bar as final and let a REST
      // refresh rewind the live one.
      closed: openTime + ms <= now,
    };
    // The same predicate the mirror applies on the way in, so a row the store
    // would refuse never reaches a chart either. An absent bar is a hole the
    // window reports; a repaired one would be invented market data.
    if (toValidTuple(candle, interval)) out.push(candle);
    else rejected += 1;
  }
  if (rejected && logger) {
    logger.warn("bybit kline rows rejected", { symbol, interval, rejected, of: list.length });
  }
  return out;
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
  // Every subject the bridge subscribes to is tracked so that an instrument
  // refresh can tear down the ones for delisted pairs. Without this the bus
  // accumulates listeners for symbols that no longer exist, and each one is
  // still invoked on every broadcast — the progressive leak behind the
  // terminal's slowdown during extended sessions.
  const bridged = new Set();
  const bridgeListeners = new Map(); // symbol -> [{ subject, listener }]

  function bridge(symbol) {
    if (bridged.has(symbol)) return;
    bridged.add(symbol);
    const entries = [];
    for (const venue of venues) {
      const subs = [
        [subject(venue, symbol, "orderbook.snapshot"), (e) => hub.broadcastSnapshot("orderbook", symbol, e.ts, e)],
        [subject(venue, symbol, "orderbook.delta"),   (e) => hub.broadcastDelta("orderbook", symbol, e.ts, e)],
        [subject(venue, symbol, "trades"),            (e) => hub.broadcastEvent("trade", "trades", symbol, e.ts, e)],
        [subject(venue, symbol, "ticker"),            (e) => hub.broadcastEvent("ticker", "ticker", symbol, e.ts, e)],
      ];
      for (const iv of INTERVALS) {
        subs.push([subject(venue, symbol, `kline.${iv}`), (e) => {
          hub.broadcastKline(symbol, e.ts, e);
          // append is async: the first tick for a cold window reads the mirror
          // file off the event loop instead of stalling this callback.
          void klinesStore.append(symbol, iv, e);
        }]);
      }
      for (const [subj, fn] of subs) {
        bus.on(subj, fn);
        entries.push({ subject: subj, listener: fn });
      }
    }
    bridgeListeners.set(symbol, entries);
  }

  function unbridge(symbol) {
    if (!bridged.has(symbol)) return;
    bridged.delete(symbol);
    const entries = bridgeListeners.get(symbol);
    if (entries) {
      for (const { subject: subj, listener: fn } of entries) {
        bus.removeListener(subj, fn);
      }
      bridgeListeners.delete(symbol);
    }
  }

  /** Re-run after instrument discovery: adds listeners for new symbols and
   *  removes ones for pairs that were delisted since the last pass. */
  function syncBridge() {
    const current = new Set(instruments.symbols);
    for (const sym of [...bridged]) {
      if (!current.has(sym)) unbridge(sym);
    }
    for (const sym of current) bridge(sym);
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
        // Whether the newest bar still reaches the present. `source: "mirror"`
        // says this page is what we last had, but only this says how long ago
        // "last" was — and a chart painted from a window that stopped days ago
        // has to be able to say so instead of drawing a frozen edge as if it
        // were now.
        current: p.current,
        // The newest run of bars the window should hold and does not, or null.
        // A hole is invisible on a continuous time axis: the two candles either
        // side of an outage sit next to each other and the chart simply looks
        // like a market that moved fast. This is the only place the absence is
        // recorded, so a client can tell the user what it is about to paint.
        gap: p.gap,
        // `gap` is what the crawl fetches next; this is the whole shortfall —
        // every absent bar and every separate run. Quoting only `gap.bars` read
        // as "short by 4" for a 1 m window missing 7,791 bars in 7 runs.
        missing: p.missing,
      },
    };
  }

  server.on("request", async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    if (req.method !== "GET") { cors(res, 405, { error: "method_not_allowed" }); return; }

    if (u.pathname === "/healthz") {
      await respond(req, res, 200, { ok: true, venue: venues[0], instruments: instruments.symbols.length, source: instruments.source });
      return;
    }

    if (u.pathname === "/api/symbols") {
      await respond(req, res, 200, { data: { venue: venues[0], instruments: instruments.list() } });
      return;
    }

    if (u.pathname === "/api/klines") {
      const sym = parseSymbol(u.searchParams.get("symbol"));
      if (!sym) { cors(res, 400, { error: "BAD_SYMBOL" }); return; }
      if (!instruments.usable(sym)) {
        // A structurally valid pair the cached registry does not know is not a
        // broken client: the registry on disk can be hours old, and `usable` is
        // deliberately permissive while hydration is still running. Give it one
        // bounded, de-duplicated discovery pass before refusing, and refuse with
        // the same envelope as before if the venue still does not list it.
        const found = await instruments.resolve(sym);
        if (!found) { cors(res, 404, { error: "UNKNOWN_SYMBOL", symbol: sym }); return; }
      }
      const iv = parseInterval(u.searchParams.get("interval") ?? "1m");
      if (!iv) { cors(res, 400, { error: "BAD_INTERVAL", allowed: INTERVALS }); return; }
      const lim = parseLimit(u.searchParams.get("limit"));
      if (lim === null) { cors(res, 400, { error: "BAD_LIMIT" }); return; }
      const end = parseEndTime(u.searchParams.get("endTime"));
      if (!end.ok) { cors(res, 400, { error: "BAD_END_TIME" }); return; }
      try {
        // The window's bytes come off disk *before* anything reads them, so the
        // event loop stays free while a cold window is restored: an evicted
        // window used to be gunzip'd synchronously inside the request.
        await klinesStore.warm(sym, iv);
        const page = await fetchKlines(sym, iv, lim, end.value);
        await respond(req, res, 200, { data: page.data, meta: pageMeta(sym, iv, page) },
          `klines|${sym}|${iv}|${lim}|${end.value ?? ""}`);
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
  // client -> Map<"SYMBOL|interval", [symbol, interval]>. Keyed by the pair, not
  // the symbol: a client may watch one symbol on several intervals at once (two
  // panels, or a timeframe switch whose unsubscribe lands after the new subscribe),
  // and an unsubscribe for one interval must never drop another.
  const clientKline = new Map();
  const klineKey = (sym, iv) => `${sym}|${iv}`;

  /** Push the current demand into the collector: orderbook/trades follow the
   *  symbol each client selected, klines the exact (symbol, interval) pairs.
   *  The venue's heavy streams stay closed until a client actually asks. */
  function syncDetail() {
    const syms = new Set(clientSym.values());
    const pairs = [];
    for (const m of clientKline.values()) {
      for (const [sym, iv] of m.values()) pairs.push([sym, iv]);
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
      for (const [sym, iv] of m.values()) out.set(klineKey(sym, iv), [sym, iv]);
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

  /** A pair the registry does not know is refused on the websocket — but the
   *  message path cannot await a venue round trip (a client that sends five
   *  subscriptions expects five answers, in order), so the registry is asked in
   *  the background instead. `resolve` is de-duplicated and cooldown-bounded, so
   *  a client retrying a typo costs one live call per cooldown rather than one
   *  per message, and the retry after a real listing succeeds because the list
   *  has landed. */
  function askInstruments(sym) {
    instruments.resolve(sym).catch(() => false);
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
          if (!instruments.usable(sym)) { askInstruments(sym); rejectSymbol(client, sym); continue; }
          let iv;
          if (ch.channel === "kline") {
            iv = parseInterval(ch.interval);
            if (!iv) { sendError(client, "BAD_INTERVAL", `unknown interval: ${String(ch.interval ?? "").slice(0, 16)}`); continue; }
          }
          hub.subscribe(client, ch.channel, sym, iv);
          if (iv) {
            let m = clientKline.get(client);
            if (!m) { m = new Map(); clientKline.set(client, m); }
            m.set(klineKey(sym, iv), [sym, iv]);
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
            clientKline.get(client)?.delete(klineKey(sym, iv));
          }
          hub.unsubscribe(client, ch.channel, sym, iv);
        }
        syncDetail();
      } else if (msg.type === "select_symbol" && msg.symbol) {
        const sym = parseSymbol(msg.symbol);
        if (!sym) { sendError(client, "BAD_REQUEST", "invalid symbol"); return; }
        if (!instruments.usable(sym)) { askInstruments(sym); rejectSymbol(client, sym); return; }
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

  /** Everything background-ish that could still hold a socket or the lane:
   *  the refresh tick, the crawl's pending pages, and the lane's parked retries.
   *  Idempotent — both the wss and the http server fire `close`. */
  const stopServing = () => {
    stopKlineRefresh();
    historyCrawl.stop();
    fetcher.stop();
    hub.stop();
  };
  wss.on("close", stopServing);
  server.on("close", stopServing);

  return {
    server,
    hub,
    syncBridge,
    klines: klinesStore,
    klineCrawler: historyCrawl,
    // Who the upstream lane has been serving: `{ hi, bg, yielded }`, so the
    // priority rule the lane exists for is observable instead of assumed.
    klineLane: fetcher.laneStats,
  };
}

/** Protocol error envelope: `{ code, message }` (see docs/PROTOCOL.md). Clients
 *  surface these as toasts, so `code` stays stable and machine-readable. */
function sendError(c, code, message, extra) {
  c.send({ type: "error", ts: Date.now(), data: { code, message, ...extra } });
}
