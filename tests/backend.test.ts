// Backend unit tests: instrument metadata, hub subscription lifecycle,
// ticker normalisation and the gateway's REST/WebSocket validation rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Instruments, decimalsOf, normalizeInstruments } from "../backend/src/instruments.js";
import { fallbackInstruments, fallbackSymbols } from "../backend/src/symbols.js";
import { Hub } from "../backend/src/gateway/hub.js";
import { subject } from "../backend/src/bus.js";
import { normalizeTicker } from "../backend/src/collector/tickers.js";
import { createGateway } from "../backend/src/gateway/server.js";

const silentLogger = { info() {}, warn() {}, error() {} };

/** Collects everything a fake client is sent so protocol behaviour is assertable. */
function fakeClient() {
  const sent = [];
  return { sent, send: (env) => { sent.push(env); return true; } };
}
const types = (c) => c.sent.map((e) => e.type);

/* ── instruments ─────────────────────────────────────────────────────── */

test("instruments: tick size and base precision imply decimal counts", () => {
  assert.equal(decimalsOf("0.01"), 2);
  assert.equal(decimalsOf("0.0000001"), 7);
  assert.equal(decimalsOf("1"), 0);
  assert.equal(decimalsOf(undefined), null);
  assert.equal(decimalsOf("0.1e2"), null);
});

