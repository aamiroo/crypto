import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Boot ordering of the real process (`backend/src/index.js`).
 *
 * The terminal's "slow to load" was a boot-order bug, not a slow exchange: the
 * port was opened only *after* `instruments.bootstrap()` (a live venue fetch with
 * a 10 s timeout) and after the kline mirror had been read back synchronously. On
 * a network that refuses us — which is what a region block or a CDN hiccup looks
 * like from the client's side — nothing accepted a connection for ten seconds,
 * and a refused socket is what makes the client say "Connecting…" forever.
 *
 * So: the port must be accepting while the venue is still hanging, and the
 * gateway must answer from whatever it already has. These tests start the real
 * entry point against a venue that never answers the instrument list, because a
 * unit test of `createGateway` could not catch a regression in `index.js`.
 */

const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENTRY = resolve(import.meta.dirname, "..", "backend", "src", "index.js");

/** A Bybit stand-in: klines work, the instrument list never answers. */
function hangingVenue() {
  const served: string[] = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    served.push(url.pathname);
    if (url.pathname === "/v5/market/kline") {
      const step = 60_000;
      const top = Math.floor(Date.now() / step) * step;
      const list = [0, 1, 2].map((i) => [String(top - i * step), "1", "2", "0.5", "1.5", "3"]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ retCode: 0, result: { list } }));
      return;
    }
    if (url.pathname === "/v5/market/instruments-info") {
      // Hang, do not refuse: a refused connection would let `bootstrap` fall
      // through to its fallback in milliseconds and prove nothing.
      req.socket.setNoDelay(true);
      sockets.add(req.socket);
      req.socket.on("close", () => sockets.delete(req.socket));
      return;
    }
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end("{}");
  });
  return {
    served,
    listen: () => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () => { for (const s of sockets) s.destroy(); return new Promise<void>((r) => server.close(() => r())); },
  };
}

/** The first port the gateway actually accepts on — not the first moment the
 *  process exists, which is the distinction the whole fix turns on. */
async function waitUntilAccepting(port: number, timeoutMs: number) {
  const started = Date.now();
  for (;;) {
    const ok = await new Promise<boolean>((r) => {
      const s = net.connect({ port, host: "127.0.0.1" }, () => { s.destroy(); r(true); });
      s.on("error", () => r(false));
      s.setTimeout(250, () => { s.destroy(); r(false); });
    });
    if (ok) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`gateway never accepted anything within ${timeoutMs}ms`);
    await sleep(25);
  }
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

async function startBackend(venuePort: number) {
  const dir = await mkdtemp(join(tmpdir(), "ct-boot-"));
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      BYBIT_REST: `http://127.0.0.1:${venuePort}`,
      // The two on-disk stores pointed at a scratch dir: a test must never write
      // the operator's mirror or its instrument cache.
      KLINE_DIR: join(dir, "klines"),
      INSTRUMENTS_CACHE: join(dir, "instruments.json"),
      TICKER_SEED_MS: "600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain the pipes so a chatty boot cannot wedge the child on a full buffer.
  child.stdout.resume();
  child.stderr.resume();
  return {
    port,
    child,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    },
  };
}

const get = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  let body: any = null;
  try { body = await res.json(); } catch { /* the status is the assertion */ }
  return { status: res.status, body };
};

test("boot: the port accepts while the instrument fetch is still hanging", async () => {
  const venue = hangingVenue();
  const venuePort = await venue.listen();
  const app = await startBackend(venuePort);
  try {
    // The blocked venue takes 10 s to time out. Whatever this measures has to be
    // far below that, or the port is still behind the discovery pass.
    const acceptingMs = await waitUntilAccepting(app.port, 5000);
    assert.ok(acceptingMs < 5000, `port opened after ${acceptingMs}ms of venue wait`);

    const health = await get(`${app.base}/healthz`);
    assert.equal(health.status, 200, "and answers immediately");
    assert.equal(health.body.ok, true);
    assert.equal(health.body.instruments, 0, "degraded but honest: nothing has been discovered yet");
    assert.equal(venue.served.includes("/v5/market/instruments-info"), true, "the discovery pass is still in flight");

    // A request must never be blocked behind boot work, and a symbol the empty
    // registry has not seen yet must not be refused for that reason.
    const k = await get(`${app.base}/api/klines?symbol=BTCUSDT&interval=1m&limit=3`);
    assert.equal(k.status, 200, `expected a venue page during boot, got ${k.status} ${JSON.stringify(k.body)}`);
    assert.equal(k.body.data.length, 3);
    assert.notEqual(k.body.error, "UNKNOWN_SYMBOL", "an unbuilt registry is no authority to reject a valid pair");
  } finally {
    await app.close();
    await venue.close();
  }
});

test("boot: a klines request with no symbol is a 400, not somebody else's candles", async () => {
  const venue = hangingVenue();
  const venuePort = await venue.listen();
  const app = await startBackend(venuePort);
  try {
    await waitUntilAccepting(app.port, 5000);
    // The silent BTCUSDT default: a client that forgot the parameter used to get
    // BTC candles under whatever header it was showing.
    const missing = await get(`${app.base}/api/klines?interval=1m&limit=3`);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "BAD_SYMBOL");

    const malformed = await get(`${app.base}/api/klines?symbol=&interval=1m`);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, "BAD_SYMBOL");
  } finally {
    await app.close();
    await venue.close();
  }
});
