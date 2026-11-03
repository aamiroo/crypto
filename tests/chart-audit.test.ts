import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKlinesStore } from "../backend/src/gateway/klinesStore.js";
import { BybitCollector } from "../backend/src/collector/bybit.js";
import { bus, subject } from "../backend/src/bus.js";
import { intervalOrigin, intervalMs, isSupportedInterval, slotOf } from "../backend/src/intervals.js";
import { isAlignedSlot, toValidTuple } from "../backend/src/candleValidation.js";
import { MAX_GAP_SLOTS, gapHoles, mergeRawKline, missingHistory, slotCount, slotOf as feSlotOf, toCandleBars } from "../frontend/lib/utils/klines.ts";
import type { KlineData } from "../frontend/lib/types.ts";
import { bollinger, ema, macd, rsi, sma } from "../frontend/lib/utils/indicators.ts";

/**
 * The chart-engine audit: every test here is a defect that was found in the
 * running system and the behaviour that now prevents it from coming back.
 *
 * The defects share one shape — a place where the pipeline *believed* something
 * about a candle it had not checked: a window with bars missing at its newest end
 * still claiming to reach the present, slot counts taken from the unix epoch when
 * the exchange opens a week on Monday, a venue field that never arrived turned
 * into a candle priced at zero, and a shortfall reported as one run instead of
 * the whole absence.
 */

const silentLogger = { info() {}, warn() {}, error() {} };
const MIN = 60_000;
const HOUR = 3600e3;
const DAY = 864e5;
const WEEK = 6048e5;

let seq = 0;
function mirror(tag: string) {
  seq += 1;
  return join(tmpdir(), `ct-audit-${process.pid}-${seq}-${tag}.json`);
}
function store(tag: string) {
  return createKlinesStore({ file: mirror(tag), logger: silentLogger });
}

/** A bar on `interval`'s own grid, `n` slots before the slot the market is in. */
function bar(interval: string, n: number, over: Record<string, unknown> = {}) {
  const openTime = slotOf(Date.now(), interval) - n * intervalMs(interval);
  return {
    interval, openTime, closeTime: openTime + intervalMs(interval) - 1,
    open: "100", high: "101", low: "99", close: "100.5", volume: "7",
    closed: true, ...over,
  };
}

/* ── 1. a tail hole is never the live edge ──────────────────────────────── */

test("store: ten absent bars at the newest end stop the window claiming the present", async () => {
  const s = store("tail");
  // A 1 m window that ends ten minutes ago. The old rule asked only "is the
  // newest bar within 3 h", so this answered `current: true` with 180 absent
  // bars' worth of tolerance and the chart painted a frozen edge as live.
  s.remember("BTCUSDT", "1m", Array.from({ length: 20 }, (_, i) => bar("1m", i + 10)));
  const p = s.progress("BTCUSDT", "1m");
  assert.equal(p.current, false, "a window with a tail hole is history, not the edge");
  assert.ok(p.gap && p.gap.bars >= 9, `the tail is reported, got ${JSON.stringify(p.gap)}`);
  assert.equal(s.candles("BTCUSDT", "1m", 50), null, "and it is never served as the recent window");
});

test("store: the bar still forming is not counted as missing", async () => {
  const s = store("forming");
  // One slot short of now is the candle the websocket owns; asking the venue for
  // it would spend a request on a bar that arrives by itself within a minute.
  s.remember("BTCUSDT", "1m", Array.from({ length: 10 }, (_, i) => bar("1m", i + 1)));
  const p = s.progress("BTCUSDT", "1m");
  assert.equal(p.current, true, "the tolerated forming end");
  assert.equal(p.gap, null);
});

/* ── 2. slots are counted on the venue's own grid ───────────────────────── */

