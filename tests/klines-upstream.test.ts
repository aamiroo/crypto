import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, startKlineWindowRefresh } from "../backend/src/gateway/server.js";
import { createKlinesStore, DEPTH_TARGETS, DEFAULT_DEPTH, depthTarget } from "../backend/src/gateway/klinesStore.js";
import { CRAWL_PAGE } from "../backend/src/gateway/klineCrawler.js";
import { Instruments } from "../backend/src/instruments.js";

/**
 * The gateway's /api/klines upstream policy: a venue failure must not empty the
 * chart, must not hang the client, and must not amplify a rate limit.
 */

const silentLogger = { info() {}, warn() {}, error() {} };
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = 1_700_000_000_000;

function instruments() {
  const inst = new Instruments({ logger: silentLogger, quote: "USDT" });
  inst.replace([
    { symbol: "BTCUSDT", baseCoin: "BTC", priceDecimals: 1, qtyDecimals: 6 },
    { symbol: "ETHUSDT", baseCoin: "ETH", priceDecimals: 1, qtyDecimals: 6 },
  ], "test");
  return inst;
}

/** A store with its own window directory. Windows live in one directory per
 *  mirror identity, so a shared path would let one test read another's files —
 *  the counter makes each one unique even inside the same millisecond. */
let storeSeq = 0;
function tmpStore(tag: string, opts: { hotWindows?: number; depthTargets?: Record<string, number> } = {}) {
  storeSeq += 1;
  return createKlinesStore({
    file: join(tmpdir(), `ct-klines-${process.pid}-${storeSeq}-${tag}.json`),
    logger: silentLogger,
    ...opts,
  });
}

function candle(n: number, closed = true) {
  const openTime = BASE + n * MIN;
  return {
    interval: "1m", openTime, closeTime: openTime + MIN - 1,
    open: "100", high: "101", low: "99", close: "100.5", volume: "7", closed,
  };
}

const NOW = Math.floor(Date.now() / MIN) * MIN;
/** A bar `n` minutes before the present. Only a window that still reaches the
 *  present may answer a "what is recent" read once it has been read back from
 *  disk, so the tests that restore one use these instead of the 2023 fixtures. */
function liveCandle(n: number) {
  const openTime = NOW - n * MIN;
  return {
    interval: "1m", openTime, closeTime: openTime + MIN - 1,
    open: "100", high: "101", low: "99", close: "100.5", volume: "7", closed: n >= 1,
  };
}

type StubReply = { ok: boolean; status: number; json(): Promise<unknown> };

/** Intercept the gateway's calls to the venue only — the test's own requests
 *  have to keep reaching the real HTTP server. */
async function withVenueStub<T>(handler: (url: string) => Promise<StubReply>, run: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = async (input: unknown, init?: unknown) =>
    String(input).includes("api.bybit.com")
      ? (handler(String(input)) as unknown as Promise<Response>)
      : (prev(input as never, init as never) as Promise<Response>);
  try { return await run(); } finally { globalThis.fetch = prev; }
}

/** A gateway whose history crawl is switched off. The crawl is background
 *  upstream work on its own timer; a test of the client-facing request path must
 *  not have it racing the stub, and the crawl's own behaviour is tested by
 *  `klines-history.test.ts` and, end to end, below with the real one. */
const noCrawl = { trigger() { return false; }, stop() {} };