test("instruments: only active USDT pairs with usable precision survive normalisation", () => {
  const list = [
    { symbol: "btcusdt", baseCoin: "btc", quoteCoin: "USDT", status: "Trading",
      priceFilter: { tickSize: "0.01" }, lotSizeFilter: { basePrecision: "0.001" } },
    { symbol: "ETHUSDT", baseCoin: "ETH", quoteCoin: "USDT", status: "Trading",
      priceFilter: { tickSize: "0.0001" }, lotSizeFilter: { basePrecision: "0.00001" } },
    { symbol: "BTCBTC", baseCoin: "BTC", quoteCoin: "BTC", status: "Trading",
      priceFilter: { tickSize: "0.01" }, lotSizeFilter: { basePrecision: "0.001" } },
    { symbol: "OLDUSDT", baseCoin: "OLD", quoteCoin: "USDT", status: "Settling",
      priceFilter: { tickSize: "0.01" }, lotSizeFilter: { basePrecision: "0.001" } },
    { symbol: "BADUSDT", baseCoin: "BAD", quoteCoin: "USDT", status: "Trading",
      priceFilter: {}, lotSizeFilter: {} },
  ];
  const out = normalizeInstruments(list);
  assert.deepEqual(out.map((i) => i.symbol), ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(out[0], { symbol: "BTCUSDT", baseCoin: "BTC", priceDecimals: 2, qtyDecimals: 3 });
  assert.deepEqual(normalizeInstruments(null), []);
});

test("instruments: registry lookup is case-insensitive and restrict() defaults unknown pairs", () => {
  const inst = new Instruments({ logger: silentLogger, quote: "USDT" });
  inst.replace([{ symbol: "BTCUSDT", baseCoin: "BTC", priceDecimals: 1, qtyDecimals: 6 }], "test");
  assert.equal(inst.has("btcusdt"), true);
  assert.equal(inst.get("BTCUSDT").priceDecimals, 1);
  assert.equal(inst.symbols.length, 1);

  let changed = 0;
  inst.onChange = () => { changed += 1; };
  inst.restrict(["btcusdt", "NEWUSDT"]);
  assert.equal(changed, 1, "replace() notifies the gateway so it bridges new symbols");
  assert.deepEqual(inst.symbols, ["BTCUSDT", "NEWUSDT"]);
  assert.equal(inst.get("NEWUSDT").baseCoin, "NEW");
  assert.equal(inst.get("NEWUSDT").priceDecimals, 4);
  assert.equal(inst.source, "override");
});

/** Swap only the venue calls, so a registry test cannot reach the network. */
async function withVenue<T>(reply: (url: string) => unknown, run: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = async (input: unknown) =>
    String(input).includes("api.bybit.com")
      ? ({ ok: true, status: 200, json: async () => reply(String(input)) } as unknown as Response)
      : (prev(input as never) as unknown as Promise<Response>);
  try { return await run(); } finally { globalThis.fetch = prev; }
}

const venueList = (symbols: string[]) => ({
  retCode: 0,
  result: {
    list: symbols.map((symbol) => ({
      symbol, baseCoin: symbol.replace(/USDT$/, ""), quoteCoin: "USDT", status: "Trading",
      priceFilter: { tickSize: "0.01" }, lotSizeFilter: { basePrecision: "0.001" },
    })),
  },
});

test("instruments: a stale registry resolves an unlisted pair instead of refusing it", async () => {
  // A pair listed after the cached snapshot was written is not a bad client, and
  // `/api/klines` must not 404 on the strength of an hours-old file.
  const inst = new Instruments({ logger: silentLogger, quote: "USDT" });
  inst.replace([{ symbol: "BTCUSDT", baseCoin: "BTC", priceDecimals: 1, qtyDecimals: 6 }], "cache");
  assert.equal(inst.usable("NEWUSDT"), false, "a ready registry does not wave unknown pairs through");
  const asked: string[] = [];
  const found = await withVenue((url) => { asked.push(url); return venueList(["BTCUSDT", "NEWUSDT"]); },
    () => inst.resolve("NEWUSDT"));
  assert.equal(found, true, "the discovery pass landed the pair");
  assert.equal(inst.usable("NEWUSDT"), true, "and the registry knows it afterwards");
  assert.equal(asked.length, 1, "one live call, not one per lookup");

  // Still unknown after a real answer is a genuine unknown — and the cooldown
  // keeps a client retrying a typo from becoming a fetch per request.
  const miss = await withVenue(() => venueList(["BTCUSDT"]), () => inst.resolve("NOPEUSDT"));
  assert.equal(miss, false);
  const second = await withVenue(() => venueList(["BTCUSDT"]), () => inst.resolve("NOPEUSDT"));
  assert.equal(second, false, "the cooldown answers the second lookup without a fetch");
});

test("instruments: a registry that is still hydrating refuses nothing", async () => {
  // Boot ordering: the port is open before the list is, and "not yet looked" is
  // no authority to reject a well-formed symbol.
  const inst = new Instruments({ logger: silentLogger, quote: "USDT" });
  inst.replace([{ symbol: "BTCUSDT", baseCoin: "BTC", priceDecimals: 1, qtyDecimals: 6 }], "cache");
  inst.ready = false;
  assert.equal(inst.usable("ETHUSDT"), true, "mid-hydration: serve it and let the fetch fill in");
  assert.equal(inst.usable("btcusdt"), true, "case normalisation is not lost on the permissive path");
  inst.ready = true;
  assert.equal(inst.usable("ETHUSDT"), false, "hydrated: the registry is authoritative again");

  // A registry that never came from the venue (a test fixture, an operator
  // override) has no wider list to discover into, so `resolve` must not go out.
  const fixture = new Instruments({ logger: silentLogger, quote: "USDT" });
  fixture.replace([{ symbol: "BTCUSDT", baseCoin: "BTC", priceDecimals: 1, qtyDecimals: 6 }], "test");
  let sent = 0;
  const out = await withVenue(() => { sent += 1; return venueList(["SOMETHINGUSDT"]); }, () => fixture.resolve("SOMETHINGUSDT"));
  assert.equal(out, false);
  assert.equal(sent, 0, "no live discovery for a fixture registry");
});

test("instruments: the bundled fallback snapshot is self-consistent", () => {  assert.ok(fallbackInstruments.length > 100, "fallback list should cover the venue");
  assert.deepEqual(fallbackSymbols, fallbackInstruments.map((i) => i.symbol));
  for (const i of fallbackInstruments.slice(0, 25)) {
    assert.match(i.symbol, /^[A-Z0-9]{3,20}$/);
    assert.ok(Number.isInteger(i.priceDecimals) && i.priceDecimals >= 0 && i.priceDecimals <= 8);
    assert.ok(Number.isInteger(i.qtyDecimals) && i.qtyDecimals >= 0 && i.qtyDecimals <= 8);
  }
});

/* ── ticker normalisation ────────────────────────────────────────────── */

test("tickers: venue ratio is converted to a percent and strings stay strings", () => {
  const t = normalizeTicker("bybit", {
    symbol: "BTCUSDT", lastPrice: "65000.1", bid1Price: "65000", ask1Price: "65001",
    price24hPcnt: "0.0234", highPrice24h: "66000", lowPrice24h: "63000",
    volume24h: "1234.5", turnover24h: "8e7",
  }, 1_700_000_000_000);
  assert.equal(t.symbol, "BTCUSDT");
  assert.equal(t.lastPrice, "65000.1");
  assert.equal(t.change24h, "2.34", "0.0234 fraction becomes 2.34 percent");
  assert.equal(t.bidPrice, "65000");
  assert.equal(t.askPrice, "65001");
  assert.equal(t.ts, 1_700_000_000_000);
});

test("tickers: the streaming ticker has no bid/ask, so none is invented", () => {
  const t = normalizeTicker("bybit", { symbol: "ETHUSDT", lastPrice: "3000", price24hPcnt: "-0.01" });
  assert.equal(t.change24h, "-1");
  assert.equal("bidPrice" in t, false, "a fake zero best-bid would read as a zero spread");
  assert.equal("askPrice" in t, false);
  assert.equal(typeof t.ts, "number", "envelope ts is always numeric for staleness tracking");
});

/* ── hub lifecycle ───────────────────────────────────────────────────── */

test("hub: a late kline subscriber is replayed the cached history", () => {
  const hub = new Hub(silentLogger);
  const early = fakeClient();
  hub.register(early);
  hub.subscribe(early, "kline", "BTCUSDT", "1m");
  hub.broadcastKline("BTCUSDT", 1, { interval: "1m", openTime: 1, close: "1" });
  hub.broadcastKline("BTCUSDT", 2, { interval: "1m", openTime: 2, close: "2" });
  // The venue repeats a forming candle until it closes, so the newest tick is the
  // truth for that bar and the cache is bounded by bars rather than by ticks.
  hub.broadcastKline("BTCUSDT", 3, { interval: "1m", openTime: 2, close: "2.5" });

  const late = fakeClient();
  hub.register(late);
  hub.subscribe(late, "kline", "BTCUSDT", "1m");
  assert.deepEqual(types(late), ["kline_snapshot"], "one collapsed frame, not one replay per cached tick");
  const snap = late.sent[0];
  assert.equal(snap.seq, 3, "at the topic's newest seq, so the next live kline is exactly seq+1");
  assert.equal(snap.data.interval, "1m", "on the frame: that is where the client's gap test reads the interval");
  assert.deepEqual(snap.data.candles.map((k) => [k.openTime, k.close]), [[1, "1"], [2, "2.5"]],
    "oldest first, with the forming bar collapsed to its last tick");
  hub.stop();
});

test("hub: orderbook snapshot for a new subscriber carries the current seq", () => {
  const hub = new Hub(silentLogger);
  const watcher = fakeClient();
  hub.register(watcher);
  hub.subscribe(watcher, "orderbook", "BTCUSDT");
  hub.broadcastSnapshot("orderbook", "BTCUSDT", 1, { bids: [["100", "1"]], asks: [["101", "2"]] });
  hub.broadcastDelta("orderbook", "BTCUSDT", 2, { bids: [["100", "0"]], asks: [["102", "1"]] });

  // Joining after two messages must reproduce the *current* book, not the
  // original snapshot, and at the current seq so deltas line up.
  const late = fakeClient();
  hub.register(late);
  hub.subscribe(late, "orderbook", "BTCUSDT");
  assert.equal(late.sent.length, 1);
  const snap = late.sent[0];
  assert.equal(snap.type, "orderbook_snapshot");
  assert.equal(snap.seq, 2);
  assert.deepEqual(snap.data.bids, []);
  assert.deepEqual(snap.data.asks, [["101", "2"], ["102", "1"]]);
  hub.stop();
});

test("hub: a sparse ticker value is replayed to subscribers immediately", () => {
  const hub = new Hub(silentLogger);
  hub.broadcastEvent("ticker", "ticker", "SOLUSDT", Date.now(), { lastPrice: "150" });
  const late = fakeClient();
  hub.register(late);
  hub.subscribe(late, "ticker", "SOLUSDT");
  assert.deepEqual(types(late), ["ticker"]);
  hub.stop();
});

test("hub: disconnecting a client prunes its topic sets", () => {
  const hub = new Hub(silentLogger);
  const c = fakeClient();
  hub.register(c);
  hub.subscribe(c, "ticker", "BTCUSDT");
  hub.subscribe(c, "kline", "BTCUSDT", "1m");
  assert.equal(hub.subs.size, 2);
  hub.unregister(c);
  assert.equal(hub.subs.size, 0, "no audience-less topics may linger");
  assert.equal(hub.clients.size, 0);
  hub.stop();
});

test("hub: sweep drops idle books and stale one-shot values", () => {
  const hub = new Hub(silentLogger, { bookTtlMs: 0, latestTtlMs: 0 });
  const c = fakeClient();
  hub.register(c);
  hub.subscribe(c, "orderbook", "BTCUSDT");
  hub.broadcastSnapshot("orderbook", "BTCUSDT", 1, { bids: [], asks: [] });
  hub.broadcastEvent("ticker", "ticker", "BTCUSDT", 1, { lastPrice: "1" });

  // The subscriber still watches the book, so it survives; the ticker topic is
  // audience-less and its value is older than the (zero) TTL.
  hub.unsubscribe(c, "ticker", "BTCUSDT");
  hub.sweep();
  assert.equal(hub.books.size, 1);
  assert.equal(hub.latest.has("ticker:BTCUSDT"), false);

  hub.unsubscribe(c, "orderbook", "BTCUSDT");
  hub.sweep();
  assert.equal(hub.books.size, 0);
  hub.stop();
});

test("hub: kline history is capped per topic and LRU across topics", () => {
  const hub = new Hub(silentLogger);
  hub.subscribe(fakeClient(), "kline", "BTCUSDT", "1m");
  for (let i = 0; i < 520; i++) hub.broadcastKline("BTCUSDT", i, { interval: "1m", openTime: i, close: "1" });
  assert.equal(hub.klineHistory.get("kline:BTCUSDT:1m").bars.size, 500, "the replay is capped by bars, not ticks");

  for (let i = 0; i < 300; i++) {
    hub.broadcastKline(`SYM${i}USDT`, i, { interval: "1m", openTime: i, close: "1" });
  }
  hub.sweep();
  assert.ok(hub.klineHistory.size <= 256, `kline topics must not grow without bound (${hub.klineHistory.size})`);
  hub.stop();
});

test("bus: subject naming follows the NATS-compatible market shape", () => {
  assert.equal(subject("bybit", "BTCUSDT", "ticker"), "market.bybit.BTCUSDT.ticker");
});

/* ── gateway: REST + WebSocket protocol ──────────────────────────────── */

function testInstruments() {
  const inst = new Instruments({ logger: silentLogger, quote: "USDT" });
  inst.replace([
    { symbol: "BTCUSDT", baseCoin: "BTC", priceDecimals: 1, qtyDecimals: 6 },
    { symbol: "ETHUSDT", baseCoin: "ETH", priceDecimals: 2, qtyDecimals: 5 },
  ], "test");
  return inst;
}

async function startGateway() {
  const instruments = testInstruments();
  const { server, hub } = createGateway(instruments, ["bybit"], silentLogger, null);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    instruments,
    hubTopics: () => hub.subs.size,
    async close() {
      await new Promise((r) => server.close(r));
      hub.stop();
    },
  };
}