test("intervals: a weekly bar does not open on the epoch, and nothing may assume it does", () => {
  // Measured from the exchange, not from a calendar: every genuine weekly candle
  // carries openTime % 604800000 === 345600000 (Monday 00:00 UTC; the epoch is a
  // Thursday). Counting weeks from the epoch is four days off.
  const monday = slotOf(Date.now(), "1w");
  assert.equal(monday % WEEK, 3456e5);
  assert.equal(monday % WEEK, intervalOrigin("1w"));
  assert.notEqual(monday % WEEK, 0, "an epoch grid would place this week somewhere else");
  assert.equal(isAlignedSlot(monday, "1w"), true, "the real bar is aligned");
  assert.equal(isAlignedSlot(monday - DAY, "1w"), false, "a Sunday-origin bar is not");
  assert.equal(slotOf(Date.now(), "1d") % DAY, 0, "daily opens on UTC midnight");
  assert.equal(isSupportedInterval("2h"), false, "and 2 h is not an interval this app serves");
});

test("store: a weekly window is judged in weeks, not in 3-hour ages", async () => {
  const s = store("weekly");
  // Three closed weeks plus the one still forming. The newest bar is up to six
  // days old — legitimately — and the old `max(3 h, 2 * span)` rule could call a
  // window current while a whole week was absent.
  s.remember("BTCUSDT", "1w", Array.from({ length: 4 }, (_, i) => bar("1w", i)));
  assert.equal(s.progress("BTCUSDT", "1w").current, true, "a live weekly edge");
  assert.equal(s.progress("BTCUSDT", "1w").gap, null);

  // Now the same window with two weeks knocked out of its end.
  const s2 = store("weekly-hole");
  s2.remember("BTCUSDT", "1w", Array.from({ length: 4 }, (_, i) => bar("1w", i + 3)));
  const p = s2.progress("BTCUSDT", "1w");
  assert.equal(p.current, false, "two absent weeks are not a forming edge");
  assert.ok(p.gap);
  assert.equal(p.gap.bars, 2, "exactly the absent weeks, no epoch drift");
  assert.equal(p.gap.from % WEEK, intervalOrigin("1w"), "the run starts on a Monday");
  assert.equal(p.gap.to % WEEK, intervalOrigin("1w"), "and ends on one — the crawler asks for bars, not for a Thursday");
});

test("frontend: the chart's own absence count agrees with the gateway's", () => {
  // The badge and the API must not disagree about the same window: the client
  // used to floor `Date.now()` onto the epoch grid too, which for a weekly series
  // reported the newest week as four days early.
  const forming = feSlotOf(Date.now(), "1w");
  assert.equal(forming % WEEK, 3456e5);
  const series = [3, 2, 1, 0].map((n) => {
    const b = bar("1w", n);
    return { ...b, interval: "1w" } as unknown as KlineData;
  });
  assert.deepEqual(missingHistory(series, "1w"), { bars: 0, lagMs: 0 }, "a live weekly series is not behind");

  const holed = [5, 4, 3, 1, 0].map((n) => {
    const b = bar("1w", n);
    return { ...b, interval: "1w" } as unknown as KlineData;
  });
  // One absent week inside the run; the newest bar is the week still forming, so
  // it is not counted — the same tolerance the gateway applies.
  assert.equal(missingHistory(holed, "1w").bars, 1);
  assert.equal(missingHistory(holed, "1w").lagMs, 0, "a Monday series is not four days behind");
});

/* ── 3. no boundary believes a candle it has not checked ────────────────── */

test("validation: a candle is finite, ordered and on its grid — or it is nothing", () => {
  const good = bar("1m", 1);
  assert.ok(toValidTuple(good, "1m"));
  const broken: Array<[string, Record<string, unknown>]> = [
    ["price of zero", { ...good, open: "0" }],
    ["negative price", { ...good, low: "-1" }],
    ["high below the bodies", { ...good, high: "99.5" }],
    ["low above the bodies", { ...good, low: "100.8" }],
    ["high below low", { ...good, high: "98", low: "99" }],
    ["negative volume", { ...good, volume: "-7" }],
    ["NaN field", { ...good, close: "not-a-number" }],
    ["missing field", { ...good, high: undefined }],
    ["no openTime", { ...good, openTime: 0 }],
    ["off the minute grid", { ...good, openTime: good.openTime + 500 }],
  ];
  for (const [what, row] of broken) {
    assert.equal(toValidTuple(row, "1m"), null, `${what} must be rejected`);
  }
});