async function startGateway(store: ReturnType<typeof createKlinesStore>, crawler = noCrawl) {
  const { server } = createGateway(instruments(), ["bybit"], silentLogger, null, store, crawler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

const blocked = async () => ({ ok: false, status: 403, json: async () => ({}) });

test("gateway: a blocked venue answers from the last good window, not an error", async () => {
  const store = tmpStore("a");
  store.remember("BTCUSDT", "1m", [candle(1), candle(2)]);
  const g = await startGateway(store);
  try {
    let calls = 0;
    // The revalidation runs behind the response, so it has to be observed inside
    // the stub — otherwise the probe escapes to the real venue.
    const r = await withVenueStub(async () => { calls += 1; return blocked(); }, async () => {
      const res = await fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500`);
      await sleep(150);
      return res;
    });
    const body = await r.json() as { data?: unknown[]; error?: string };
    assert.equal(r.status, 200, `expected cache fallback, got ${r.status} ${JSON.stringify(body)}`);
    assert.equal((body.data as unknown[]).length, 2);
    assert.equal(calls, 1, "the cool-off must stop it probing again");
  } finally { await g.close(); }
});

test("gateway: a mirrored window never waits on the venue", async () => {
  const store = tmpStore("g");
  store.remember("BTCUSDT", "1m", [candle(1), candle(2), candle(3)]);
  const g = await startGateway(store);
  try {
    // A venue that hangs rather than refuses is what used to freeze the chart:
    // the client should still get its candles immediately.
    let calls = 0;
    const hang = async () => { calls += 1; await sleep(2000); return blocked(); };
    const started = Date.now();
    const r = await withVenueStub(hang,
      () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500`));
    const elapsed = Date.now() - started;
    const body = await r.json() as { data: unknown[] };
    assert.equal(r.status, 200);
    assert.equal(body.data.length, 3, "answered from the mirror");
    assert.ok(elapsed < 300, `must not block on the hung probe, took ${elapsed}ms`);
    assert.equal(calls, 1, "the background revalidation still ran");
  } finally { await g.close(); }
});

test("gateway: candles streamed since boot are not passed off as venue history", async () => {
  const store = tmpStore("h");
  // Only the websocket tail, no page the exchange ever served.
  store.append("BTCUSDT", "1m", candle(1, false));
  store.append("BTCUSDT", "1m", candle(2, false));
  const g = await startGateway(store);
  try {
    let calls = 0;
    const hang = async () => { calls += 1; await sleep(2000); return blocked(); };
    const started = Date.now();
    const r = await withVenueStub(hang,
      () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500`));
    const elapsed = Date.now() - started;
    const body = await r.json() as { data: unknown[] };
    assert.equal(r.status, 200);
    assert.equal(body.data.length, 2, "the tail still paints the chart, it just is not history");
    assert.ok(elapsed > 900, `must have tried the venue first, took ${elapsed}ms`);
    assert.ok(elapsed < 3500, `the probe budget must cap the wait, took ${elapsed}ms`);
    assert.ok(calls >= 1, "the window was asked of the venue");
  } finally { await g.close(); }
});

test("gateway: a page cut from a streamed-only window does not claim exchange history", async () => {
  const store = tmpStore("h2");
  store.append("BTCUSDT", "1m", candle(1, false));
  store.append("BTCUSDT", "1m", candle(2, false));
  const g = await startGateway(store);
  try {
    let calls = 0;
    const res = await withVenueStub(async () => { calls += 1; return blocked(); },
      () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=2&endTime=${BASE + 2 * MIN}`));
    const body = await res.json() as { data?: { openTime: number }[]; meta?: { venueBacked?: boolean; source?: string } };
    assert.equal(res.status, 200);
    assert.equal(body.data!.length, 2, "the streamed bars are still a usable answer");
    assert.ok(body.data!.every((c) => c.openTime <= BASE + 2 * MIN), "nothing newer than the requested end");
    assert.equal(body.meta?.source, "mirror");
    assert.equal(body.meta?.venueBacked, false, "websocket ticks are not exchange history");
    assert.equal(calls, 0, "a window we fully hold never goes upstream");
  } finally { await g.close(); }
});

test("gateway: no cached window means a fast 502 and exactly one upstream probe", async () => {
  const store = tmpStore("b");
  const g = await startGateway(store);
  try {
    let calls = 0;
    const started = Date.now();
    const r = await withVenueStub(async () => { calls += 1; return blocked(); },
      () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500`));
    const elapsed = Date.now() - started;
    assert.equal(r.status, 502);
    assert.equal(calls, 1, "a 403 must not be retried into the limiter");
    assert.ok(elapsed < 3000, `must fail fast, took ${elapsed}ms`);
  } finally { await g.close(); }
});

test("gateway: the forming candle is not labelled closed", async () => {
  const store = tmpStore("c");
  const g = await startGateway(store);
  const nowOpen = Math.floor(Date.now() / MIN) * MIN;
  const venueReply = async () => ({
    ok: true, status: 200,
    // newest-first, like Bybit
    json: async () => ({ retCode: 0, result: { list: [
      [String(nowOpen), "1", "2", "0.5", "1.5", "3"],
      [String(nowOpen - MIN), "1", "2", "0.5", "1.5", "3"],
    ] } }),
  });
  try {
    const r = await withVenueStub(venueReply,
      () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500`));
    const body = await r.json() as { data: { openTime: number; closed: boolean }[] };
    assert.equal(r.status, 200);
    assert.equal(body.data.length, 2);
    assert.equal(body.data[0]!.closed, true, "elapsed bar is closed");
    assert.equal(body.data[1]!.closed, false, "still-forming bar must not claim to be closed");
  } finally { await g.close(); }
});

