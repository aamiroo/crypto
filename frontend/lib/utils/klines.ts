import type { Time } from "lightweight-charts";
import type { KlineData, Timeframe } from "@/lib/types";

/**
 * Shared OHLCV helpers: validation, normalization, sorted merge and a diff
 * planner that tells the chart renderer whether it can update incrementally
 * (series.update) or needs a full setData (while preserving the viewport).
 *
 * Invariants guaranteed by this module:
 *  - every kline is fully parseable (finite OHLCV, sane openTime, high >= low)
 *  - arrays are strictly ascending by openTime with no duplicates
 *  - arrays are capped at MAX_KLINES (newest kept)
 */

export const EMPTY_KLINES: KlineData[] = [];
export const MAX_KLINES = 5000;

export const TIMEFRAMES: Timeframe[] = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"];
const TF_SET = new Set<string>(TIMEFRAMES);

/** Bar duration in ms. Used to judge whether a stored window still reaches the
 *  present, which is what decides if it needs a REST refresh. */
export const TIMEFRAME_SPAN_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

/** Slot origin per timeframe, as an offset from the unix epoch. Weekly candles
 *  open on Monday 00:00 UTC while the epoch is a Thursday, so a real weekly bar
 *  carries `openTime % 604800000 === 345600000`: counting slots from the epoch
 *  puts the "current" weekly slot four days early and can read a genuinely absent
 *  week as present. Matches the backend's `intervalOrigin`. */
const TIMEFRAME_ORIGIN_MS: Record<Timeframe, number> = {
  "1m": 0, "3m": 0, "5m": 0, "15m": 0, "30m": 0, "1h": 0, "4h": 0, "1d": 0,
  "1w": 3456e5,
};

/** Which candle slot a timestamp falls in, on that timeframe's own grid. */
export function slotOf(time: number, interval: Timeframe): number {
  const span = TIMEFRAME_SPAN_MS[interval] ?? 60_000;
  const origin = TIMEFRAME_ORIGIN_MS[interval] ?? 0;
  return Math.floor((time - origin) / span) * span + origin;
}

const MIN_OPEN_TIME = 946684800000; // 2000-01-01
const MAX_OPEN_TIME = 4102444800000; // 2100-01-01

/** How far behind the present a window may fall before it counts as frozen.
 *  Covers a couple of 1m bars plus normal delivery jitter. */
export const RECENT_TAIL_MS = 120_000;

/** True when this candle still covers the present moment, so it owns the
 *  right-hand edge of the chart. Lives here because both the REST layer (heal a
 *  frozen tail) and the store (decide whether a replayed bar may claim
 *  precedence over a page) need the same test, and neither may import the other. */
export function isCurrentBar(k: KlineData): boolean {
  const span = TIMEFRAME_SPAN_MS[k.interval as Timeframe] ?? 60_000;
  return k.openTime + span > Date.now() - RECENT_TAIL_MS;
}

/** What this series leaves out: bars that should be between the candles on hand,
 *  counted from the spacing of the candles themselves.
 *
 *  A chart with a hole in it does not look like one. The time scale is drawn from
 *  the data it is given, so the two candles either side of an outage sit next to
 *  each other and the price line simply jumps — a reader sees a market that moved
 *  fast, not days of history that never arrived. The same face is what a frozen
 *  feed shows: the newest candle stops covering the present, but the axis keeps
 *  ending there as if it were now.
 *
 *  `bars` is both runs together (interior holes plus the tail up to this moment),
 *  and `lagMs` is how far the newest candle trails the minute the market is in
 *  now, which is what a badge has to say when the tail itself is the gap. One
 *  absent bar is not reported: the bar covering the present moment is still
 *  forming, and the difference between "not delivered yet" and "never arrived"
 *  is not something the series can know.
 */