test("store: a malformed row is never written as a candle and never fills a slot", async () => {
  const s = store("reject");
  const rows = [bar("1m", 3), bar("1m", 2), bar("1m", 1), bar("1m", 0, { open: "0" })];
  s.remember("BTCUSDT", "1m", rows);
  const p = s.progress("BTCUSDT", "1m");
  assert.equal(p.bars, 3, "the zero-priced row is not in the window");
  assert.equal(p.missing?.missing, 0, "and it did not buy the slot back either");
  for (const c of s.candles("BTCUSDT", "1m", 50)!) {
    assert.ok(Number(c.open) > 0 && Number(c.low) > 0, "nothing invented reaches the chart");
  }

  // The same bar on the stream path: `append` used to require only `>= 0`, so a
  // partial websocket frame became a candle priced at zero and was persisted.
  assert.equal(s.append("BTCUSDT", "1m", bar("1m", 5, { close: "0" })), false);
  assert.equal(s.append("BTCUSDT", "1m", bar("1m", 5, { openTime: slotOf(Date.now(), "1m") + 500 })), false);
  assert.equal(s.progress("BTCUSDT", "1m").bars, 3, "the window is unchanged");
});

test("store: rows in a file that are not candles are neither counted nor served", async () => {
  // `load()` used to take `body.candles.length` as the bar count *before*
  // filtering, so junk rows could satisfy a depth target and a window full of
  // them could be declared complete.
  const file = mirror("junk");
  const dir = `${file.replace(/\.json$/, "")}.d`;
  mkdirSync(dir, { recursive: true });
  const tuples = [
    [slotOf(Date.now(), "1m") - 3 * MIN, "100", "101", "99", "100.5", "7"],
    [slotOf(Date.now(), "1m") - 2 * MIN, "0", "0", "0", "0", "0"],
    [slotOf(Date.now(), "1m") - 1 * MIN, "100", "90", "99", "100.5", "7"],
    [slotOf(Date.now(), "1m") + 500, "100", "101", "99", "100.5", "7"],
    [slotOf(Date.now(), "1m"), "100", "101", "99", "100.5", "7"],
  ];
  const body = gzipSync(Buffer.from(JSON.stringify({
    symbol: "BTCUSDT", interval: "1m", at: Date.now(), venue: true, current: true,
    bars: tuples.length, candles: tuples, target: 3,
  })));
  writeFileSync(join(dir, "BTCUSDT_1m.json.gz"), body);

  const s = await createKlinesStore({ file, logger: silentLogger }).load();
  assert.equal(s.progress("BTCUSDT", "1m").bars, 2, "three unusable rows are not bars");
  assert.equal(s.candles("BTCUSDT", "1m", 50)!.length, 2);
});

test("collector: a partial websocket frame publishes nothing", () => {
  const seen: unknown[] = [];
  const topic = subject("bybit", "BTCUSDT", "kline.1m");
  const onRow = (p: unknown) => seen.push(p);
  bus.on(topic, onRow);
  const c = new BybitCollector(silentLogger);
  try {
    const full = { start: slotOf(Date.now(), "1m"), end: slotOf(Date.now(), "1m") + MIN - 1, open: "1", high: "2", low: "0.5", close: "1.5", volume: "3", confirm: false };
    c._handleKline({ topic: "kline.1.BTCUSDT", data: [full] });
    assert.equal(seen.length, 1, "a complete frame still feeds the chart");
    assert.equal((seen[0] as { closeTime: number }).closeTime, full.end, "the venue's own inclusive end is kept");
    for (const missing of ["open", "high", "low", "close", "volume", "start"]) {
      const partial = { ...full } as Record<string, unknown>;
      delete partial[missing];
      c._handleKline({ topic: "kline.1.BTCUSDT", data: [partial] });
    }
    assert.equal(seen.length, 1, "and a frame missing any field is dropped, not zero-filled");
  } finally {
    bus.off(topic, onRow);
    c.close();
  }
});

/* ── 4. a shortfall is the whole shortfall ──────────────────────────────── */

