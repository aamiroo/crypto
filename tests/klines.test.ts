import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_KLINES,
  MAX_KLINES,
  klineKey,
  normalizeKline,
  normalizeKlines,
  mergeKlines,
  mergeRawKline,
  diffKlines,
  toCandleBars,
  toIndicatorBars,
  toLineBars,
  toVolumeBars,
  buildTimeIndex,
  missingHistory,
  switchVisibleRange,
  SWITCH_VISIBLE_BARS,
  SWITCH_RIGHT_PAD,
} from "../frontend/lib/utils/klines.ts";
import type { KlineData } from "../frontend/lib/types.ts";

const MIN = 60_000;
const BASE = 1_700_000_000_000; // 2023-11-15T00:00:00Z (past the epoch sanity floor)

/** Well-formed raw kline; extra lets a test break exactly one field. */
function raw(openTime: number, extra: Record<string, unknown> = {}) {
  const close = Number(extra.close ?? "105");
  const open = Number(extra.open ?? "100");
  const high = Number(extra.high ?? Math.max(110, open, close));
  const low = Number(extra.low ?? Math.min(90, open, close));
  return {
    interval: "1m",
    openTime,
    closeTime: openTime + MIN - 1,
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: "10",
    closed: true,
    ...extra,
  };
}

function norm(n: number, close = "105"): KlineData {
  return normalizeKline(raw(BASE + n * MIN, { close }), "1m")!;
}

const NOW = Math.floor(Date.now() / MIN) * MIN;

/** A bar `n` minutes before the present. Missing history is counted against the
 *  minute the market is in now, so a fixture parked in 2023 is a window with
 *  three years absent and nothing else — these tests need bars that are due. */
function live(n: number): KlineData {
  return normalizeKline(raw(NOW - n * MIN), "1m")!;
}

function ascending(list: KlineData[]): boolean {
  for (let i = 1; i < list.length; i++) {
    if (list[i]!.openTime <= list[i - 1]!.openTime) return false;
  }
  return true;
}

// ── validation / normalization ────────────────────────────────────────────

test("normalizeKline accepts valid data and coerces strings", () => {
  const k = normalizeKline(raw(BASE + 123_000));
  assert.ok(k);
  assert.equal(k.openTime, BASE + 123_000);
  assert.equal(k.close, "105");
  assert.equal(k.closeTime, BASE + 123_000 + MIN - 1);
});

test("normalizeKline rejects garbage", () => {
  assert.equal(normalizeKline(null), null);
  assert.equal(normalizeKline({}), null);
  assert.equal(normalizeKline(raw(BASE, { open: "not-a-number" })), null);
  assert.equal(normalizeKline(raw(BASE, { open: "0" })), null, "non-positive price");
  assert.equal(normalizeKline(raw(BASE, { high: "80" })), null, "high below low");
  assert.equal(normalizeKline(raw(BASE, { volume: "-1" })), null);
  assert.equal(normalizeKline({ ...raw(BASE), close: "1000" }), null, "close above high");
  assert.equal(normalizeKline(raw(42)), null, "epoch sanity floor");
  assert.equal(normalizeKline(raw(BASE, { interval: "7m" })), null, "unknown interval");
  assert.equal(normalizeKline(raw(BASE, { interval: undefined }), undefined), null, "no interval");
  assert.equal(normalizeKline(raw(BASE, { interval: undefined }), "1m")!.interval, "1m", "fallback interval");
});

test("normalizeKlines sorts descending input ascending and de-duplicates", () => {
  const input = [
    raw(BASE + 3 * MIN),
    raw(BASE + 1 * MIN),
    raw(BASE + 2 * MIN),
    raw(BASE + 2 * MIN, { close: "999" }), // duplicate — later wins
    raw(BASE, { open: "broken" }), // invalid — dropped
  ];
  const out = normalizeKlines(input, "1m");
  assert.equal(out.length, 3);
  assert.ok(ascending(out));
  const dup = out.find((k) => k.openTime === BASE + 2 * MIN);
  assert.equal(dup!.close, "999");
});