export function missingHistory(klines: KlineData[], interval: Timeframe): { bars: number; lagMs: number } {
  const span = TIMEFRAME_SPAN_MS[interval] ?? 60_000;
  const last = klines[klines.length - 1];
  if (!last) return { bars: 0, lagMs: 0 };
  // Counted from the slot the market is in right now, on that timeframe's own
  // grid: the same window then reports the same absence however late in the
  // minute the chart happened to ask, and a weekly series is measured against a
  // Monday instead of against a Thursday four days away from any real candle.
  const forming = slotOf(Date.now(), interval);
  const lagMs = Math.max(0, forming - last.openTime);
  // The bar covering the present is still forming, so it is not counted as
  // missing — the same tolerance the gateway's own tail uses.
  let bars = Math.max(0, Math.round((lagMs - span) / span));
  for (let i = klines.length - 1; i > 0; i--) {
    const absent = klines[i]!.openTime - klines[i - 1]!.openTime - span;
    if (absent > 0) bars += Math.floor(absent / span);
  }
  return { bars, lagMs };
}

/** Unique key for a (symbol, interval) kline window. */
export function klineKey(symbol: string, interval: string): string {
  return `${symbol}:${interval}`;
}

/** Strict numeric read of a venue field: "", NaN and Infinity become null, so
 *  one corrupt value rejects the candle instead of poisoning the chart. */
function toFinite(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Validate + coerce a single raw kline. Returns null when unusable. */
export function normalizeKline(raw: unknown, fallbackInterval?: string): KlineData | null {
  if (!raw || typeof raw !== "object") return null;
  const k = raw as Record<string, unknown>;
  const interval = typeof k.interval === "string" && k.interval !== "" ? k.interval : fallbackInterval;
  if (!interval || !TF_SET.has(interval)) return null;

  const openTime = toFinite(k.openTime);
  if (openTime === null || openTime < MIN_OPEN_TIME || openTime > MAX_OPEN_TIME) return null;
  const closeTime = toFinite(k.closeTime);
  const open = toFinite(k.open);
  const high = toFinite(k.high);
  const low = toFinite(k.low);
  const close = toFinite(k.close);
  const volume = toFinite(k.volume);
  if (open === null || high === null || low === null || close === null) return null;
  if (volume === null || volume < 0) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
  if (high < low) return null;
  if (high < open || high < close || low > open || low > close) return null;

  return {
    interval,
    openTime,
    closeTime: closeTime !== null && closeTime >= openTime ? closeTime : openTime,
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: String(volume),
    closed: Boolean(k.closed),
  };
}

/**
 * Validate, sort ascending by openTime and de-duplicate a raw batch.
 * On duplicate openTime the later entry wins (newer source of truth).
 */
export function normalizeKlines(raw: unknown, fallbackInterval?: string): KlineData[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: KlineData[] = [];
  for (const item of list) {
    const k = normalizeKline(item, fallbackInterval);
    if (k) out.push(k);
  }
  if (out.length > 1) {
    out.sort((a, b) => a.openTime - b.openTime);
    let w = 0;
    for (let r = 1; r < out.length; r++) {
      if (out[r]!.openTime === out[w]!.openTime) out[w] = out[r]!;
      else { w++; out[w] = out[r]!; }
    }
    out.length = w + 1;
  }
  return capKlines(out);
}

/** Keeps the newest MAX_KLINES: older history is scroll-back, the live tail is
 *  what the chart and the indicators are computed from. */
function capKlines(list: KlineData[]): KlineData[] {
  return list.length > MAX_KLINES ? list.slice(list.length - MAX_KLINES) : list;
}

/** Value equality for a candle already known to share its timestamp — this is
 *  what separates "the stream repeated itself" from a real update. */
function sameValues(a: KlineData, b: KlineData): boolean {
  return (
    a.open === b.open && a.high === b.high && a.low === b.low &&
    a.close === b.close && a.volume === b.volume && a.closed === b.closed
  );
}

/**
 * Decide which of two versions of the *same* candle wins. Called for every
 * collision of a bulk merge; returning true keeps the candle already on hand.
 * The store uses it so a REST snapshot taken before the newest live tick cannot
 * paint over that tick — the chart's forming bar would otherwise jump backwards.
 */
export type CandlePrecedence = (stored: KlineData, incoming: KlineData) => boolean;

/**
 * Insert one kline keeping the array sorted. Returns the SAME reference when
 * nothing changes so zustand subscribers don't re-render needlessly.
 *
 *  The common live-tick cases (append a new candle, update the forming one)
 *  are handled before the binary search: they are O(n) for the immutable copy
 *  but avoid the second O(n) pass `splice` used to be correct in the slow
 *  path, and they skip the search entirely.
 */
function mergeOne(base: KlineData[], k: KlineData, protect?: CandlePrecedence): KlineData[] {
  const last = base[base.length - 1];

  // Fast path: appending a new candle to the end — the common live tick.
  if (!last || k.openTime > last.openTime) {
    if (base.length >= MAX_KLINES) {
      const next = base.slice(1);
      next.push(k);
      return next;
    }
    return [...base, k];
  }

  // Fast path: updating the forming (last) candle in place.
  if (k.openTime === last.openTime) {
    if (sameValues(last, k)) return base;
    if (protect?.(last, k)) return base;
    const next = base.slice();
    next[next.length - 1] = k;
    return next;
  }

  // Slow path: out-of-order insertion (rare — replay, backfill, correction).
  let lo = 0;
  let hi = base.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (base[mid]!.openTime < k.openTime) lo = mid + 1;
    else hi = mid;
  }
  if (lo < base.length && base[lo]!.openTime === k.openTime) {
    if (sameValues(base[lo]!, k)) return base;
    if (protect?.(base[lo]!, k)) return base;
    const next = base.slice();
    next[lo] = k;
    return next;
  }
  const next = base.slice();
  next.splice(lo, 0, k);
  return next.length > MAX_KLINES ? next.slice(next.length - MAX_KLINES) : next;
}