test("gateway: a backfill page is not answered with the recent window", async () => {
  const store = tmpStore("e");
  store.remember("BTCUSDT", "1m", [candle(1), candle(2)]);
  const g = await startGateway(store);
  try {
    let calls = 0;
    const r = await withVenueStub(async () => { calls += 1; return blocked(); },
      () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500&endTime=${BASE}`));
    // Handing back the "now" window here would be read as older data, then
    // filtered away by the client as "nothing older" — silently ending
    // scroll-back in the middle of the history.
    assert.equal(r.status, 502);
    assert.equal(calls, 1);
  } finally { await g.close(); }
});

test("kline window refresher: watched pairs only, and nothing while idle", async () => {
  const asked: string[] = [];
  let demand: [string, string][] = [["BTCUSDT", "1m"], ["ETHUSDT", "1m"], ["BTCUSDT", "1m"]];
  const stop = startKlineWindowRefresh({
    intervalMs: 5,
    logger: silentLogger,
    demand: () => demand,
    refreshWindow: async (symbol, interval) => { asked.push(`${symbol}/${interval}`); },
  });
  await sleep(30);
  stop();
  assert.deepEqual(asked.slice(0, 2), ["BTCUSDT/1m", "ETHUSDT/1m"], "one pass per tick, duplicates collapsed");
  assert.ok(asked.length > 2, "keeps refreshing while clients watch");

  asked.length = 0;
  const stopIdle = startKlineWindowRefresh({
    intervalMs: 5, logger: silentLogger, demand: () => [],
    refreshWindow: async () => { asked.push("unexpected"); },
  });
  await sleep(30);
  stopIdle();
  assert.deepEqual(asked, [], "an idle gateway sends nothing");
});

test("klines store: the disk mirror round-trips a window and skips junk", async () => {
  const mirror = join(tmpdir(), `ct-klines-${process.pid}-${++storeSeq}-d.json`);
  const a = createKlinesStore({ file: mirror, logger: silentLogger });
  a.remember("BTCUSDT", "1m", [liveCandle(2), liveCandle(1)]);
  await a.flush();

  const b = createKlinesStore({ file: mirror, logger: silentLogger });
  await b.load();
  assert.equal(b.size(), 1);
  const back = b.candles("BTCUSDT", "1m", 500)!;
  assert.equal(back.length, 2);
  assert.deepEqual({ ...back[0]!, closed: false }, { ...liveCandle(2), closed: false });
  assert.equal(b.candles("BTCUSDT", "1m", 1)!.length, 1, "a smaller limit takes the newest candles");
  assert.equal(b.venueBacked("BTCUSDT", "1m"), true, "a restored page is still trusted for an instant answer");
  assert.equal(b.venueBacked("BTCUSDT", "5m"), false, "an unwatched pair has no window");
});

test("klines store: streamed candles keep the fallback window at now", () => {
  const store = tmpStore("f");
  // The last page REST served before the venue went unreachable.
  store.remember("BTCUSDT", "1m", [candle(1), candle(2)]);

  // The websocket keeps delivering: the forming candle updates in place, the next
  // one opens a new slot. Without this the mirror ages by the minute and every
  // fallback answer leaves the chart's right edge frozen hours behind.
  store.append("BTCUSDT", "1m", candle(2, false));
  store.append("BTCUSDT", "1m", { ...candle(2, false), close: "100.9", volume: "9" });
  store.append("BTCUSDT", "1m", candle(3, false));
  store.append("BTCUSDT", "1m", { ...candle(3, false), volume: "-5" });
  store.append("BTCUSDT", "1m", { openTime: 0, open: "1", high: "1", low: "1", close: "1", volume: "1" });
  store.append("BTCUSDT", "1m", { openTime: BASE + 4 * MIN, open: "x", high: "1", low: "1", close: "1", volume: "1" });

  const back = store.candles("BTCUSDT", "1m", 500)!;
  assert.equal(back.length, 3, "one candle per slot, junk rejected");
  assert.equal(Number(back[2]!.openTime), BASE + 3 * MIN);
  assert.equal(back[2]!.volume, "7", "a negative volume must not blank the live bar");
  assert.equal(back[1]!.close, "100.9", "the last good update survives the junk ones");
  assert.equal(store.venueBacked("BTCUSDT", "1m"), true, "stream ticks on top of a real page keep it real history");
});

/* ── M2: per-window cool-off and background probe control ─────────────── */

/** Open the gateway's socket and watch one (symbol, interval), which is what
 *  creates both the pre-warm probe and the refresh tick's demand. */
async function watchKline(g: { base: string }, symbol: string, interval: string) {
  const ws = new WebSocket(g.base.replace("http", "ws") + "/ws");
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws connect failed")), { once: true });
  });
  ws.send(JSON.stringify({ type: "select_symbol", symbol }));
  ws.send(JSON.stringify({ type: "subscribe", channels: [{ channel: "kline", symbol, interval }] }));
  return {
    ws,
    close: () => ws.close(),
  };
}

/** The kline timing knobs are read per gateway, so a test can watch a whole
 *  refusal-and-recovery cycle in a few hundred milliseconds. The cool-off cap
 *  follows the base, and the circuit is set to 0 where the test is about the
 *  per-window cool-off rather than the venue-wide ban. */
function withKlineTiming<T>(opts: { refreshMs: string; coolMs: string; circuitMs: string }, run: () => Promise<T>): Promise<T> {
  const keys = ["KLINE_REFRESH_MS", "KLINE_COOL_MS", "KLINE_COOL_MAX_MS", "KLINE_CIRCUIT_MS"] as const;
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.KLINE_REFRESH_MS = opts.refreshMs;
  process.env.KLINE_COOL_MS = opts.coolMs;
  process.env.KLINE_COOL_MAX_MS = opts.coolMs;
  process.env.KLINE_CIRCUIT_MS = opts.circuitMs;
  return run().finally(() => {
    for (const k of keys) {
      const v = prev[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

test("gateway: a refused window is answered instantly, without a second probe", async () => {
  const store = tmpStore("g");
  store.remember("BTCUSDT", "1m", [candle(1), candle(2)]);
  const g = await startGateway(store);
  try {
    let calls = 0;
    const stub = async () => { calls += 1; return blocked(); };
    await withVenueStub(stub, async () => {
      await fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500`);
      await sleep(150);
    });
    assert.equal(calls, 1, "one revalidation behind the first answer");

    // A different depth defeats the 2 s read cache, so this read can only be
    // served by the mirror — and the cool-off must keep it from probing again.
    const started = Date.now();
    const r = await withVenueStub(stub, () =>
      fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=300`));
    const elapsed = Date.now() - started;
    const body = await r.json() as { data?: unknown[] };
    assert.equal(r.status, 200);
    assert.equal((body.data as unknown[]).length, 2);
    assert.ok(elapsed < 250, `a cooling window must not wait on the venue, took ${elapsed}ms`);
    assert.equal(calls, 1, "the cool-off replaced the second probe");
  } finally { await g.close(); }
});

test("gateway: the refresh tick queues no probes for a window that refused us", async () => {
  const store = tmpStore("h");
  store.remember("BTCUSDT", "1m", [candle(1), candle(2)]);
  await withKlineTiming({ refreshMs: "10", coolMs: "60", circuitMs: "0" }, async () => {
    const g = await startGateway(store);
    try {
      let calls = 0;
      const n = await withVenueStub(async () => { calls += 1; return blocked(); }, async () => {
        const w = await watchKline(g, "BTCUSDT", "1m");
        await sleep(400); // ~40 ticks at 10 ms
        w.close();
        return calls;
      });
      // One pre-warm probe, then the 60 ms cool-off doubling: a handful at most,
      // never the ~40 a per-tick probe would have produced.
      assert.ok(n > 0, "the window is probed at least once");
      assert.ok(n <= 8, `the cool-off must silence the tick, saw ${n} probes in 400ms`);
    } finally { await g.close(); }
  });
});

test("gateway: after a refusal the window is harvested again once the venue recovers", async () => {
  const store = tmpStore("i");
  store.remember("BTCUSDT", "1m", [candle(1), candle(2)]);
  await withKlineTiming({ refreshMs: "10", coolMs: "30", circuitMs: "0" }, async () => {
    const g = await startGateway(store);
    try {
      let allow = false;
      const reply = async (): Promise<StubReply> => {
        if (!allow) return blocked();
        return { ok: true, status: 200, json: async () => ({ retCode: 0, result: { list: [
          [String(BASE + 3 * MIN), "1", "2", "0.5", "1.5", "3"],
          [String(BASE + 2 * MIN), "1", "2", "0.5", "1.5", "3"],
          [String(BASE + 1 * MIN), "1", "2", "0.5", "1.5", "3"],
          [String(BASE + 0 * MIN), "1", "2", "0.5", "1.5", "3"],
        ] } }) };
      };
      const seen = await withVenueStub(reply, async () => {
        const w = await watchKline(g, "BTCUSDT", "1m");
        await fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500`);
        await sleep(200);          // refused: the window goes cool
        allow = true;              // the venue starts answering
        for (let i = 0; i < 60 && store.candles("BTCUSDT", "1m", 500)!.length < 4; i++) await sleep(20);
        // A different depth: the 2 s read cache may still hold the pre-recovery
        // answer, and this asserts on what the recovery put in the mirror.
        const res = await fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=499`);
        const body = await res.json() as { data?: unknown[] };
        w.close();
        return body.data?.length ?? 0;
      });
      assert.equal(seen, 4, "a recovered venue is harvested again after the cool-off");
      assert.equal(store.venueBacked("BTCUSDT", "1m"), true);
    } finally { await g.close(); }
  });
});

// ── page provenance (what the client is allowed to infer) ─────────────────

test("gateway: a stream-fed page does not claim to be exchange history", async () => {
  const store = tmpStore("p1");
  // Only the websocket ever filled this window: the candles are real, but there
  // is no venue history behind them, and a page of 1000 looks exactly like one.
  store.append("BTCUSDT", "1m", candle(1));
  const g = await startGateway(store);
  try {
    const res = await withVenueStub(blocked, () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500`));
    const body = await res.json() as { data?: unknown[]; meta?: { venueBacked?: boolean } };
    assert.equal(res.status, 200, "the stream tail still charts the recent window");
    assert.equal((body.data ?? []).length, 1);
    assert.equal(body.meta?.venueBacked, false);
  } finally { await g.close(); }
});