test("normalizeKlines caps to MAX_KLINES keeping newest", () => {
  const input = Array.from({ length: MAX_KLINES + 100 }, (_, i) => raw(BASE + i * MIN));
  const out = normalizeKlines(input, "1m");
  assert.equal(out.length, MAX_KLINES);
  assert.equal(out[out.length - 1]!.openTime, BASE + (MAX_KLINES + 99) * MIN);
  assert.ok(ascending(out));
});

// ── merge ─────────────────────────────────────────────────────────────────

test("mergeKlines appends newer candles sorted", () => {
  const base = [norm(100), norm(101)];
  const next = mergeKlines(base, [norm(102), norm(103)]);
  assert.deepEqual(next.map((k) => k.openTime), [100, 101, 102, 103].map((n) => BASE + n * MIN));
  assert.equal(base.length, 2, "input untouched");
});

test("mergeKlines replaces the forming candle in place", () => {
  const base = [norm(100, "105")];
  const next = mergeKlines(base, norm(100, "106"));
  assert.equal(next.length, 1);
  assert.equal(next[0]!.close, "106");
  assert.ok(ascending(next));
});

test("mergeKlines keeps identical data as the SAME reference (no re-render)", () => {
  const base = [norm(100), norm(101)];
  const next = mergeKlines(base, norm(101));
  assert.equal(next, base);
});

test("mergeKlines inserts out-of-order replay in the middle (reconnect replay)", () => {
  // Live REST window (newest) followed by an old WS replay from the hub.
  const base = [norm(400), norm(401), norm(402)];
  const replayed = [norm(100), norm(101), norm(402)];
  const next = mergeKlines(base, replayed);
  assert.equal(next.length, 5);
  assert.ok(ascending(next), "array must stay strictly ascending");
  assert.equal(next[0]!.openTime, BASE + 100 * MIN);
  assert.equal(next[next.length - 1]!.openTime, BASE + 402 * MIN);
});

test("mergeKlines drops duplicates across sources", () => {
  const base = [norm(100, "101")];
  const next = mergeKlines(base, [norm(100, "102"), norm(100, "103")]);
  assert.equal(next.length, 1);
  assert.equal(next[0]!.close, "103", "later source wins");
});

test("mergeKlines keeps the stored candle when precedence says so", () => {
  // The REST-vs-live case: the candle on hand came from the stream, the page is
  // an older snapshot of the same bar.
  const stored = { ...norm(100, "105"), closed: false };
  const snapshot = { ...norm(100, "90"), closed: false };
  const next = mergeKlines([stored], [snapshot], (a, b) => a.closed === b.closed);
  assert.equal(next[0]!.close, "105", "the protected candle survives");
  assert.equal(next[0]!, stored, "and keeps its identity, so nothing re-renders");
  // With no protection the same page overwrites it — which is the bug.
  assert.equal(mergeKlines([stored], [snapshot])[0]!.close, "90");
});

test("mergeKlines: the linear bulk path agrees with the per-candle path", () => {
  const base = Array.from({ length: 400 }, (_, i) => norm(i));
  const page = Array.from({ length: 250 }, (_, i) => norm(300 + i, "120"));
  let stepwise = base;
  for (const k of page) stepwise = mergeKlines(stepwise, k);
  const bulk = mergeKlines(base, page);
  assert.deepEqual(bulk.map((k) => [k.openTime, k.close]), stepwise.map((k) => [k.openTime, k.close]));
  assert.equal(bulk.length, 550, "overlapping page adds only the older rows");
  assert.ok(ascending(bulk));
});

test("mergeKlines caps the merged window", () => {
  const base = Array.from({ length: MAX_KLINES }, (_, i) => norm(i));
  const next = mergeKlines(base, norm(MAX_KLINES));
  assert.equal(next.length, MAX_KLINES);
  assert.equal(next[0]!.openTime, BASE + 1 * MIN, "oldest dropped");
  assert.ok(ascending(next));
});

test("mergeRawKline ignores invalid payloads", () => {
  const base = [norm(100)];
  assert.equal(mergeRawKline(base, { openTime: "nope" }, "1m"), base);
  assert.equal(mergeRawKline(base, null, "1m"), base);
});