/** Collapse repeated timestamps inside one batch, keeping the later row: within
 *  a single source the last write is the newer view. `normalizeKlines` already
 *  does this for anything that comes from the wire, and the linear merge below
 *  assumes unique keys, so a caller that hands over a raw batch is normalised
 *  here rather than silently keeping two candles for one timestamp. */
function dedupeBatch(list: KlineData[]): KlineData[] {
  let dup = false;
  for (let i = 1; i < list.length; i++) {
    if (list[i]!.openTime === list[i - 1]!.openTime) { dup = true; break; }
  }
  if (!dup) return list;
  const out: KlineData[] = [list[0]!];
  for (let i = 1; i < list.length; i++) {
    const k = list[i]!;
    if (k.openTime === out[out.length - 1]!.openTime) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

/**
 * Merge two ascending, de-duplicated arrays in one pass with one new array.
 * This is the bulk path: a page used to go through `mergeOne` per candle, and
 * each of those copied the whole window — a 1000-candle page into a 5000-candle
 * window moved six million entries to keep a thousand of them.
 *
 * On a timestamp collision the incoming candle wins unless `protect` says the
 * stored one is newer. Returns `base` itself when nothing actually changed.
 */
function mergeSorted(base: KlineData[], incomingRaw: KlineData[], protect?: CandlePrecedence): KlineData[] {
  const incoming = dedupeBatch(incomingRaw);
  if (incoming.length === 0) return base;
  if (base.length === 0) return capKlines(incoming);

  const out: KlineData[] = [];
  let i = 0;
  let j = 0;
  let changed = false;
  while (i < base.length && j < incoming.length) {
    const b = base[i]!;
    const n = incoming[j]!;
    if (b.openTime < n.openTime) {
      out.push(b);
      i++;
    } else if (b.openTime > n.openTime) {
      out.push(n);
      j++;
      changed = true;
    } else {
      if (sameValues(b, n)) out.push(b);
      else {
        const keep = protect?.(b, n) ?? false;
        out.push(keep ? b : n);
        changed = changed || !keep;
      }
      i++;
      j++;
    }
  }
  while (i < base.length) out.push(base[i++]!);
  while (j < incoming.length) {
    out.push(incoming[j++]!);
    changed = true;
  }
  if (!changed) return base;
  return out.length > MAX_KLINES ? out.slice(out.length - MAX_KLINES) : out;
}

/**
 * Sorted, de-duplicating merge of `incoming` into `base`.
 * Handles out-of-order arrivals (WS replay after reconnect, REST overlapping
 * live data, backfill) and returns `base` unchanged when there is nothing new.
 */
export function mergeKlines(
  base: KlineData[],
  incoming: KlineData | KlineData[],
  protect?: CandlePrecedence,
): KlineData[] {
  if (Array.isArray(incoming)) return mergeSorted(base, incoming, protect);
  return incoming ? mergeOne(base, incoming, protect) : base;
}

/** Raw incoming kline (WS or REST row) merged into an existing array.
 *
 *  A bar the series already holds as *closed* outranks one still forming: the
 *  stream can hand over a late or replayed tick for a candle that has since
 *  finalised, and letting it rewrite that bar would rewind a settled price with
 *  a partial one. Everything else — a correction to a closed bar, a new slot, a
 *  fresh tick on the forming one — still takes the incoming values. */
export function mergeRawKline(base: KlineData[], raw: unknown, fallbackInterval?: string): KlineData[] {
  const k = normalizeKline(raw, fallbackInterval);
  if (!k) return base;
  return mergeOne(base, k, (b, n) => b.closed && !n.closed);
}

// ── chart mapping ────────────────────────────────────────────────────────
// Input is assumed to be validated (normalizeKlines/mergeKlines guarantee
// that for anything that reaches the store). The candle series is *not*
// index-aligned with the source array: a hole in the history is painted with
// empty slots, so a chart showing 09:00 next to 12:00 cannot be read as 09:00
// next to 09:01. Anything that needs the candle's own position looks it up by
// time (see `buildTimeIndex` and the store's order map), never by array index.

export interface CandleBar { time: Time; open: number; high: number; low: number; close: number; }
export interface LineBar { time: Time; value: number; }
export interface VolumeBar { time: Time; value: number; color: string; }
/** A slot the market printed nothing for. It carries a time and no value, so
 *  it reserves room on the axis without becoming a candle. */
export interface WhitespaceBar { time: Time; }
export type ChartPoint = CandleBar | LineBar | VolumeBar | WhitespaceBar;

/** The store keeps ms (venue-native); lightweight-charts is fed UTCTimestamp
 *  seconds, so every series mapping and every coordinate lookup goes through
 *  this one conversion. */
function toBarTime(k: KlineData): Time {
  return Math.floor(k.openTime / 1000) as Time;
}

/** Empty candle slots between two neighbours — zero when they are adjacent.
 *  Counted on the interval's own duration, so a missing hour on 1h is one hole
 *  and a missing week on 1w is one hole. */
export function gapHoles(prev: KlineData, next: KlineData): number {
  const span = TIMEFRAME_SPAN_MS[prev.interval as Timeframe] ?? 60_000;
  return Math.max(0, Math.floor((next.openTime - prev.openTime - span) / span));
}

/** Ceiling on the empty slots a window may inject. A mirror that lost a month
 *  of 1m bars would otherwise hand the chart 40,000 points to lay out for a
 *  thousand candles; past the cap the remaining holes stay reported by the
 *  badge rather than drawn. */
export const MAX_GAP_SLOTS = 20_000;

/** Walk a window in axis order, calling `at` once per position: with the candle
 *  for a bar the venue served, and with null for every slot it did not. An empty
 *  slot carries the timestamp of the bar that is missing, which is the whole
 *  point — the axis reserves the room the history never arrived for. */
function forEachPoint(klines: KlineData[], at: (time: Time, k: KlineData | null) => void): void {
  let budget = MAX_GAP_SLOTS;
  for (let i = 0; i < klines.length; i++) {
    const k = klines[i]!;
    if (i > 0 && budget > 0) {
      const prev = klines[i - 1]!;
      const span = TIMEFRAME_SPAN_MS[prev.interval as Timeframe] ?? 60_000;
      const holes = Math.min(gapHoles(prev, k), budget);
      for (let j = 1; j <= holes; j++) at(Math.floor((prev.openTime + j * span) / 1000) as Time, null);
      budget -= holes;
    }
    at(toBarTime(k), k);
  }
}

/** How many axis positions the window occupies — what a logical range is
 *  measured in, which is not the same as how many candles it holds. */
export function slotCount(klines: KlineData[]): number {
  let n = 0;
  forEachPoint(klines, () => { n += 1; });
  return n;
}

/** Map klines to candlestick bars, with whitespace over the missing slots. */
export function toCandleBars(klines: KlineData[]): (CandleBar | WhitespaceBar)[] {
  const out: (CandleBar | WhitespaceBar)[] = [];
  forEachPoint(klines, (time, k) => {
    if (!k) { out.push({ time }); return; }
    out.push({
      time,
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
    });
  });
  return out;
}

/** Map klines to line/area bars (close price). */
export function toLineBars(klines: KlineData[]): (LineBar | WhitespaceBar)[] {
  const out: (LineBar | WhitespaceBar)[] = [];
  forEachPoint(klines, (time, k) => {
    if (!k) { out.push({ time }); return; }
    out.push({ time, value: Number(k.close) });
  });
  return out;
}

/** Map klines to volume histogram bars. */
export function toVolumeBars(klines: KlineData[], upColor: string, downColor: string): (VolumeBar | WhitespaceBar)[] {
  const out: (VolumeBar | WhitespaceBar)[] = [];
  forEachPoint(klines, (time, k) => {
    if (!k) { out.push({ time }); return; }
    out.push({ time, value: Number(k.volume), color: Number(k.close) >= Number(k.open) ? upColor : downColor });
  });
  return out;
}

/**
 * Series data for a value computed once per candle — an indicator line, or one
 * leg of a histogram. `values` is index-aligned with `klines` (that is what
 * `sma(closes)` returns), and the output keeps the axis aligned with the candles
 * by carrying whitespace over the slots the venue never served.
 *
 * Without that, a line joins the two candles either side of an outage into one
 * straight segment and the overlay claims a continuous history the series does
 * not have — while the candles under it correctly show the hole.
 *
 * A warm-up slot (`null` for the first `period - 1` bars of an SMA) is whitespace
 * too: it reserves the position the indicator has not reached yet instead of
 * letting the line start late in a way the axis cannot see.
 */
export function toIndicatorBars(klines: KlineData[], values: (number | null)[]): (LineBar | WhitespaceBar)[] {
  const out: (LineBar | WhitespaceBar)[] = [];
  let i = 0;
  forEachPoint(klines, (time, k) => {
    const v = k ? values[i++] : null;
    if (v == null || !Number.isFinite(v)) { out.push({ time }); return; }
    out.push({ time, value: v });
  });
  return out;
}

/** Lookup table from chart time (seconds) back to the source kline. */
export function buildTimeIndex(klines: KlineData[]): Map<Time, KlineData> {
  const map = new Map<Time, KlineData>();
  for (const k of klines) map.set(toBarTime(k), k);
  return map;
}

// ── diff planner ─────────────────────────────────────────────────────────

export type KlineDiff =
  /** next is empty -> clear the chart */
  | { kind: "empty" }
  /** prev is empty -> full setData, right-align to the latest bar */
  | { kind: "first" }
  /** identical content -> nothing to do */
  | { kind: "noop" }
  /** only the tail changed -> push next[from..] with series.update() */
  | { kind: "tail"; from: number }
  /** structural change -> full setData; shift > 0 when prev was prepended to */
  | { kind: "full"; shift: number };

/**
 * Decide the cheapest safe way to bring the rendered series from `prev` to
 * `next`. Both arrays must be sorted ascending by openTime (guaranteed by
 * normalizeKlines/mergeKlines).
 */
export function diffKlines(prev: KlineData[], next: KlineData[]): KlineDiff {
  if (next.length === 0) return prev.length === 0 ? { kind: "noop" } : { kind: "empty" };
  if (prev.length === 0) return { kind: "first" };

  const maxP = Math.min(prev.length, next.length);
  let p = 0;
  while (p < maxP && prev[p]!.openTime === next[p]!.openTime) p++;

  if (p === prev.length && p === next.length) {
    // Same timestamps everywhere. Fast path: the forming (last) bar changed.
    if (!sameValues(prev[p - 1]!, next[p - 1]!)) return { kind: "tail", from: p - 1 };
    // A historical bar was corrected in place -> re-render the window.
    for (let i = 0; i < p - 1; i++) {
      if (!sameValues(prev[i]!, next[i]!)) return { kind: "full", shift: 0 };
    }
    return { kind: "noop" };
  }
  if (p === prev.length) {
    // prev is a strict prefix of next by time. If an earlier (closed) bar's
    // values changed too, a tail push would miss it — re-render instead.
    for (let i = 0; i < p - 1; i++) {
      if (!sameValues(prev[i]!, next[i]!)) return { kind: "full", shift: 0 };
    }
    return { kind: "tail", from: prev.length - 1 };
  }

  // something before the tail changed -> full setData; detect pure prepend
  const shift = next.findIndex((k) => k.openTime === prev[0]!.openTime);
  if (shift > 0 && shift + prev.length <= next.length) {
    let aligned = true;
    for (let i = 0; i < prev.length; i++) {
      if (next[shift + i]!.openTime !== prev[i]!.openTime) { aligned = false; break; }
    }
    if (aligned) return { kind: "full", shift };
  }
  return { kind: "full", shift: 0 };
}

/** True when visible indicators need an oscillator-only price band. */
export function hasOscillator(indicators: { type: string; visible: boolean }[], showIndicators: boolean): boolean {
  if (!showIndicators) return false;
  return indicators.some((i) => i.visible && (i.type === "rsi" || i.type === "macd"));
}

/** Candles shown right after a timeframe switch. The previous zoom window is
 *  measured in the *old* bar size, so reusing it can leave one or two candles
 *  on screen — which looks exactly like a chart that failed to load. */
export const SWITCH_VISIBLE_BARS = 120;
/** Empty slots kept to the right of the newest bar (matches the chart's
 *  `rightOffset`), so the last candle is never glued to the price axis. */
export const SWITCH_RIGHT_PAD = 10;
/** Empty slots the first fit may cross while walking back for candles. Past
 *  this, an outage would occupy more of the screen than the price history it is
 *  supposed to separate, so the fit stays on the newest side of the hole. */
const SWITCH_MAX_GAP_SLOTS = SWITCH_VISIBLE_BARS;

/**
 * Logical (index-based) range to show after a timeframe change: newest bars
 *  right-aligned, at most SWITCH_VISIBLE_BARS *candles* of them. The axis counts
 *  the empty slots between candles too, so the walk back from the newest bar
 *  pays for the holes it crosses — otherwise a window with an outage in its
 *  recent past would open on 120 slots of which a handful are candles, which is
 *  exactly the "chart that failed to load" this re-fit exists to prevent.
 *  A huge outage is not crossed at all: the live edge stays readable and the
 *  badge reports what is absent. `from` is clamped at 0 because a short window
 *  has nothing to the left.
 */
export function switchVisibleRange(klines: KlineData[]): { from: number; to: number } {
  const total = slotCount(klines);
  if (total === 0) return { from: 0, to: SWITCH_RIGHT_PAD };
  let candles = 1;
  let slots = 1;
  let gaps = 0;
  while (candles < SWITCH_VISIBLE_BARS && klines.length - candles > 0) {
    const i = klines.length - candles;
    const holes = Math.min(gapHoles(klines[i - 1]!, klines[i]!), MAX_GAP_SLOTS);
    if (gaps + holes > SWITCH_MAX_GAP_SLOTS) break;
    slots += holes + 1;
    gaps += holes;
    candles += 1;
  }
  return { from: Math.max(0, total - slots), to: total + SWITCH_RIGHT_PAD };
}
