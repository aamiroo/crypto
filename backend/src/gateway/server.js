import http from "node:http";
import { WebSocketServer } from "ws";
import { Hub } from "./hub.js";
import { bus, subject } from "../bus.js";

const WS_PATH = "/ws";
const BYBIT_REST = "https://api.bybit.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"];
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

/** Length of one candle in ms; an unknown interval means the 1m default. */
function ivMs(iv) {
  return { "1m": 6e4, "3m": 18e4, "5m": 3e5, "15m": 9e5, "30m": 18e5,
    "1h": 36e5, "4h": 144e5, "1d": 864e5, "1w": 6048e5 }[iv] || 6e4;
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
const klinesCache = new Map(); // key -> { at, data }
const klinesInflight = new Map(); // key -> Promise
let klinesTail = Promise.resolve(); // serializes outbound Bybit requests
let klinesLastOut = 0;
let klinesCircuitUntil = 0;

// Bybit punishes concurrent/rapid REST bursts with HTTP 403. The client can
// legitimately fire several kline requests at once (remounts, timeframe
// switches, older-page loads), so we dedupe identical requests, serve a tiny
// cache, serialize outbound calls with a minimum spacing, and — crucially —
// never *amplify* a rate-limit: after a 403/429 we pause all outbound requests
// for a cool-off window instead of hammering the limiter into a longer ban.
function enqueueKlines(task) {
  const run = klinesTail.then(task, task);
  klinesTail = run.then(() => {}, () => {});
  return run;
}

/** Wait for the shared outbound slot: the cool-off window first, then the
 *  minimum spacing between two Bybit calls. */
async function pauseForBybit() {
  const now = Date.now();
  if (klinesCircuitUntil > now) {
    await new Promise((r) => setTimeout(r, Math.min(klinesCircuitUntil - now, KLINES_CIRCUIT_MS)));
  }
  const since = Date.now() - klinesLastOut;
  if (since < KLINES_MIN_SPACING_MS) {
    await new Promise((r) => setTimeout(r, KLINES_MIN_SPACING_MS - since));
  }
  klinesLastOut = Date.now();
}

/**
 * History for one (symbol, interval, limit, endTime) window. Identical requests
 * share one upstream call, so a client burst costs one round trip; the caller
 * always gets candles, never a Bybit error shape.
 */
function fetchKlines(symbol, interval, limit, endTime) {
  const key = `${symbol}|${interval}|${limit}|${endTime || ""}`;
  const cached = klinesCache.get(key);
  if (cached && Date.now() - cached.at < KLINES_CACHE_TTL_MS) {
    return Promise.resolve(cached.data);
  }
  const inflight = klinesInflight.get(key);
  if (inflight) return inflight;

  const task = enqueueKlines(async () => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      await pauseForBybit();
      try {
        const data = await fetchKlinesOnce(symbol, interval, limit, endTime);
        klinesCircuitUntil = 0;
        klinesCache.set(key, { at: Date.now(), data });
        if (klinesCache.size > KLINES_CACHE_MAX) {
          for (const [k, v] of klinesCache) {
            if (Date.now() - v.at > KLINES_CACHE_TTL_MS) klinesCache.delete(k);
          }
          // Still oversized (a burst of distinct keys): keep the newest entries.
          while (klinesCache.size > KLINES_CACHE_MAX) {
            klinesCache.delete(klinesCache.keys().next().value);
          }
        }
        return data;
      } catch (err) {
        lastErr = err;
        const limited = /403|429/.test(err.message);
        if (limited) klinesCircuitUntil = Date.now() + KLINES_CIRCUIT_MS;
        const retriable = limited || /fetch failed|timeout|ECONN|socket/i.test(err.message);
        if (!retriable || attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr;
  }).finally(() => {
    klinesInflight.delete(key);
  });

  klinesInflight.set(key, task);
  return task;
}

/**
 * One upstream kline call. Bybit answers newest-first with string prices, so
 * chronological order and the envelope shape are normalised here — clients
 * never see the venue's ordering.
 */
async function fetchKlinesOnce(symbol, interval, limit, endTime) {
  const params = new URLSearchParams({
    category: "spot",
    symbol,
    interval: APP_TO_BYBIT[interval],
    limit: String(limit),
  });
  // Optional backfill window: candles strictly before `endTime` (ms).
  if (endTime) params.set("end", String(endTime));
  const r = await fetch(`${BYBIT_REST}/v5/market/kline?${params}`, {
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; CryptoTerminal/1.0)" },
  });
  if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(j.retMsg || `Bybit error ${j.retCode}`);
  const list = j.result?.list;
  if (!Array.isArray(list)) throw new Error("No kline data");
  const ms = ivMs(interval);
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
    closed: true,
  }));
}

/**
 * @param instruments  Instruments registry (live symbol + precision metadata)
 * @param venues       Venues to bridge from the bus
 * @param logger
 * @param collector    Optional collector, synced to whichever symbol a client
 *                     selects (orderbook/trades/kline are heavy, so they are
 *                     only streamed on demand)
 */
export function createGateway(instruments, venues, logger, collector) {
  const hub = new Hub(logger);
  const server = http.createServer();
  const bridged = new Set();

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

  wss.on("close", () => hub.stop());
  server.on("close", () => hub.stop());

  return { server, hub, syncBridge };
}

/** Protocol error envelope: `{ code, message }` (see docs/PROTOCOL.md). Clients
 *  surface these as toasts, so `code` stays stable and machine-readable. */
function sendError(c, code, message, extra) {
  c.send({ type: "error", ts: Date.now(), data: { code, message, ...extra } });
}