// ── diff planner (drives incremental chart updates) ───────────────────────

test("diffKlines: empty / first / noop", () => {
  assert.deepEqual(diffKlines([], []), { kind: "noop" });
  assert.deepEqual(diffKlines([], [norm(100)]), { kind: "first" });
  const a = [norm(100), norm(101)];
  assert.deepEqual(diffKlines(a, a.slice()), { kind: "noop" });
});

test("diffKlines: forming candle update -> tail from last bar", () => {
  const prev = [norm(100, "105"), norm(101, "105")];
  const next = [norm(100, "105"), norm(101, "106")];
  assert.deepEqual(diffKlines(prev, next), { kind: "tail", from: 1 });
});

test("diffKlines: appended bars -> tail re-pushing the previous last bar", () => {
  const prev = [norm(100), norm(101)];
  const next = [...prev, norm(102)];
  assert.deepEqual(diffKlines(prev, next), { kind: "tail", from: 1 });
});

test("diffKlines: prepended history -> full with shift", () => {
  const prev = [norm(101), norm(102)];
  const next = [norm(100), ...prev];
  assert.deepEqual(diffKlines(prev, next), { kind: "full", shift: 1 });
});

test("diffKlines: middle change or truncation -> full without shift", () => {
  const a = norm(100, "101");
  const b = norm(101, "102");
  const b2 = norm(101, "103");
  const c = norm(102, "104");
  assert.deepEqual(diffKlines([a, b, c], [a, b2, c]), { kind: "full", shift: 0 });
  assert.deepEqual(diffKlines([a, b, c], [a, b]), { kind: "full", shift: 0 });
});

test("diffKlines: corrected closed bar while prefixing -> full, not tail", () => {
  const a = norm(100, "101");
  const aFixed = norm(100, "111");
  const b = norm(101, "102");
  const c = norm(102, "103");
  // next extends prev, but bar 0 was corrected — a tail push would skip it.
  assert.deepEqual(diffKlines([a, b], [aFixed, b, c]), { kind: "full", shift: 0 });
  // unchanged prefix still takes the cheap tail path
  assert.deepEqual(diffKlines([a, b], [a, b, c]), { kind: "tail", from: 1 });
});

test("diffKlines: cleared series -> empty", () => {
  assert.deepEqual(diffKlines([norm(100)], []), { kind: "empty" });
});

// ── chart mapping ─────────────────────────────────────────────────────────

test("mappings are index-aligned with the source array", () => {
  const ks = [norm(100, "101"), norm(101, "102")];
  const candles = toCandleBars(ks);
  const lines = toLineBars(ks);
  const volumes = toVolumeBars(ks, "up", "down");
  assert.equal(candles.length, ks.length);
  assert.equal(lines.length, ks.length);
  assert.equal(volumes.length, ks.length);
  assert.equal(candles[0]!.time, Math.floor((BASE + 100 * MIN) / 1000));
  assert.equal(lines[1]!.value, 102);
  assert.ok(Number.isFinite(candles[0]!.open));
  assert.equal(buildTimeIndex(ks).get(Math.floor((BASE + 100 * MIN) / 1000)), ks[0]);
});

test("toIndicatorBars: an overlay keeps the candles' axis", () => {
  // bars 100, 101 then 105 — three slots the venue never served in between.
  const ks = [norm(100, "101"), norm(101, "102"), norm(105, "103")];
  const out = toIndicatorBars(ks, [null, 1, 2]);
  const times = out.map((b) => Number(b.time));
  assert.deepEqual(
    times,
    [100, 101, 102, 103, 104, 105].map((s) => Math.floor((BASE + s * MIN) / 1000)),
    "the missing slots are reserved, exactly as the candles reserve them",
  );
  assert.deepEqual(times, toCandleBars(ks).map((b) => Number(b.time)), "same axis as the candles");
  assert.deepEqual(
    out.filter((b) => "value" in b).map((b) => (b as { value: number }).value),
    [1, 2],
    "a warm-up slot carries no value rather than shifting the line left",
  );
});

