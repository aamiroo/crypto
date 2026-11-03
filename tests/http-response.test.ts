import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../backend/src/gateway/server.js";
import { createKlinesStore } from "../backend/src/gateway/klinesStore.js";
import { Instruments } from "../backend/src/instruments.js";

/**
 * The gateway's HTTP reply shape: a kline page is the biggest thing the terminal
 * downloads, so it is compressed for clients that can read it and byte-for-byte
 * the same page for clients that cannot.
 */

const silentLogger = { info() {}, warn() {}, error() {} };
const MIN = 60_000;
/** On the minute grid, because that is where a real 1 m bar opens: a row that is
 *  not on its interval's grid is not a candle and the gateway now drops it. */
const BASE = Math.floor(1_700_000_000_000 / MIN) * MIN;

function instruments() {
  const inst = new Instruments({ logger: silentLogger, quote: "USDT" });
  inst.replace([{ symbol: "BTCUSDT", baseCoin: "BTC", priceDecimals: 1, qtyDecimals: 6 }], "test");
  return inst;
}

function candle(n: number) {
  const openTime = BASE + n * MIN;
  return {
    interval: "1m", openTime, closeTime: openTime + MIN - 1,
    open: "100", high: "101", low: "99", close: "100.5", volume: "7", closed: true,
  };
}

/** Raw bytes, because fetch inflates a gzip body before we can look at it. */
function raw(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function withVenueReply<T>(candles: number, run: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = async (input: unknown, init?: unknown) =>
    String(input).includes("api.bybit.com")
      ? ({ ok: true, status: 200, json: async () => ({ retCode: 0, result: { list:
          Array.from({ length: candles }, (_, i) => {
            const c = candle(candles - 1 - i); // newest-first, like Bybit
            return [String(c.openTime), c.open, c.high, c.low, c.close, c.volume];
          }) } }) } as unknown as Response)
      : (prev(input as never, init as never) as Promise<Response>);
  try { return await run(); } finally { globalThis.fetch = prev; }
}

async function startGateway(store: ReturnType<typeof createKlinesStore>) {
  // The history crawl is background upstream work on its own timer; these tests
  // are about how a reply is encoded, so the crawl stays off and the two reads
  // of the same page stay comparable.
  const { server } = createGateway(instruments(), ["bybit"], silentLogger, null, store,
    { trigger() { return false; }, stop() {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

const tmp = (tag: string) => join(tmpdir(), `ct-enc-${Date.now()}-${tag}.json`);

test("http: a gzip client gets the page deflated exactly once", async () => {
  const store = createKlinesStore({ file: tmp("a"), logger: silentLogger });
  const g = await startGateway(store);
  try {
    const r = await withVenueReply(400, () =>
      raw(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=400`, { "accept-encoding": "gzip" }));
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-encoding"], "gzip");
    assert.match(String(r.headers.vary ?? ""), /accept-encoding/i);
    assert.equal(Number(r.headers["content-length"]), r.body.length, "length describes the bytes sent");

    // One layer: inflating once yields readable JSON.
    const text = gunzipSync(r.body).toString("utf8");
    const body = JSON.parse(text) as { data: { openTime: number }[] };
    assert.equal(body.data.length, 400);
    assert.ok(r.body.length < text.length, `must shrink: ${r.body.length} vs ${text.length}`);
  } finally { await g.close(); }
});

test("http: an identity client gets the same candles as plain JSON", async () => {
  const store = createKlinesStore({ file: tmp("b"), logger: silentLogger });
  const g = await startGateway(store);
  try {
    const gz = await withVenueReply(400, () =>
      raw(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=400`, { "accept-encoding": "gzip" }));
    const plain = await withVenueReply(400, () =>
      raw(`${g.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=400&endTime=1`, { "accept-encoding": "identity" }));
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.match(String(plain.headers.vary ?? ""), /accept-encoding/i);
    assert.deepEqual(JSON.parse(plain.body.toString("utf8")), JSON.parse(gunzipSync(gz.body).toString("utf8")));
  } finally { await g.close(); }
});

test("http: a reply under the compression floor stays plain but keeps Vary", async () => {
  const store = createKlinesStore({ file: tmp("c"), logger: silentLogger });
  const g = await startGateway(store);
  try {
    const r = await raw(`${g.base}/healthz`, { "accept-encoding": "gzip" });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-encoding"], undefined, "a few hundred bytes cost more to deflate than to send");
    assert.match(String(r.headers.vary ?? ""), /accept-encoding/i);
    assert.equal((JSON.parse(r.body.toString("utf8")) as { ok: boolean }).ok, true);
  } finally { await g.close(); }
});
