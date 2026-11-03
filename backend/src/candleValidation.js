import { intervalMs, intervalOrigin } from "./intervals.js";

/**
 * The one place a candle is judged, so every boundary asks the same question and
 * gets the same answer.
 *
 * Before this, each entry point had its own rule: the REST fetcher accepted any
 * row, the mirror store required only `>= 0`, the websocket collector turned a
 * missing venue field into the string `"0"`, and the browser rejected `<= 0` and
 * broken OHLC relations. Those disagree, and the disagreement is what corrupts a
 * chart: a bar the store accepts but the client rejects occupies its slot in the
 * mirror, so the crawl concludes the range is filled while the chart shows a hole
 * that can never heal. A fabricated `"0"` candle is worse than a dropped frame —
 * it is invented market data written to disk.
 *
 * So: one predicate, and a rejected candle is *counted and logged*, never
 * repaired, never interpolated, never replaced by a plausible-looking number.
 */

/** Store form: `[openTime, open, high, low, close, volume]` with string values. */
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * True when `openTime` is a slot the venue actually uses.
 *
 * Measured against the interval's own grid origin rather than the unix epoch,
 * because the two differ: Bybit weekly candles open on Monday
 * (`openTime % 604800000 === 345600000`), so an epoch-derived grid would reject
 * every genuine weekly bar. See `intervalOrigin`.
 */
export function isAlignedSlot(openTime, interval) {
  const ms = intervalMs(interval);
  if (!(ms > 0) || !Number.isFinite(openTime)) return false;
  return (openTime - intervalOrigin(interval)) % ms === 0;
}

/**
 * A wire-shaped candle (`{openTime, open, high, low, close, volume}`) to a store
 * tuple, or null when it is not a candle.
 */
export function toValidTuple(k, interval) {
  if (!k || typeof k !== "object") return null;
  const openTime = num(k.openTime);
  if (openTime === null || openTime <= 0) return null;
  const open = num(k.open);
  const high = num(k.high);
  const low = num(k.low);
  const close = num(k.close);
  const volume = num(k.volume);
  if (open === null || high === null || low === null || close === null || volume === null) return null;
  // A price of 0 is not a price: it is what a missing venue field looks like.
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
  if (volume < 0) return null;
  if (high < low) return null;
  if (high < open || high < close) return null;
  if (low > open || low > close) return null;
  if (!isAlignedSlot(openTime, interval)) return null;
  return [openTime, String(k.open), String(k.high), String(k.low), String(k.close), String(k.volume)];
}

/** Validate a whole page, newest- or oldest-first, keeping the input order.
 *  Returns the accepted tuples plus how many rows were dropped, so the caller can
 *  log the rejection instead of silently shortening the page. */
export function tuplesFromPage(rows, interval) {
  const out = [];
  let rejected = 0;
  for (const row of rows) {
    const t = toValidTuple(row, interval);
    if (t) out.push(t);
    else rejected += 1;
  }
  return { tuples: out, rejected };
}

/** Is a tuple already on disk still a candle? Reads of the mirror use this so a
 *  file written by an older, laxer build cannot keep a bad bar alive. */
export function isValidTuple(v, interval) {
  if (!Array.isArray(v) || v.length !== 6) return false;
  return toValidTuple(
    { openTime: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] },
    interval,
  ) !== null;
}