async function openSocket(base) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  const messages = [];
  ws.addEventListener("message", (ev) => messages.push(JSON.parse(ev.data)));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return { ws, messages };
}

/** Wait until a matching envelope arrives — the socket is asynchronous. */
async function waitFor(base, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = base.messages.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for message; saw ${JSON.stringify(base.messages.map((m) => m.type))}`);
}

const errCode = (m) => (m.type === "error" ? m.data.code : null);

test("gateway: REST refuses non-GET and answers OPTIONS with CORS", async () => {
  const g = await startGateway();
  try {
    const post = await fetch(`${g.base}/api/symbols`, { method: "POST" });
    assert.equal(post.status, 405);
    const opt = await fetch(`${g.base}/api/symbols`, { method: "OPTIONS" });
    assert.equal(opt.status, 204);
    assert.equal(opt.headers.get("access-control-allow-origin"), "*");
  } finally { await g.close(); }
});

test("gateway: health and symbol endpoints expose the live instrument registry", async () => {
  const g = await startGateway();
  try {
    const health = await (await fetch(`${g.base}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.venue, "bybit");
    assert.equal(health.instruments, 2);

    const symbols = await (await fetch(`${g.base}/api/symbols`)).json();
    assert.deepEqual(symbols.data.instruments.map((i) => i.symbol), ["BTCUSDT", "ETHUSDT"]);
    assert.equal(symbols.data.instruments[0].priceDecimals, 1);
  } finally { await g.close(); }
});

