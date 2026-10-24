import http from "node:http";
import { WebSocketServer } from "ws";
import { Hub } from "./hub.js";
import { INTERVALS, intervalMs } from "../intervals.js";
import { createKlinesStore } from "./klinesStore.js";
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
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
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
/** One window must cost the browser seconds, not tens of them: it blocks on
 *  this request, and past the budget the gateway answers from its own cache. */
const KLINES_ATTEMPTS = 3;
const KLINES_ATTEMPT_TIMEOUT_MS = 4000;
const KLINES_BUDGET_MS = 7000;

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
 */
function createKlinesFetcher({ store, logger }) {
  const cache = new Map(); // key -> { at, data }
  const inflight = new Map(); // key -> Promise
  let tail = Promise.resolve(); // serializes outbound Bybit requests
  let lastOut = 0;
  let circuitUntil = 0;
  let circuitErr = null; // why the cool-off was opened, for the first request inside it

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

  function fetchKlines(symbol, interval, limit, endTime) {
    const key = `${symbol}|${interval}|${limit}|${endTime || ""}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < KLINES_CACHE_TTL_MS) return Promise.resolve(hit.data);
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
          cache.set(key, { at: Date.now(), data });
          trimCache();
          // Only the window ending "now" is a usable fallback; an older
          // backfill page must not overwrite it.
          if (!endTime) store?.remember(symbol, interval, data);
          return data;
        } catch (err) {
          lastErr = err;
          if (/403|429/.test(err.message)) {
            circuitUntil = Date.now() + KLINES_CIRCUIT_MS;
            circuitErr = err;
          } else if (!/fetch failed|timeout|ECONN|socket|abort/i.test(err.message)) throw err;
        }
      }
      // Only the current window can be answered from cache: an older backfill
      // page served from the recent window would be filtered away by the client
      // as "nothing older", silently ending scroll-back at the wrong place.
      const fallback = endTime ? null : store?.candles(symbol, interval, limit);
      const reason = lastErr ?? circuitErr;
      if (fallback && fallback.length) {
        logger.warn("klines served from cache", {
          symbol, interval, err: String(reason?.message ?? reason ?? "budget"),
        });
        return fallback;
      }
      throw reason ?? new Error("Bybit request unavailable");
    }).finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
  }

  return { fetchKlines };
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
 * @param klines       Last-good candle windows (see klinesStore.js); created per
 *                     gateway when the host has no loaded one to pass in
 */
export function createGateway(instruments, venues, logger, collector, klines) {
  const hub = new Hub(logger);
  const server = http.createServer();
  const bridged = new Set();
  const klinesStore = klines ?? createKlinesStore({ logger });
  const fetchKlines = createKlinesFetcher({ store: klinesStore, logger }).fetchKlines;

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
        bus.on(subject(venue, symbol, `kline.${iv}`), (e) => hub.broadcastKline(symbol, e.ts, e));
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
  server.on("request", async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    if (req.method !== "GET") { cors(res, 405, { error: "method_not_allowed" }); return; }

    if (u.pathname === "/healthz") {
      cors(res, 200, { ok: true, venue: venues[0], instruments: instruments.symbols.length, source: instruments.source });
      return;
    }

    if (u.pathname === "/api/symbols") {
      cors(res, 200, { data: { venue: venues[0], instruments: instruments.list() } });
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
        cors(res, 200, { data: await fetchKlines(sym, iv, lim, end.value) });
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
  }

  /** The (symbol, interval) pairs clients are watching, without duplicates. */
  const klineDemand = () => {
    const out = new Map();
    for (const m of clientKline.values()) {
      for (const [sym, iv] of m) out.set(`${sym}|${iv}`, [sym, iv]);
    }
    return [...out.values()];
  };

  // 500 matches the window size the terminal requests on open, so a refresh
  // fills exactly the cache entry the next client request reads.
  const stopKlineRefresh = startKlineWindowRefresh({
    intervalMs: Number(process.env.KLINE_REFRESH_MS || 20000),
    logger,
    demand: klineDemand,
    refreshWindow: async (symbol, interval) => {
      try { await fetchKlines(symbol, interval, 500, null); }
      catch { /* the client's own request is what reports a failure */ }
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

  wss.on("close", () => { stopKlineRefresh(); hub.stop(); });
  server.on("close", () => { stopKlineRefresh(); hub.stop(); });

  return { server, hub, syncBridge, klines: klinesStore };
}

/** Protocol error envelope: `{ code, message }` (see docs/PROTOCOL.md). Clients
 *  surface these as toasts, so `code` stays stable and machine-readable. */
function sendError(c, code, message, extra) {
  c.send({ type: "error", ts: Date.now(), data: { code, message, ...extra } });
}
