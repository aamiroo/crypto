import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useMarketStore, selectKlines } from "../frontend/lib/store/marketStore.ts";
import { loadHistoricalKlines, loadOlderKlines } from "../frontend/lib/api/klines.ts";
import { EMPTY_KLINES, MAX_KLINES, klineKey, normalizeKlines } from "../frontend/lib/utils/klines.ts";
import type { Envelope } from "../frontend/lib/types.ts";

const MIN = 60_000;
const BASE = 1_700_000_000_000;

function raw(openTime: number, close = "105", interval = "1m") {
  const c = Number(close);
  return {
    interval,
    openTime,
    closeTime: openTime + MIN - 1,
    open: "100",
    high: String(Math.max(110, c)),
    low: String(Math.min(90, c)),
    close,
    volume: "10",
    closed: true,
  };
}

function getKlines(symbol: string, interval = "1m") {
  return selectKlines(useMarketStore.getState(), symbol, interval);
}

function status(symbol: string, interval = "1m") {
  return useMarketStore.getState().klineStatus[klineKey(symbol, interval)]?.state;
}

function ascending(list: { openTime: number }[]): boolean {
  for (let i = 1; i < list.length; i++) {
    if (list[i]!.openTime <= list[i - 1]!.openTime) return false;
  }
  return true;
}

/** Push a single live kline through the same path the WS feed uses. */
function live(symbol: string, k: { interval: string; openTime: number } & Record<string, unknown>) {
  const env: Envelope = { type: "kline", channel: "kline", symbol, ts: Date.now(), data: k };
  useMarketStore.getState().applyEnvelope(env);
}

/** Seed a window the way a finished `loadHistoricalKlines` leaves it: merged
 *  candles plus `ready` status, which is what unlocks backfill. */
function seedWindow(symbol: string, firstOpenTimeIndex: number, count: number, interval = "1m") {
  useMarketStore.getState().mergeKlinesInto(symbol, interval, normalizeKlines(
    Array.from({ length: count }, (_, i) => raw(BASE + (firstOpenTimeIndex + i) * MIN)),
    interval,
  ));
  useMarketStore.getState().setKlineStatus(symbol, interval, "ready");
}

// ── live store merge: the crash scenarios ─────────────────────────────────

test("store: live klines then REST window then out-of-order replay stays sorted", () => {
  const sym = "T1";
  // 1) live ticks arrive first (hub replay / fast tick before REST resolves)
  live(sym, raw(BASE + 400 * MIN));
  live(sym, raw(BASE + 401 * MIN));
  // 2) REST historical window merges in (older + overlapping bars)
  useMarketStore.getState().mergeKlinesInto(sym, "1m", normalizeKlines([398, 399, 400, 401].map((n) => raw(BASE + n * MIN)), "1m"));
  // 3) old replay batch (out of order vs current array) arrives on resubscribe
  live(sym, raw(BASE + 100 * MIN));
  live(sym, raw(BASE + 101 * MIN));

  const ks = getKlines(sym);
  assert.equal(ks.length, 6, "100,101,398,399,400,401");
  assert.ok(ascending(ks), "strictly ascending after interleaved merges");
  assert.equal(ks[0]!.openTime, BASE + 100 * MIN);
  assert.equal(ks[ks.length - 1]!.openTime, BASE + 401 * MIN);
});

test("store: duplicate forming-candle updates are collapsed to one bar", () => {
  const sym = "T2";
  live(sym, raw(BASE + 500 * MIN, "1"));
  live(sym, raw(BASE + 500 * MIN, "2"));
  live(sym, raw(BASE + 500 * MIN, "3"));
  const ks = getKlines(sym);
  assert.equal(ks.length, 1);
  assert.equal(ks[0]!.close, "3");
});