test("gateway: a page the venue served is reported as real history", async () => {
  const store = tmpStore("p2");
  const g = await startGateway(store);
  const venuePage = async (): Promise<StubReply> => ({
    ok: true, status: 200,
    json: async () => ({ retCode: 0, result: { list: [
      [String(BASE + 2 * MIN), "1", "2", "0.5", "1.5", "3"],
      [String(BASE + 1 * MIN), "1", "2", "0.5", "1.5", "3"],
      [String(BASE + 0 * MIN), "1", "2", "0.5", "1.5", "3"],
    ] } }),
  });
  try {
    const res = await withVenueStub(venuePage, () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500`));
    const body = await res.json() as { data?: unknown[]; meta?: { venueBacked?: boolean } };
    assert.equal((body.data ?? []).length, 3);
    assert.equal(body.meta?.venueBacked, true, "so the chart may ask for what is behind it");
  } finally { await g.close(); }
});

test("gateway: a cooled window says it cannot go deeper", async () => {
  const store = tmpStore("p3");
  store.remember("BTCUSDT", "1m", [candle(1), candle(2)]);
  const g = await startGateway(store);
  try {
    const read = async (limit: number) => {
      const res = await fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`);
      return await res.json() as { meta?: { venueBacked?: boolean; canGoOlder?: boolean } };
    };
    const metas = await withVenueStub(async () => { await sleep(60); return blocked(); }, async () => {
      const open = await read(500);
      await sleep(250);            // the revalidation behind that answer gets refused
      return [open, await read(499)];
    });
    assert.equal(metas[0].meta?.canGoOlder, true, "before a refusal the window is open");
    assert.equal(metas[1].meta?.venueBacked, true, "the mirror still holds real history");
    assert.equal(metas[1].meta?.canGoOlder, false, "but a deeper page is currently unreachable");
  } finally { await g.close(); }
});