test("klineKey is stable and unique per window", () => {
  assert.equal(klineKey("BTCUSDT", "1m"), "BTCUSDT:1m");
  assert.notEqual(klineKey("BTCUSDT", "1m"), klineKey("BTCUSDT", "5m"));
});

test("EMPTY_KLINES is a stable empty reference", () => {
  assert.equal(EMPTY_KLINES.length, 0);
  assert.deepEqual(EMPTY_KLINES, []);
});

test("switchVisibleRange right-aligns a sane number of bars for any window", () => {
  /** A contiguous 1m window of `count` candles — no holes, so its axis is its
   *  candle count and the range is the plain arithmetic it always was. */
  const series = (count: number) => normalizeKlines(
    Array.from({ length: count }, (_, i) => raw(BASE + i * MIN)),
  ) as unknown as KlineData[];

  // Nothing loaded yet: an empty chart still needs a positive-width viewport,
  // otherwise the first page lands on a zero-bar range and looks like a failure.
  assert.deepEqual(switchVisibleRange([]), { from: 0, to: SWITCH_RIGHT_PAD });
  // Shorter than the target window -> show all of it from index 0.
  assert.deepEqual(switchVisibleRange(series(50)), { from: 0, to: 50 + SWITCH_RIGHT_PAD });
  assert.deepEqual(switchVisibleRange(series(500)), {
    from: 500 - SWITCH_VISIBLE_BARS,
    to: 500 + SWITCH_RIGHT_PAD,
  });

  for (const count of [1, 2, 119, 120, 121, 1000, MAX_KLINES]) {
    const r = switchVisibleRange(series(count));
    assert.ok(r.from >= 0, `from clamped below 0 for ${count}`);
    assert.ok(r.to > r.from, `zero-width window for ${count}`);
    // The newest bar is always inside the window, with pad to its right.
    assert.ok(r.to > count, `newest bar outside the window for ${count}`);
    assert.ok(r.to - r.from >= Math.min(count, SWITCH_VISIBLE_BARS));
  }

  // The promise is in candles, not in axis positions: a window whose recent
  // history has an outage in it still opens on SWITCH_VISIBLE_BARS of price,
  // with the holes drawn inside that span rather than pushing the bars away.
  const holed = normalizeKlines([
    ...Array.from({ length: 300 }, (_, i) => raw(BASE + i * MIN)),
    ...Array.from({ length: 120 }, (_, i) => raw(BASE + 300 * MIN + 500 * MIN + i * MIN)),
  ]) as unknown as KlineData[];
  const r = switchVisibleRange(holed);
  assert.equal(r.to, 420 + 500 + SWITCH_RIGHT_PAD, "the axis counts the 500 absent bars");
  assert.equal(r.from, 420 + 500 - SWITCH_VISIBLE_BARS, "and the view still holds 120 candles");
});

/* ── the candles the axis cannot show ─────────────────────────────────── */

test("missingHistory is silent about a window that holds every bar", () => {
  assert.deepEqual(missingHistory([], "1m"), { bars: 0, lagMs: 0 }, "nothing loaded is not missing history");
  assert.deepEqual(missingHistory([live(2), live(1), live(0)], "1m"), { bars: 0, lagMs: 0 },
    "the minute still forming is a bar that has not arrived yet, not a hole");
});

test("missingHistory counts the run the time scale paints over", () => {
  // Fifty minutes missing inside the window and seven more between the healed
  // group and the present: the chart draws all of it as one continuous axis.
  const holed = [live(61), live(60), live(9), live(8), live(0)];
  assert.equal(missingHistory(holed, "1m").bars, 50 + 7, "every absent slot, not only the newest run");
});

test("missingHistory reports a right edge that stopped covering the present", () => {
  const stale = [live(60), live(59)]; // the feed went quiet an hour ago
  const m = missingHistory(stale, "1m");
  assert.ok(m.lagMs >= 59 * MIN, `the newest bar is nearly an hour behind, saw ${m.lagMs}ms`);
  assert.equal(m.bars, m.lagMs / MIN - 1, "the closed minutes behind it are the count; the present one is not");
});