test("gateway: /api/klines validates every query parameter before touching the venue", async () => {
  const g = await startGateway();
  try {
    const cases = [
      ["", 400, "BAD_SYMBOL"],
      ["symbol=BTC%20USDT", 400, "BAD_SYMBOL"],
      ["symbol=DOGEUSDT", 404, "UNKNOWN_SYMBOL"],
      ["symbol=BTCUSDT&interval=2m", 400, "BAD_INTERVAL"],
      ["symbol=BTCUSDT&limit=abc", 400, "BAD_LIMIT"],
      ["symbol=BTCUSDT&endTime=-5", 400, "BAD_END_TIME"],
      ["symbol=BTCUSDT;echo=1", 400, "BAD_SYMBOL"],
    ];
    for (const [qs, status, code] of cases) {
      const r = await fetch(`${g.base}/api/klines?${qs}`);
      const body = await r.json();
      assert.equal(r.status, status, qs);
      assert.equal(body.error, code, qs);
    }
  } finally { await g.close(); }
});

test("gateway: unknown REST path is a 404, not a crash", async () => {
  const g = await startGateway();
  try {
    assert.equal((await fetch(`${g.base}/api/nope`)).status, 404);
  } finally { await g.close(); }
});

test("ws: connect is answered with the instrument list including precision metadata", async () => {
  const g = await startGateway();
  const s = await openSocket(g.base);
  try {
    const env = await waitFor(s, (m) => m.type === "symbols");
    assert.equal(env.data.venue, "bybit");
    assert.deepEqual(env.data.instruments.map((i) => i.symbol), ["BTCUSDT", "ETHUSDT"]);
    assert.equal(env.data.instruments[0].priceDecimals, 1);
  } finally { s.ws.close(); await g.close(); }
});

