import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useMarketStore, selectKlines } from "../frontend/lib/store/marketStore.ts";
import { loadHistoricalKlines, loadOlderKlines, refreshRecentKlines, hasRecentTail } from "../frontend/lib/api/klines.ts";
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

/** A page the venue really served, with an older page fetchable behind it. Only
 *  then is the window worth widening. */
const okBatch = (data: unknown[]): StubResponse => ({ ok: true, body: { data, meta: { venueBacked: true, canGoOlder: true } } });
/** The same candles answered from a stream-fed mirror window — real bars, but no
 *  exchange history behind them. */
const mirrorBatch = (data: unknown[]): StubResponse => ({ ok: true, body: { data, meta: { venueBacked: false, canGoOlder: true } } });
/** Venue history the gateway cannot go deeper on right now (its window is in the
 *  cool-off a refusal put it in). */
const blockedOlderBatch = (data: unknown[]): StubResponse => ({ ok: true, body: { data, meta: { venueBacked: true, canGoOlder: false } } });

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
  assert.ok(fetchCalls[0]!.includes("limit=1000"), "opens with the largest page the gateway serves");
  assert.ok(!fetchCalls[0]!.includes("endTime"), "initial load needs no endTime");
});

test("loadHistoricalKlines: a full opening page is widened once", async () => {
  const sym = "H1b";
  const page = (oldest: number) => okBatch(Array.from({ length: 1000 }, (_, i) => raw(BASE + (oldest + i) * MIN)));
  let pages = 0;
  fetchResponder = () => { pages++; return page(pages === 1 ? 20_000 : 10_000); };

  assert.equal(await loadHistoricalKlines(sym, "1m"), true);
  assert.equal(fetchCalls.length, 2, "a full page says there is more behind it, so it is followed up");
  assert.ok(fetchCalls[1]!.includes("endTime="), "the follow-up asks for the older page");

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getKlines(sym).length, 2000, "both pages landed in order");
  const before = fetchCalls.length;
  assert.equal(await loadHistoricalKlines(sym, "1m"), true);
  assert.equal(fetchCalls.length, before + 1, "widening is once per window, not per refresh");
});

test("prime: a stream-fed mirror page is the same length but is not widened", async () => {
  const sym = "H1c";
  // 1000 candles, so by count alone this looks exactly like an exchange page —
  // and the old code spent a doomed second round trip on it.
  const full = Array.from({ length: 1000 }, (_, i) => raw(BASE + (20_000 + i) * MIN));
  fetchResponder = () => mirrorBatch(full);

  assert.equal(await loadHistoricalKlines(sym, "1m"), true);
  assert.equal(getKlines(sym).length, 1000);
  assert.equal(fetchCalls.length, 1, "the gateway said this window has no venue history behind it");
  assert.ok(!fetchCalls[0]!.includes("endTime"), "so no older page is requested");
});

test("prime: a window that already reaches the target is not widened", async () => {
  const sym = "H1d";
  seedWindow(sym, 20_000, 2000);
  fetchResponder = () => okBatch(Array.from({ length: 1000 }, (_, i) => raw(BASE + (21_000 + i) * MIN)));

  assert.equal(await loadHistoricalKlines(sym, "1m"), true);
  assert.equal(fetchCalls.length, 1, "2000 candles on hand is already the history target");
});

test("prime: a window the venue refuses right now is not followed up", async () => {
  const sym = "H1f";
  // Real history, so a deeper page would be meaningful — but the gateway just
  // said it cannot fetch one. Asking anyway is the request this stage removes.
  fetchResponder = () => blockedOlderBatch(Array.from({ length: 1000 }, (_, i) => raw(BASE + (20_000 + i) * MIN)));

  assert.equal(await loadHistoricalKlines(sym, "1m"), true);
  assert.equal(getKlines(sym).length, 1000);
  assert.equal(fetchCalls.length, 1, "the gateway said no older page is reachable");
  assert.ok(!fetchCalls[0]!.includes("endTime"));

  // The refusal is temporary state, not a property of the window: the widening
  // still happens once the gateway can fetch again.
  fetchResponder = (url) => (url.includes("endTime")
    ? okBatch(Array.from({ length: 5 }, (_, i) => raw(BASE + (19_995 + i) * MIN)))
    : blockedOlderBatch(Array.from({ length: 1000 }, (_, i) => raw(BASE + (20_000 + i) * MIN))));
  assert.equal(await loadHistoricalKlines(sym, "1m"), true);
  assert.equal(fetchCalls.length, 2, "recovered reachability widens the window");
});