test("store: invalid kline payloads are ignored", () => {
  const sym = "T3";
  live(sym, { interval: "1m", openTime: NaN } as never);
  useMarketStore.getState().applyEnvelope({ type: "kline", symbol: sym, ts: Date.now(), data: { foo: 1 } } as Envelope);
  live(sym, raw(BASE + 600 * MIN));
  const ks = getKlines(sym);
  assert.equal(ks.length, 1);
  assert.equal(ks[0]!.openTime, BASE + 600 * MIN);
});

test("store: selector returns a stable empty reference (no re-render churn)", () => {
  const s = useMarketStore.getState();
  const a = selectKlines(s, "NO_DATA_SYM", "1m");
  const b = selectKlines(useMarketStore.getState(), "NO_DATA_SYM", "1m");
  assert.equal(a, EMPTY_KLINES);
  assert.equal(a, b);
});

test("store: kline window is capped at MAX_KLINES", () => {
  const sym = "T4";
  const big = Array.from({ length: MAX_KLINES + 10 }, (_, i) => raw(BASE + i * MIN));
  useMarketStore.getState().mergeKlinesInto(sym, "1m", normalizeKlines(big, "1m"));
  const ks = getKlines(sym);
  assert.equal(ks.length, MAX_KLINES);
  assert.equal(ks[0]!.openTime, BASE + 10 * MIN, "oldest trimmed, newest kept");
  assert.ok(ascending(ks));
});

test("store: setKlineStatus records state and error message", () => {
  const sym = "T5";
  useMarketStore.getState().setKlineStatus(sym, "5m", "error", "boom");
  assert.equal(status(sym, "5m"), "error");
  assert.equal(useMarketStore.getState().klineStatus[klineKey(sym, "5m")]!.error, "boom");
});

// ── REST historical loader (fetch stubbed) ────────────────────────────────

interface StubResponse { ok: boolean; status?: number; body: unknown; delayMs?: number }
let fetchCalls: string[] = [];
let fetchResponder: (url: string) => StubResponse;

function installFetch() {
  fetchCalls = [];
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    fetchCalls.push(url);
    const r = fetchResponder(url);
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body,
    };
  };
}

const okBatch = (data: unknown[]): StubResponse => ({ ok: true, body: { data } });

beforeEach(() => {
  installFetch();
  fetchResponder = () => okBatch([]);
});

test("loadHistoricalKlines: loading -> ready and populates sorted data", async () => {
  const sym = "H1";
  fetchResponder = () => okBatch([300, 301, 302].map((n) => raw(BASE + n * MIN)));

  const p = loadHistoricalKlines(sym, "1m");
  assert.equal(status(sym, "1m"), "loading", "status flips to loading synchronously");
  assert.equal(await p, true);

  assert.equal(status(sym, "1m"), "ready");
  const ks = getKlines(sym);
  assert.equal(ks.length, 3);
  assert.ok(ascending(ks));
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0]!.includes("limit=500"));
  assert.ok(!fetchCalls[0]!.includes("endTime"), "initial load needs no endTime");
});

test("loadHistoricalKlines: HTTP failure -> error status", async () => {
  const sym = "H2";
  fetchResponder = () => ({ ok: false, status: 403, body: { error: "blocked" } });
  assert.equal(await loadHistoricalKlines(sym, "1m"), false);
  assert.equal(status(sym, "1m"), "error");
  assert.equal(getKlines(sym).length, 0);
});

test("loadHistoricalKlines: malformed body -> error status", async () => {
  const sym = "H3";
  fetchResponder = () => ({ ok: true, body: { unexpected: true } });
  assert.equal(await loadHistoricalKlines(sym, "1m"), false);
  assert.equal(status(sym, "1m"), "error");
});

test("loadHistoricalKlines: concurrent calls collapse into one fetch", async () => {
  const sym = "H4";
  fetchResponder = () => ({ ok: true, body: { data: [raw(BASE + MIN)] }, delayMs: 20 });

  const p1 = loadHistoricalKlines(sym, "1m");
  const p2 = loadHistoricalKlines(sym, "1m");
  const results = await Promise.all([p1, p2]);
  assert.deepEqual(results, [true, false], "second call deduped while in flight");
  assert.equal(fetchCalls.length, 1);
  assert.equal(status(sym, "1m"), "ready");
});