test("ws: malformed and unknown frames get structured errors", async () => {
  const g = await startGateway();
  const s = await openSocket(g.base);
  try {
    s.ws.send("{not json");
    s.ws.send(JSON.stringify({ type: "nope" }));
    s.ws.send(JSON.stringify({ type: "subscribe", channels: [{ channel: "ticker" }] }));
    s.ws.send(JSON.stringify({ type: "subscribe", channels: [{ channel: "options", symbol: "BTCUSDT" }] }));
    s.ws.send(JSON.stringify({ type: "subscribe", channels: [{ channel: "ticker", symbol: "btc usdt" }] }));
    s.ws.send(JSON.stringify({ type: "subscribe", channels: [{ channel: "ticker", symbol: "DOGEUSDT" }] }));
    s.ws.send(JSON.stringify({ type: "subscribe", channels: [{ channel: "kline", symbol: "BTCUSDT" }] }));

    const expected = ["BAD_JSON", "BAD_REQUEST", "BAD_REQUEST", "BAD_CHANNEL", "UNKNOWN_SYMBOL", "UNKNOWN_SYMBOL", "BAD_INTERVAL"];
    // (the two BAD_REQUESTs are the unknown type and the channel-less subscribe)
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && s.messages.filter((m) => m.type === "error").length < expected.length) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const codes = s.messages.filter((m) => m.type === "error").map((m) => m.data.code);
    assert.deepEqual(codes, expected);
    for (const m of s.messages.filter((x) => x.type === "error")) {
      assert.equal(typeof m.data.message, "string");
      assert.ok(m.ts > 0);
    }
  } finally { s.ws.close(); await g.close(); }
});