test("prime: the follow-up asks only for what the window is short of", async () => {
  const sym = "H1e";
  seedWindow(sym, 20_000, 1700);
  // The page lands on candles the window already holds, so on-hand history stays
  // at 1700 and the shortfall — 300 — is what the second request should ask for.
  fetchResponder = (url) => (url.includes("endTime")
    ? okBatch(Array.from({ length: 300 }, (_, i) => raw(BASE + (19_700 + i) * MIN)))
    : okBatch(Array.from({ length: 1000 }, (_, i) => raw(BASE + (20_700 + i) * MIN))));

  assert.equal(await loadHistoricalKlines(sym, "1m"), true);
  assert.equal(fetchCalls.length, 2, "1700 on hand is below the target, so it is widened");
  assert.ok(fetchCalls[1]!.includes("limit=300"), `asked for the shortfall, not a full page: ${fetchCalls[1]}`);
  await new Promise((r) => setTimeout(r, 20)); // the widening is fire-and-forget by design
  assert.equal(getKlines(sym).length, 2000, "the widened window lands in order");
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
    fetchCalls[0]!.includes(`endTime=${oldestBefore - 1}`),
    `backfill must ask for the page strictly before the oldest candle: ${fetchCalls[0]}`,
  );
  const ks = getKlines(sym);
  assert.equal(ks.length, 150);
  assert.ok(ascending(ks), "backfilled older page merged in order");
  assert.equal(ks[0]!.openTime, BASE + 950 * MIN);
});

