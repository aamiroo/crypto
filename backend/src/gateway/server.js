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

// App interval → Bybit v5 kline interval
const APP_TO_BYBIT = {
  "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
  "1h": "60", "4h": "240", "1d": "D", "1w": "W",
};

function cors(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

function ivMs(iv) {
  return { "1m": 6e4, "3m": 18e4, "5m": 3e5, "15m": 9e5, "30m": 18e5,
    "1h": 36e5, "4h": 144e5, "1d": 864e5, "1w": 6048e5 }[iv] || 6e4;
}

async function fetchKlines(symbol, interval, limit, endTime) {
  // One quick retry: the outbound HTTP proxy occasionally drops a request.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchKlinesOnce(symbol, interval, limit, endTime);
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr;
}

async function fetchKlinesOnce(symbol, interval, limit, endTime) {
  const bybitIv = APP_TO_BYBIT[interval] || "1";
  let url = `${BYBIT_REST}/v5/market/kline?category=spot&symbol=${symbol}&interval=${bybitIv}&limit=${Math.min(limit, 1000)}`;
  // Optional backfill window: candles strictly before `endTime` (ms).
  const end = Number(endTime);
  if (Number.isFinite(end) && end > 0) url += `&end=${Math.floor(end)}`;
  const r = await fetch(url, {
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

export function createGateway(symbols, venues, logger, collector) {
  const hub = new Hub(logger);
  const server = http.createServer();

  /* ── bus → hub bridge ────────────────────────────────────────── */
  for (const venue of venues) {
    for (const sym of symbols) {
      bus.on(subject(venue, sym, "orderbook.snapshot"), (e) => hub.broadcastSnapshot("orderbook", sym, e.ts, e));
      bus.on(subject(venue, sym, "orderbook.delta"),   (e) => hub.broadcastDelta("orderbook", sym, e.ts, e));
      bus.on(subject(venue, sym, "trades"),            (e) => hub.broadcastEvent("trade", "trades", sym, e.ts, e));
      bus.on(subject(venue, sym, "ticker"),            (e) => hub.broadcastEvent("ticker", "ticker", sym, e.ts, e));
      for (const iv of INTERVALS) {
        bus.on(subject(venue, sym, `kline.${iv}`), (e) => hub.broadcastKline(sym, e.ts, e));
      }
    }
  }

  /* ── REST ────────────────────────────────────────────────────── */
  server.on("request", async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    if (u.pathname === "/healthz") { cors(res, 200, { ok: true }); return; }
    if (u.pathname === "/api/klines") {
      try {
        const sym = (u.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
        const iv   = u.searchParams.get("interval") || "1m";
        const lim  = parseInt(u.searchParams.get("limit") || "500", 10);
        const end  = u.searchParams.get("endTime") || undefined;
        cors(res, 200, { data: await fetchKlines(sym, iv, lim, end) });
      } catch (e) {
        logger.error("klines", { err: e.message });
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

  function syncDetail() {
    const syms = new Set(clientSym.values());
    const pairs = [];
    for (const m of clientKline.values()) {
      for (const [sym, iv] of m) pairs.push([sym, iv]);
    }
    collector?.sync([...syms], pairs);
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
    client.send({ type: "symbols", ts: Date.now(), data: symbols });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { sendError(client, "BAD_JSON", "invalid"); return; }
      if (msg.type === "ping") {
        client.send({ type: "pong", ts: Date.now() });
      } else if (msg.type === "subscribe" && Array.isArray(msg.channels)) {
        for (const ch of msg.channels) {
          if (!ch?.channel || !ch?.symbol) { sendError(client, "BAD_REQUEST", "channel and symbol required"); continue; }
          hub.subscribe(client, ch.channel, ch.symbol, ch.interval);
          if (ch.channel === "kline" && ch.interval) {
            let m = clientKline.get(client);
            if (!m) { m = new Map(); clientKline.set(client, m); }
            m.set(ch.symbol.toUpperCase(), ch.interval);
          }
        }
        syncDetail();
      } else if (msg.type === "unsubscribe" && Array.isArray(msg.channels)) {
        for (const ch of msg.channels) {
          if (!ch?.channel || !ch?.symbol) continue;
          hub.unsubscribe(client, ch.channel, ch.symbol, ch.interval);
          if (ch.channel === "kline") clientKline.get(client)?.delete(ch.symbol.toUpperCase());
        }
        syncDetail();
      } else if (msg.type === "select_symbol" && msg.symbol) {
        const nw = msg.symbol.toUpperCase();
        if (clientSym.get(client) === nw) return;
        clientSym.set(client, nw);
        syncDetail();
      }
    });

    ws.on("close", () => {
      const hadSym = clientSym.delete(client);
      const hadKline = clientKline.delete(client);
      if (hadSym || hadKline) syncDetail();
      hub.unregister(client);
      logger.info("ws disconnected");
    });
    ws.on("error", () => hub.unregister(client));
  });

  return { server, hub };
}

function sendError(c, code, message) { c.send({ type: "error", ts: Date.now(), data: { code, message } }); }