test("store: the reported gap is the next run, the reported total is every run", async () => {
  const s = store("runs");
  // Three runs of five 1 m bars with two absent slots between each pair, ending
  // one bar before the forming slot.
  const rows = [20, 19, 18, 17, 16, 13, 12, 11, 10, 9, 6, 5, 4, 3, 2].map((n) => bar("1m", n));
  s.remember("BTCUSDT", "1m", rows);
  const p = s.progress("BTCUSDT", "1m");
  assert.equal(p.gap?.bars, 2, "the newest run is what gets fetched next");
  assert.equal(p.missing?.missing, 5, "the whole absence is 2 + 2 + the forming end, never 2");
  assert.equal(p.missing?.runs, 3);
  assert.equal(p.missing?.held, 15);
});

test("store: a row count that meets the target still reports its holes", async () => {
  // 100 rows over 199 slots, against a depth target of 100: `bars >= target` is
  // satisfied, and completeness may still not be concluded. What keeps the crawl
  // honest is that the gap and the total absence stay reported either way.
  const s = createKlinesStore({ file: mirror("depth-lie"), logger: silentLogger, depthTargets: { "1m": 100 } });
  const base = slotOf(Date.now(), "1m");
  const rows = Array.from({ length: 100 }, (_, i) => ({ ...bar("1m", 0), openTime: base - (i * 2) * MIN }));
  s.remember("HOLEUSDT", "1m", rows);
  const p = s.progress("HOLEUSDT", "1m");
  assert.equal(p.bars, 100);
  assert.ok(p.bars >= p.target, "the depth target is met by the count alone");
  assert.notEqual(p.gap, null, "and the window is still not whole");
  assert.equal(p.missing?.missing, 99, "every absent slot is named, not just the newest run");
});

/* ── 5. a settled bar is not rewritten by a late tick ───────────────────── */

test("frontend: a forming tick cannot rewind a bar the series already closed", () => {
  const closed = { ...bar("1m", 2), closed: true } as unknown as KlineData;
  const base = [closed];
  const late = { ...bar("1m", 2), closed: false, open: "1", high: "1", low: "1", close: "1", volume: "1" } as unknown as KlineData;
  const after = mergeRawKline(base, late, "1m");
  assert.equal(after[0]!.close, "100.5", "the finalised values stand");

  const correction = { ...bar("1m", 2), close: "100.8" } as unknown as KlineData;
  assert.equal(mergeRawKline(base, correction, "1m")[0]!.close, "100.8", "a venue correction to a closed bar still lands");
  const forming = { ...bar("1m", 0), closed: false, close: "100.8" } as unknown as KlineData;
  assert.equal(mergeRawKline(base, forming, "1m").length, 2, "a new slot still appends");
});

/* ── 6. indicators against independently worked values ──────────────────── */

test("indicators: sma, ema and bollinger match hand-computed values", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  // SMA-seeded, then k = 2/(p+1) = 0.5: 2 -> 0.5*4+0.5*2 = 3 -> 0.5*5+0.5*3 = 4.
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  // Mean of 1..5 is 3; population variance is (4+1+0+1+4)/5 = 2, so the band is
  // 3 ± 2*sqrt(2).
  const bb = bollinger([1, 2, 3, 4, 5], 5, 2);
  assert.equal(bb.middle[4], 3);
  assert.ok(Math.abs(bb.upper[4]! - (3 + 2 * Math.SQRT2)) < 1e-9, `${bb.upper[4]}`);
  assert.ok(Math.abs(bb.lower[4]! - (3 - 2 * Math.SQRT2)) < 1e-9);
});

test("indicators: rsi matches Wilder's smoothing worked by hand", () => {
  // closes 10,11,10,12,13 with period 3: first three deltas are +1,-1,+2, so
  // avgGain = 1 and avgLoss = 1/3 -> RS = 3 -> RSI = 75. The next delta is +1:
  // avgGain = (1*2+1)/3 = 1, avgLoss = ((1/3)*2)/3 = 2/9 -> RS = 4.5 -> 81.8181…
  const out = rsi([10, 11, 10, 12, 13, 12, 14, 15, 14, 16], 3);
  assert.deepEqual(out.slice(0, 3), [null, null, null], "no value before the seed window");
  assert.ok(Math.abs(out[3]! - 75) < 1e-9, `${out[3]}`);
  assert.ok(Math.abs(out[4]! - (100 - 100 / 5.5)) < 1e-9, `${out[4]}`);
  assert.ok(out.every((v, i) => i < 3 ? v === null : v !== null && v >= 0 && v <= 100));
  // One direction only: all gains is 100, all losses is 0.
  for (const v of rsi([1, 2, 3, 4, 5, 6, 7], 3)) if (v !== null) assert.equal(v, 100);
  for (const v of rsi([7, 6, 5, 4, 3, 2, 1], 3)) if (v !== null) assert.equal(v, 0);
});