test("loadOlderKlines: a good page is followed up at once, a failed one waits", async () => {
  const sym = "O2";
  seedWindow(sym, 2000, 100);
  // Always serve 50 candles strictly older than whatever the window's oldest is.
  const olderPage = () => {
    const oldest = getKlines(sym)[0]!.openTime;
    return okBatch(Array.from({ length: 50 }, (_, i) => raw(oldest - (50 - i) * MIN)));
  };
  fetchResponder = olderPage;

  // limit=50 with a full 50-row page => not exhausted. Scroll-back has to keep
  // walking, so a successful page must not throttle the next one.
  assert.equal(await loadOlderKlines(sym, "1m", 50), true);
  const afterFirst = fetchCalls.length;
  assert.equal(await loadOlderKlines(sym, "1m", 50), true, "next page fetched immediately");
  assert.equal(fetchCalls.length, afterFirst + 1, "follow-up page issued");

  // An unreachable gateway is a different story: one failed page buys a backoff,
  // otherwise every scroll tick re-requests a page that cannot arrive.
  fetchResponder = () => ({ ok: false, status: 502, body: { error: "Bybit HTTP 403" } });
  assert.equal(await loadOlderKlines(sym, "1m", 50), false);
  const afterFailure = fetchCalls.length;
  assert.equal(await loadOlderKlines(sym, "1m", 50), false, "backoff after a failed page");
  assert.equal(fetchCalls.length, afterFailure, "no fetch issued during backoff");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 6_000;
    fetchResponder = olderPage;
    assert.equal(await loadOlderKlines(sym, "1m", 50), true, "fetches again once the backoff expires");
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

// ── REST vs live: a slow page must not rewind the chart ────────────────────

test("a page resolving after a live tick keeps the streamed forming candle", async () => {
  const sym = "L1";
  seedRecent(sym, [3, 2]);
  const forming = nowBar(1);
  const bar = (close: string, closed: boolean) => ({ ...raw(forming, close), closed });
  // The gateway answers with a snapshot taken before the tick: same bar, older values.
  fetchResponder = () => ({
    ok: true,
    delayMs: 40,
    body: { data: [raw(nowBar(3)), raw(nowBar(2)), bar("50", false)], meta: { venueBacked: true, canGoOlder: false } },
  });

  const p = loadHistoricalKlines(sym, "1m");
  live(sym, bar("99", false)); // the stream touches the forming bar mid-flight
  await p;

  const ks = getKlines(sym);
  assert.equal(ks.length, 3);
  assert.equal(ks[ks.length - 1]!.openTime, forming);
  assert.equal(ks[ks.length - 1]!.close, "99", "the page is older than the tick, so it loses");
});

test("a page still finalizes a bar the stream left open", async () => {
  // Protection must not turn into "REST never applies": the venue's closed
  // version of a bar is better information than the open one the stream wrote.
  const sym = "L2";
  seedRecent(sym, [3, 2]);
  const forming = nowBar(2);
  live(sym, { ...raw(forming, "99"), closed: false });
  fetchResponder = () => ({
    ok: true,
    body: { data: [raw(forming, "60")], meta: { venueBacked: true, canGoOlder: false } },
  });

  await loadHistoricalKlines(sym, "1m");
  const ks = getKlines(sym);
  const last = ks[ks.length - 1]!;
  assert.equal(last.openTime, forming);
  assert.equal(last.close, "60", "the closed page replaces the open stream bar");
  assert.equal(last.closed, true);
});

// ── tail refresh: the right-hand edge must keep reaching the present ──────

/** openTime of the bar `minutesAgo` minutes back, aligned to the 1m grid. */
function nowBar(minutesAgo: number, interval = "1m"): number {
  const span = interval === "1h" ? 3_600_000 : 60_000;
  return Math.floor((Date.now() - minutesAgo * span) / span) * span;
}

/** Seed a window around the present the way a finished load leaves it. */
function seedRecent(symbol: string, minutesAgo: number[], interval = "1m") {
  useMarketStore.getState().mergeKlinesInto(
    symbol,
    interval,
    normalizeKlines(minutesAgo.map((m) => raw(nowBar(m), "105", interval)), interval),
  );
  useMarketStore.getState().setKlineStatus(symbol, interval, "ready");
}

test("hasRecentTail: judges a window by its newest bar, not its length", () => {
  assert.equal(hasRecentTail([]), false, "an empty window is not live");
  assert.equal(hasRecentTail(normalizeKlines([raw(BASE + MIN)], "1m")), false, "2023 data is stale");
  assert.equal(hasRecentTail(normalizeKlines([raw(nowBar(10)), raw(nowBar(9))], "1m")), false);
  assert.equal(hasRecentTail(normalizeKlines([raw(nowBar(2))], "1m")), true);
  // A 4h bar opened 3h ago still covers now, so it must not be re-pulled.
  assert.equal(hasRecentTail(normalizeKlines([raw(nowBar(3, "4h"), "105", "4h")], "4h")), true);
});

test("refreshRecentKlines: leaves a live window alone", async () => {
  const sym = "R1";
  seedRecent(sym, [3, 2, 1]);
  assert.equal(await refreshRecentKlines(sym, "1m"), true);
  assert.equal(fetchCalls.length, 0, "no round trip when the chart already reaches now");
});

test("refreshRecentKlines: re-pulls a tail that stopped advancing", async () => {
  const sym = "R2";
  seedRecent(sym, [12, 11, 10]); // frozen ten minutes ago
  assert.equal(hasRecentTail(getKlines(sym)), false);

  fetchResponder = () => okBatch([nowBar(2), nowBar(1)].map((t) => raw(t)));
  assert.equal(await refreshRecentKlines(sym, "1m"), true);
  assert.equal(fetchCalls.length, 1);
  assert.ok(hasRecentTail(getKlines(sym)), "the healed window reaches the present");
});

test("refreshRecentKlines: stays out of the way while a load is pending or failing", async () => {
  const sym = "R3";
  seedRecent(sym, [20, 19]);
  useMarketStore.getState().setKlineStatus(sym, "1m", "error", "Bybit HTTP 403");
  assert.equal(await refreshRecentKlines(sym, "1m"), false);
  assert.equal(fetchCalls.length, 0, "the retry ladder owns this window");
});

test("refreshRecentKlines: rate-limits so repeated events cannot re-arm the ladder", async () => {
  const sym = "R4";
  seedRecent(sym, [30, 29]);
  // Gateway keeps answering from a stale cache, so the tail stays frozen.
  fetchResponder = () => okBatch([raw(nowBar(25))]);
  assert.equal(await refreshRecentKlines(sym, "1m"), false);
  assert.equal(await refreshRecentKlines(sym, "1m"), false);
  // One refresh; the second call falls inside the refresh floor. A short page is
  // not followed up — that is the exchange saying there is nothing older.
  assert.equal(fetchCalls.length, 1, "the second refresh falls inside the refresh floor");
  assert.equal(await refreshRecentKlines(sym, "1m"), false);
  assert.equal(fetchCalls.length, 1, "and a third event still sends nothing");
});

// ── M5b: the gateway's history state, not a page length, ends a scroll ──────

/** The same venue page plus the crawl state the gateway now reports with it. */
const deepBatch = (data: unknown[], history: Record<string, unknown>): StubResponse => ({
  ok: true,
  body: { data, meta: { venueBacked: true, canGoOlder: true, source: "venue", history } },
});

test("loadOlderKlines: the gateway saying history ended stops the scroll on a full page", async () => {
  const sym = "M1_END";
  seedWindow(sym, 3000, 100);
  // A full page (which normally means "keep walking") that the gateway labels as
  // the exchange's last word: the venue ended the range behind it.
  fetchResponder = () => deepBatch(
    Array.from({ length: 50 }, (_, i) => raw(BASE + (2950 + i) * MIN)),
    { target: 10000, bars: 150, status: "exhausted" },
  );
  assert.equal(await loadOlderKlines(sym, "1m", 50), true, "the page itself is still merged");
  assert.equal(getKlines(sym).length, 150);

  const calls = fetchCalls.length;
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60_000;
    assert.equal(await loadOlderKlines(sym, "1m", 50), false, "an ended history is not probed again");
    assert.equal(fetchCalls.length, calls, "and it costs no request");
  } finally {
    Date.now = realNow;
  }
});

test("loadOlderKlines: a full browser series is a cap, not the end of history", async () => {
  const sym = "M2_CAP";
  seedWindow(sym, 0, MAX_KLINES);
  assert.equal(await loadOlderKlines(sym, "1m"), false);
  assert.equal(fetchCalls.length, 0, "the series is already at the browser's ceiling");

  // The browser shedding bars (a narrower window, a reload) reopens the scroll:
  // a cap is a resource decision, so it must not outlive the condition that made
  // it. An ended history would have stayed shut whatever the series looked like.
  useMarketStore.setState((st) => ({
    klines: { ...st.klines, [sym]: { ...st.klines[sym]!, "1m": getKlines(sym).slice(-1000) } },
  }));
  fetchResponder = () => okBatch(Array.from({ length: 50 }, (_, i) => raw(BASE + (MAX_KLINES - 1050 + i) * MIN)));
  assert.equal(await loadOlderKlines(sym, "1m", 50), true, "scroll-back works again with room");
});

test("loadHistoricalKlines: a mirror already deeper than the first screen costs no second page", async () => {
  const sym = "M3_PRIME";
  // The gateway's crawl has the window to 4000 bars; the client asked for 1000.
  fetchResponder = () => deepBatch(
    Array.from({ length: 1000 }, (_, i) => raw(BASE + (20_000 + i) * MIN)),
    { target: 10000, bars: 4000, status: "crawling" },
  );
  assert.equal(await loadHistoricalKlines(sym, "1m"), true);
  assert.equal(fetchCalls.length, 1, "the widening page would only duplicate what the mirror already holds");
  assert.equal(getKlines(sym).length, 1000, "and the chart still starts from the page it asked for");
});

test("loadHistoricalKlines: a shallow mirror is still widened by the client", async () => {
  const sym = "M4_PRIME";
  // The mirror holds only the one page it was asked for, so the client's own
  // widening page is real history and has to be fetched.
  fetchResponder = (url) => (url.includes("endTime")
    ? deepBatch(Array.from({ length: 1000 }, (_, i) => raw(BASE + (29_000 + i) * MIN)),
      { target: 10000, bars: 2000, status: "idle" })
    : deepBatch(Array.from({ length: 1000 }, (_, i) => raw(BASE + (30_000 + i) * MIN)),
      { target: 10000, bars: 1000, status: "idle" }));
  assert.equal(await loadHistoricalKlines(sym, "1m"), true);
  assert.equal(fetchCalls.length, 2, "one page is the chart's, the second is the first screen's history");
  // The widening page is fire-and-forget by design: the first paint never waits
  // for it, so it lands on a later tick.
  for (let i = 0; i < 50 && getKlines(sym).length < 2000; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(getKlines(sym).length, 2000, "and it arrives without a second request");
});