// ── mirrored history (backfill without the venue) ─────────────────────────

test("store: an older page deepens the mirror but never becomes the live window", () => {
  const store = tmpStore("m1");
  store.rememberOlder("BTCUSDT", "1m", Array.from({ length: 300 }, (_, i) => candle(i)));
  assert.equal(store.candles("BTCUSDT", "1m", 100), null, "months of history is not a stand-in for the recent window");
  assert.equal(store.venueBacked("BTCUSDT", "1m"), true, "it is still real exchange data");
  const older = store.candlesBefore("BTCUSDT", "1m", BASE + 250 * MIN, 10);
  assert.equal(older!.length, 10);
  assert.equal(older![0]!.openTime, BASE + 241 * MIN, "the newest bars at or before the requested end");
  assert.equal(older![9]!.openTime, BASE + 250 * MIN, "the boundary bar is included, like upstream");
});

test("store: the live refresh keeps the depth scroll-back collected", () => {
  const store = tmpStore("m5");
  store.rememberOlder("BTCUSDT", "1m", Array.from({ length: 400 }, (_, i) => candle(i)));
  store.remember("BTCUSDT", "1m", [candle(500), candle(501)]);
  assert.equal(store.candles("BTCUSDT", "1m", 1000)!.length, 402, "a 30s refresh must not truncate the mirror back to one page");
  assert.equal(store.candles("BTCUSDT", "1m", 1000)![401]!.openTime, BASE + 501 * MIN, "the newest bar is still the tail");
  assert.equal(store.candlesBefore("BTCUSDT", "1m", BASE + 100 * MIN, 100)!.length, 100, "history stays reachable");
});