test("loadOlderKlines: fetches a window ending at the oldest candle and merges", async () => {
  const sym = "O1";
  seedWindow(sym, 1000, 100);
  const oldestBefore = getKlines(sym)[0]!.openTime;

  fetchResponder = () => okBatch(Array.from({ length: 50 }, (_, i) => raw(BASE + (950 + i) * MIN)));

  assert.equal(await loadOlderKlines(sym, "1m"), true);
  assert.ok(
    fetchCalls[0]!.includes(`endTime=${oldestBefore}`),
    `backfill must ask for data before the oldest candle: ${fetchCalls[0]}`,
  );
  const ks = getKlines(sym);
  assert.equal(ks.length, 150);
  assert.ok(ascending(ks), "backfilled older page merged in order");
  assert.equal(ks[0]!.openTime, BASE + 950 * MIN);
});

test("loadOlderKlines: is rate-limited by cooldown", async () => {
  const sym = "O2";
  seedWindow(sym, 2000, 100);
  // Always serve 50 candles strictly older than whatever the window's oldest is.
  fetchResponder = () => {
    const oldest = getKlines(sym)[0]!.openTime;
    return okBatch(Array.from({ length: 50 }, (_, i) => raw(oldest - (50 - i) * MIN)));
  };

  // limit=50 with a full 50-row page => not exhausted, so the cooldown is what
  // blocks the follow-up call.
  assert.equal(await loadOlderKlines(sym, "1m", 50), true);
  const calls = fetchCalls.length;
  assert.equal(await loadOlderKlines(sym, "1m", 50), false, "immediate second call blocked by cooldown");
  assert.equal(fetchCalls.length, calls, "no extra fetch issued");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 5_000;
    assert.equal(await loadOlderKlines(sym, "1m", 50), true);
    assert.equal(fetchCalls.length, calls + 1);
  } finally {
    Date.now = realNow;
  }
});

test("loadOlderKlines: partial page marks history exhausted", async () => {
  const sym = "O3";
  seedWindow(sym, 3000, 100);
  fetchResponder = () => okBatch(Array.from({ length: 5 }, (_, i) => raw(BASE + (2995 + i) * MIN)));

  assert.equal(await loadOlderKlines(sym, "1m"), true);
  const calls = fetchCalls.length;

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 5_000;
    assert.equal(await loadOlderKlines(sym, "1m"), false, "exhausted after partial page");
    assert.equal(fetchCalls.length, calls, "no fetch when exhausted");
  } finally {
    Date.now = realNow;
  }
});

test("loadOlderKlines: refuses to fetch when the window is already at MAX_KLINES", async () => {
  const sym = "O4";
  seedWindow(sym, 0, MAX_KLINES);
  assert.equal(await loadOlderKlines(sym, "1m"), false);
  assert.equal(fetchCalls.length, 0);
});

test("loadOlderKlines: waits for the recent window instead of backfilling live bars", async () => {
  const sym = "O6";
  live(sym, raw(BASE + 400 * MIN));
  live(sym, raw(BASE + 401 * MIN));
  assert.equal(await loadOlderKlines(sym, "1m"), false, "no backfill before the first REST window");
  assert.equal(fetchCalls.length, 0);

  useMarketStore.getState().setKlineStatus(sym, "1m", "ready");
  fetchResponder = () => okBatch(Array.from({ length: 50 }, (_, i) => raw(BASE + (350 + i) * MIN)));
  assert.equal(await loadOlderKlines(sym, "1m", 50), true, "backfill unlocks once the window is ready");
});

test("loadOlderKlines: no existing data -> no fetch", async () => {
  assert.equal(await loadOlderKlines("O5_UNKNOWN", "1m"), false);
  assert.equal(fetchCalls.length, 0);
});