test("ws: a rejected symbol never creates a subscription", async () => {
  const g = await startGateway();
  const s = await openSocket(g.base);
  try {
    s.ws.send(JSON.stringify({ type: "subscribe", channels: [{ channel: "ticker", symbol: "HACKUSDT" }] }));
    await waitFor(s, (m) => errCode(m) === "UNKNOWN_SYMBOL");
    assert.equal(g.hubTopics(), 0);
  } finally { s.ws.close(); await g.close(); }
});

test("ws: ping is answered and select_symbol rejects symbols the venue does not list", async () => {
  const g = await startGateway();
  const s = await openSocket(g.base);
  try {
    s.ws.send(JSON.stringify({ type: "ping" }));
    await waitFor(s, (m) => m.type === "pong");
    s.ws.send(JSON.stringify({ type: "select_symbol", symbol: "not a symbol" }));
    await waitFor(s, (m) => errCode(m) === "BAD_REQUEST");
    s.ws.send(JSON.stringify({ type: "select_symbol", symbol: "DOGEUSDT" }));
    await waitFor(s, (m) => errCode(m) === "UNKNOWN_SYMBOL");
    const errorsBefore = s.messages.filter((m) => m.type === "error").length;
    s.ws.send(JSON.stringify({ type: "select_symbol", symbol: "ethusdt" }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(s.messages.filter((m) => m.type === "error").length, errorsBefore, "a known symbol must be accepted");
  } finally { s.ws.close(); await g.close(); }
});

test("ws: subscribing to a symbol streams bus traffic and close releases it", async () => {
  const g = await startGateway();
  const s = await openSocket(g.base);
  try {
    s.ws.send(JSON.stringify({ type: "subscribe", channels: [{ channel: "ticker", symbol: "BTCUSDT" }] }));
    await waitFor(s, (m) => m.type === "symbols");
    const { bus, subject: subj } = await import("../backend/src/bus.js");
    bus.pub(subj("bybit", "BTCUSDT", "ticker"), { ts: Date.now(), symbol: "BTCUSDT", lastPrice: "65000" });
    const env = await waitFor(s, (m) => m.type === "ticker");
    assert.equal(env.data.lastPrice, "65000");
    assert.equal(typeof env.seq, "number");

    s.ws.send(JSON.stringify({ type: "unsubscribe", channels: [{ channel: "ticker", symbol: "BTCUSDT" }] }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(g.hubTopics(), 0, "unsubscribe must not leave an audience-less topic behind");
  } finally { s.ws.close(); await g.close(); }
});

test("ws: kline unsubscribe requires a valid interval, otherwise the topic stays live", async () => {
  const g = await startGateway();
  const s = await openSocket(g.base);
  try {
    s.ws.send(JSON.stringify({ type: "subscribe", channels: [{ channel: "kline", symbol: "BTCUSDT", interval: "1m" }] }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(g.hubTopics(), 1);

    s.ws.send(JSON.stringify({ type: "unsubscribe", channels: [{ channel: "kline", symbol: "BTCUSDT", interval: "7x" }] }));
    await waitFor(s, (m) => errCode(m) === "BAD_INTERVAL");
    assert.equal(g.hubTopics(), 1, "a bad interval must not silently drop the wrong topic");

    s.ws.send(JSON.stringify({ type: "unsubscribe", channels: [{ channel: "kline", symbol: "BTCUSDT", interval: "1m" }] }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(g.hubTopics(), 0);
  } finally { s.ws.close(); await g.close(); }
});