test("store: the depth policy is one table an operator can restate", () => {
  // The policy is declared in exactly one place, so the numbers below are the
  // documented depth per timeframe — and a window over them is a bug, not a
  // tuning detail.
  assert.deepEqual(DEPTH_TARGETS, {
    "1m": 10_000, "3m": 8_000, "5m": 8_000, "15m": 6_000, "30m": 6_000,
    "1h": 9_000, "4h": 4_000, "1d": 20_000, "1w": 20_000,
  });
  assert.equal(depthTarget("1m"), 10_000);
  assert.equal(depthTarget("45m"), DEFAULT_DEPTH, "an unlisted timeframe still gets a sane depth");
  assert.equal(tmpStore("policy").progress("BTCUSDT", "15m").target, DEPTH_TARGETS["15m"]);
});

test("store: the window depth budget keeps the newest candles", () => {
  // The budget is the policy, so the test restates it rather than hard-coding a
  // number that happens to be current: what must hold is that depth is a sliding
  // window, never an unbounded pile.
  const store = tmpStore("m6", { depthTargets: { "1m": 3000 } });
  assert.equal(store.progress("BTCUSDT", "1m").target, 3000, "the override is what the window works toward");
  store.rememberOlder("BTCUSDT", "1m", Array.from({ length: 3000 }, (_, i) => candle(i)));
  store.remember("BTCUSDT", "1m", Array.from({ length: 1000 }, (_, i) => candle(3000 + i)));
  const all = store.candles("BTCUSDT", "1m", 5000)!;
  assert.equal(all.length, 3000, "the depth target is a sliding budget");
  assert.equal(all[0]!.openTime, BASE + 1000 * MIN, "the oldest thousand are dropped");
  assert.equal(all[2999]!.openTime, BASE + 3999 * MIN);
  assert.equal(store.progress("BTCUSDT", "1m").bars, 3000, "the depth count is what a crawl works toward");
});

test("gateway: a backfill page the mirror already holds never reaches the venue", async () => {
  const store = tmpStore("m2");
  store.rememberOlder("BTCUSDT", "1m", Array.from({ length: 3000 }, (_, i) => candle(i)));
  const g = await startGateway(store);
  try {
    const end = BASE + 2500 * MIN;
    let calls = 0;
    const res = await withVenueStub(async () => { calls += 1; return blocked(); },
      () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500&endTime=${end}`));
    const body = await res.json() as { data?: { openTime: number }[]; meta?: { source?: string; venueBacked?: boolean } };
    assert.equal(res.status, 200);
    assert.equal(body.data!.length, 500);
    assert.equal(body.data![0]!.openTime, BASE + 2001 * MIN);
    assert.ok(body.data!.every((c) => c.openTime <= end), "nothing newer than the requested range");
    assert.equal(body.meta?.source, "mirror");
    assert.equal(calls, 0, "a page we already hold is not a reason to call Bybit");
  } finally { await g.close(); }
});

test("gateway: a mirror that runs shallow reports the shortfall, not the end of history", async () => {
  const store = tmpStore("m3");
  store.remember("BTCUSDT", "1m", [candle(500), candle(501)]);
  store.rememberOlder("BTCUSDT", "1m", [candle(10), candle(11), candle(12)]);
  const g = await startGateway(store);
  try {
    const res = await withVenueStub(blocked,
      () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500&endTime=${BASE + 100 * MIN}`));
    const body = await res.json() as { data?: unknown[]; meta?: { source?: string; venueBacked?: boolean } };
    assert.equal(res.status, 200, `refused venue must still hand over what is mirrored: ${JSON.stringify(body)}`);
    assert.equal(body.data!.length, 3, "the three older bars we hold");
    assert.equal(body.meta?.source, "mirror", "short because of our depth, not because the venue ended");
    assert.equal(body.meta?.venueBacked, true);
  } finally { await g.close(); }
});

