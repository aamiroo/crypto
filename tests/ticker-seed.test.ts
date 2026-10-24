import { test } from "node:test";
import assert from "node:assert/strict";
import { startTickerSeed } from "../backend/src/collector/tickers.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The seed retries on a timer, so the stub has to stay installed for the whole
 *  window being asserted — restoring it right after the first tick would let
 *  later ticks reach the network. */
async function seedAgainst(handler, assertions) {
  const prev = globalThis.fetch;
  globalThis.fetch = handler;
  const warns = [];
  let stop = () => {};
  try {
    stop = startTickerSeed({
      logger: { info() {}, warn: (m, o) => warns.push(`${m}:${o && o.failures}`) },
      getSymbols: () => ["BTCUSDT"],
      intervalMs: 10,
    });
    await sleep(90);
    assertions({ warns });
  } finally {
    stop();
    globalThis.fetch = prev;
  }
}

test("ticker seed: a region-blocked bulk snapshot disables the seed after one attempt", async () => {
  let calls = 0;
  await seedAgainst(
    async () => { calls += 1; return { ok: false, status: 403 }; },
    ({ warns }) => {
      assert.equal(calls, 1, "the blocked endpoint must not be retried every tick");
      assert.match(warns.join("|"), /blocked by venue CDN/);
    },
  );
});

test("ticker seed: a transient failure keeps retrying but logs the first one only", async () => {
  let calls = 0;
  await seedAgainst(
    async () => { calls += 1; throw new Error("ECONNRESET"); },
    ({ warns }) => {
      assert.ok(calls > 1, "a hiccup must stay recoverable");
      assert.equal(warns.filter((w) => w.startsWith("ticker seed failed")).length, 1);
    },
  );
});