test("indicators: a flat market has no MACD, and a re-pull equals the live build", () => {
  const flat = Array.from({ length: 60 }, () => 100);
  const { macdLine, signalLine, histogram } = macd(flat);
  for (let i = 0; i < flat.length; i++) {
    if (macdLine[i] !== null) assert.ok(Math.abs(macdLine[i]!) < 1e-9);
    if (signalLine[i] !== null) assert.ok(Math.abs(signalLine[i]!) < 1e-9);
    if (histogram[i] !== null) assert.ok(Math.abs(histogram[i]!) < 1e-9);
  }
  // Historical init == live update: the value the running series produces at the
  // newest bar must be the same one a full recompute produces, or a corrected bar
  // would leave the indicator's tail stale forever.
  const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const s = sma(closes, 5);
  assert.equal(s[4], 12, "the first value sits on the period-1 bar");
  assert.equal(s[10], 18, "and the last on the newest bar");
  const minusOne = sma(closes.slice(0, -1), 5);
  assert.equal(minusOne[6], s[6], "a prefix of the series gives the same value at the same bar");
  const e = ema(closes, 5);
  const ePrefix = ema(closes.slice(0, 10), 5);
  assert.equal(e[9], ePrefix[9], "an indicator over a prefix reads the same at the same bar as over the full run");
  assert.ok(e[10]! > e[9]!, "and the newest bar moves it, so a live update is not ignored");
});

/* ── 6. the axis pays for a hole in real space ──────────────────────────── */

test("chart: a missing bar takes an empty slot instead of vanishing from the axis", () => {
  const ks = [bar("1m", 4), bar("1m", 3), bar("1m", 1), bar("1m", 0)] as unknown as KlineData[];
  const bars = toCandleBars(ks) as { time: number }[];
  assert.equal(slotCount(ks), 5, "four candles plus the slot between them");
  assert.equal(bars.length, 5);
  const hole = bars[2] as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(hole), ["time"], "an empty slot carries a time and no values");
  assert.equal(hole.time, (Number(ks[1].openTime) + MIN) / 1000, "the time it carries is the one the venue owes");
  assert.equal(bars[3]!.time, Number(ks[2].openTime) / 1000, "and the candles keep their own");
  assert.ok(bars.every((b, i) => i === 0 || b.time > bars[i - 1]!.time), "the axis stays strictly ascending");
  assert.equal(gapHoles(ks[1]!, ks[2]!), 1, "one absent bar");
  assert.equal(gapHoles(ks[2]!, ks[3]!), 0, "neighbours leave no room");
});

test("chart: weekly holes take weeks of room, and a huge outage is capped", () => {
  const ks = [bar("1w", 3), bar("1w", 0)] as unknown as KlineData[];
  assert.equal(gapHoles(ks[0]!, ks[1]!), 2, "two absent weeks, not 20 million absent minutes");
  assert.equal(slotCount(ks), 4);
  const bars = toCandleBars(ks) as { time: number }[];
  assert.deepEqual(bars.map((b) => b.time), [
    (Number(ks[0].openTime) - 0) / 1000, (Number(ks[0].openTime) + WEEK) / 1000,
    (Number(ks[0].openTime) + 2 * WEEK) / 1000, Number(ks[1].openTime) / 1000,
  ]);
  const huge = [bar("1m", 40_001), bar("1m", 0)] as unknown as KlineData[];
  assert.equal(gapHoles(huge[0]!, huge[1]!), 40_000);
  assert.equal(slotCount(huge), MAX_GAP_SLOTS + 2, "the axis is bounded; the badge still reports the rest");
});