test("gateway: an older venue page is mirrored, so the next page is local", async () => {
  const store = tmpStore("m4");
  store.remember("BTCUSDT", "1m", [candle(2000), candle(2001)]);
  const olderPage = async (): Promise<StubReply> => ({
    ok: true, status: 200,
    json: async () => ({ retCode: 0, result: { list: [
      [String(BASE + 1002 * MIN), "1", "2", "0.5", "1.5", "3"],
      [String(BASE + 1001 * MIN), "1", "2", "0.5", "1.5", "3"],
      [String(BASE + 1000 * MIN), "1", "2", "0.5", "1.5", "3"],
    ] } }),
  });
  const g = await startGateway(store);
  try {
    const end = BASE + 1500 * MIN;
    let calls = 0;
    const first = await withVenueStub(async () => { calls += 1; return olderPage(); },
      () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=3&endTime=${end}`));
    const a = await first.json() as { data?: unknown[]; meta?: { source?: string } };
    assert.equal(a.data!.length, 3, "the venue page is handed over as it was served");
    assert.equal(a.meta?.source, "venue");
    // A narrower page over the same range: the mirror now covers it entirely.
    const second = await withVenueStub(async () => { calls += 1; return blocked(); },
      () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=2&endTime=${end}`));
    const b = await second.json() as { data?: unknown[]; meta?: { source?: string } };
    assert.equal(b.data!.length, 2);
    assert.equal(b.meta?.source, "mirror");
    assert.equal(calls, 1, "the second page cost no venue call");
    assert.equal(store.candlesBefore("BTCUSDT", "1m", end, 10)!.length, 3, "and stayed in the window it belongs to");
    const tail = store.candles("BTCUSDT", "1m", 10)!;
    assert.equal(tail.length, 5, "the backfilled bars join the same window");
    assert.equal(tail[4]!.openTime, BASE + 2001 * MIN, "the newest live bar is still the tail");
    assert.equal(new Set(tail.map((c) => c.openTime)).size, tail.length, "no bar is held twice");
  } finally { await g.close(); }
});

/* ── M5b: the history crawl on the request path ─────────────────────── */

/** A venue answering out of a fixed, minute-aligned history that ends now:
 *  newest-first, at most `limit` bars, and never a bar opening after the `end`
 *  the request carried. That is the shape Bybit's kline endpoint has, so the
 *  crawl's pages join the mirror on the same boundaries the real ones would.
 *
 *  It answers one symbol only: a background probe left in flight by an earlier
 *  gateway would otherwise land here and be counted as this window's traffic. */
function venueHistory(bars: number, symbol: string) {
  const calls: { limit: number; end: number | null }[] = [];
  const oldest = NOW - (bars - 1) * MIN;
  return {
    calls,
    handler: async (url: string): Promise<StubReply> => {
      const u = new URL(url);
      if (u.searchParams.get("symbol") !== symbol) return { ok: false, status: 403, json: async () => ({}) };
      const limit = Number(u.searchParams.get("limit"));
      const raw = u.searchParams.get("end");
      const end = raw === null ? null : Number(raw);
      calls.push({ limit, end });
      const top = end === null ? NOW : Math.floor(end / MIN) * MIN;
      const list: string[][] = [];
      for (let i = 0; i < limit; i++) {
        const t = top - i * MIN;
        if (t < oldest) break;
        list.push([String(t), "100", "101", "99", "100.5", "7"]);
      }
      return { ok: true, status: 200, json: async () => ({ retCode: 0, result: { list } }) };
    },
  };
}

