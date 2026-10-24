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

const MIN_OPEN_TIME = 946684800000; // 2000-01-01
const MAX_OPEN_TIME = 4102444800000; // 2100-01-01

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
 * Insert one kline keeping the array sorted. Returns the SAME reference when
 * nothing changes so zustand subscribers don't re-render needlessly.
 */
function mergeOne(base: KlineData[], k: KlineData): KlineData[] {
  let lo = 0;
  let hi = base.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (base[mid]!.openTime < k.openTime) lo = mid + 1;
    else hi = mid;
  }
  if (lo < base.length && base[lo]!.openTime === k.openTime) {
    if (sameValues(base[lo]!, k)) return base;
    const next = base.slice();
    next[lo] = k;
    return next;
  }
  const next = base.slice();
  next.splice(lo, 0, k);
  return next.length > MAX_KLINES ? next.slice(next.length - MAX_KLINES) : next;
}

/**
 * Sorted, de-duplicating merge of `incoming` into `base`.
 * Handles out-of-order arrivals (WS replay after reconnect, REST overlapping
 * live data, backfill) and returns `base` unchanged when there is nothing new.
 */
export function mergeKlines(base: KlineData[], incoming: KlineData | KlineData[]): KlineData[] {
  const list = Array.isArray(incoming) ? incoming : [incoming];
  let cur = base;
  for (const item of list) {
    if (!item) continue;
    cur = mergeOne(cur, item);
  }
  return cur;
}

/** Raw incoming kline (WS or REST row) merged into an existing array. */
export function mergeRawKline(base: KlineData[], raw: unknown, fallbackInterval?: string): KlineData[] {
  const k = normalizeKline(raw, fallbackInterval);
  if (!k) return base;
  return mergeOne(base, k);
}

// ── chart mapping ────────────────────────────────────────────────────────
// Input is assumed to be validated (normalizeKlines/mergeKlines guarantee
// that for anything that reaches the store); mappings are index-aligned with
// the source array so incremental (tail) updates can rely on shared indexes.

export interface CandleBar { time: Time; open: number; high: number; low: number; close: number; }
export interface LineBar { time: Time; value: number; }
export interface VolumeBar { time: Time; value: number; color: string; }

/** The store keeps ms (venue-native); lightweight-charts is fed UTCTimestamp
 *  seconds, so every series mapping and every coordinate lookup goes through
 *  this one conversion. */
function toBarTime(k: KlineData): Time {
  return Math.floor(k.openTime / 1000) as Time;
}

/** Map klines to candlestick bars. */
export function toCandleBars(klines: KlineData[]): CandleBar[] {
  return klines.map((k) => ({
    time: toBarTime(k),
    open: Number(k.open),
    high: Number(k.high),
    low: Number(k.low),
    close: Number(k.close),
  }));
}

/** Map klines to line/area bars (close price). */
export function toLineBars(klines: KlineData[]): LineBar[] {
  return klines.map((k) => ({ time: toBarTime(k), value: Number(k.close) }));
}

/** Map klines to volume histogram bars. */
export function toVolumeBars(klines: KlineData[], upColor: string, downColor: string): VolumeBar[] {
  return klines.map((k) => ({
    time: toBarTime(k),
    value: Number(k.volume),
    color: Number(k.close) >= Number(k.open) ? upColor : downColor,
  }));
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

/**
 * Logical (index-based) range to show after a timeframe change: newest bars
 *  right-aligned, at most SWITCH_VISIBLE_BARS of them. `from` is clamped at 0
 *  because a short window has nothing to the left to show.
 */
export function switchVisibleRange(count: number): { from: number; to: number } {
  if (count <= 0) return { from: 0, to: SWITCH_RIGHT_PAD };
  return {
    from: Math.max(0, count - SWITCH_VISIBLE_BARS),
    to: count + SWITCH_RIGHT_PAD,
  };
}
