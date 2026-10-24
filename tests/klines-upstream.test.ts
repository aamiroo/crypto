import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, startKlineWindowRefresh } from "../backend/src/gateway/server.js";
import { createKlinesStore } from "../backend/src/gateway/klinesStore.js";
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
  inst.replace([{ symbol: "BTCUSDT", baseCoin: "BTC", priceDecimals: 1, qtyDecimals: 6 }], "test");
  return inst;
}

function candle(n: number, closed = true) {
  const openTime = BASE + n * MIN;
  return {
    interval: "1m", openTime, closeTime: openTime + MIN - 1,
    open: "100", high: "101", low: "99", close: "100.5", volume: "7", closed,
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

async function startGateway(store: ReturnType<typeof createKlinesStore>) {
  const { server } = createGateway(instruments(), ["bybit"], silentLogger, null, store);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

const blocked = async () => ({ ok: false, status: 403, json: async () => ({}) });

test("gateway: a blocked venue answers from the last good window, not an error", async () => {
  const store = createKlinesStore({ file: join(tmpdir(), `ct-klines-${Date.now()}-a.json`), logger: silentLogger });
  store.remember("BTCUSDT", "1m", [candle(1), candle(2)]);
  const g = await startGateway(store);
  try {
    let calls = 0;
    const r = await withVenueStub(async () => { calls += 1; return blocked(); },
      () => fetch(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=500`));
    const body = await r.json() as { data?: unknown[]; error?: string };
    assert.equal(r.status, 200, `expected cache fallback, got ${r.status} ${JSON.stringify(body)}`);
    assert.equal(calls, 1, "the cool-off must stop it probing again");
    assert.equal((body.data as unknown[]).length, 2);
  } finally { await g.close(); }
});

test("gateway: no cached window means a fast 502 and exactly one upstream probe", async () => {
  const store = createKlinesStore({ file: join(tmpdir(), `ct-klines-${Date.now()}-b.json`), logger: silentLogger });
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
  const store = createKlinesStore({ file: join(tmpdir(), `ct-klines-${Date.now()}-c.json`), logger: silentLogger });
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
  const store = createKlinesStore({ file: join(tmpdir(), `ct-klines-${Date.now()}-e.json`), logger: silentLogger });
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
  const file = join(tmpdir(), `ct-klines-${Date.now()}-d.json`);
  const a = createKlinesStore({ file, logger: silentLogger });
  a.remember("BTCUSDT", "1m", [candle(1), candle(2)]);
  await a.flush();

  const b = createKlinesStore({ file, logger: silentLogger });
  await b.load();
  assert.equal(b.size(), 1);
  const back = b.candles("BTCUSDT", "1m", 500)!;
  assert.equal(back.length, 2);
  assert.deepEqual({ ...back[0]!, closed: false }, { ...candle(1), closed: false });
  assert.equal(b.candles("BTCUSDT", "1m", 1)!.length, 1, "a smaller limit takes the newest candles");
});