async function until(cond: () => boolean, ms = 4000, what = "condition") {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** The gateway with its real crawl: the pages go out through its own fetcher, so
 *  this is where the lane-sharing is actually observable. */
async function startCrawlingGateway(store: ReturnType<typeof createKlinesStore>) {
  const { server, klineCrawler } = createGateway(instruments(), ["bybit"], silentLogger, null, store);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    crawl: klineCrawler,
    close: async () => { klineCrawler.stop(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

test("gateway: the read is served at once and the crawl deepens the window behind it", async () => {
  const store = tmpStore("crawl-gw", { depthTargets: { "1m": 1200 } });
  const v = venueHistory(5000, "BTCUSDT");
  const g = await startCrawlingGateway(store);
  try {
    await withVenueStub(v.handler, async () => {
      const first = await fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500`);
      const a = await first.json() as { data: unknown[]; meta: { source: string; canGoOlder: boolean; history: { target: number; bars: number; status: string } } };
      assert.equal(a.data.length, 500, "the page the client asked for is the page it gets");
      assert.equal(a.meta.source, "venue");
      assert.equal(a.meta.history.target, 1200, "the depth the policy asks for travels with the page");
      assert.equal(a.meta.history.bars, 500, "and how deep the mirror is right now");
      assert.equal(a.meta.canGoOlder, true, "one page short of the target is not the end of history");

      // The crawl runs behind that response. Nothing here awaits it.
      await until(() => store.progress("BTCUSDT", "1m").status === "complete", 4000, "the target depth");
      assert.equal(store.progress("BTCUSDT", "1m").bars, 1200);
      assert.equal(store.progress("BTCUSDT", "1m").venueBars, 1200, "and all of it venue history, none of it only streamed");

      // A different limit: the read cache cannot answer it, so this proves the
      // mirror did, while the crawl is finished and off the venue again.
      const started = Date.now();
      const second = await fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=400`);
      const b = await second.json() as { data: unknown[]; meta: { source: string; canGoOlder: boolean; history: { status: string; bars: number } } };
      assert.ok(Date.now() - started < 100, `deep history must be instant, took ${Date.now() - started}ms`);
      assert.equal(b.data.length, 400);
      assert.equal(b.meta.source, "mirror");
      assert.equal(b.meta.history.status, "complete");
      assert.equal(b.meta.canGoOlder, false, "at the depth target there is nothing older worth asking for");

      const older = v.calls.filter((c) => c.end !== null);
      assert.equal(older.length, 1, "one crawl page took the window from 500 to the target");
      assert.equal(older[0]!.limit, CRAWL_PAGE, "and it asked for the venue's own ceiling");
      assert.equal(new Set(older.map((c) => c.end)).size, older.length, "no older page was asked for twice");
    });
  } finally { await g.close(); }
});

test("gateway: a venue that ends the range stops the crawl and the scroll-back", async () => {
  const store = tmpStore("crawl-end", { depthTargets: { "1m": 10000 } });
  // Its own pair: see venueHistory.
  const v = venueHistory(600, "ETHUSDT"); // the exchange simply has nothing older
  const g = await startCrawlingGateway(store);
  try {
    await withVenueStub(v.handler, async () => {
      const first = await fetch(`${g.base}/api/klines?symbol=ETHUSDT&interval=1m&limit=500`);
      const a = await first.json() as { meta: { canGoOlder: boolean } };
      assert.equal(a.meta.canGoOlder, true);

      await until(() => store.progress("ETHUSDT", "1m").status === "exhausted", 4000, "the venue to end the range");
      const p = store.progress("ETHUSDT", "1m");
      assert.equal(p.bars, 600, "the short page is still real history");
      assert.ok(p.exhaustedAt > 0, "and recorded as the end, not as a failure");
      assert.equal(p.nextRetryAt, 0, "which is a state that does not retry");

      const calls = v.calls.length;
      await sleep(800);
      assert.equal(v.calls.length, calls, "an ended history asks for nothing more");

      const second = await fetch(`${g.base}/api/klines?symbol=ETHUSDT&interval=1m&limit=400`);
      const b = await second.json() as { meta: { canGoOlder: boolean; history: { status: string } } };
      assert.equal(b.meta.history.status, "exhausted");
      assert.equal(b.meta.canGoOlder, false, "and the client is told to stop scrolling back");
    });
  } finally { await g.close(); }
});
