/** App-level candle intervals, shared by the REST gateway and the kline cache. */
export const INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"];

const MS = {
  "1m": 6e4, "3m": 18e4, "5m": 3e5, "15m": 9e5, "30m": 18e5,
  "1h": 36e5, "4h": 144e5, "1d": 864e5, "1w": 6048e5,
};

/** Length of one candle in ms; an unknown interval means the 1m default. */
export function intervalMs(iv) {
  return MS[iv] || 6e4;
}

/**
 * First millisecond of the candle grid, as an offset from the unix epoch.
 *
 * Sub-daily and daily candles open on an epoch multiple, but weekly ones do not:
 * the exchange opens a crypto week on Monday 00:00 UTC, and the epoch is a
 * Thursday, so a real weekly bar carries `openTime % 604800000 === 345600000`.
 * Anything that counts candle slots from the epoch is off by four days for this
 * interval — enough to misreport the newest missing run by one bar and to call
 * every genuine weekly candle misaligned.
 *
 * Measured from the venue (live frames and the persisted mirror agree), not
 * assumed from a calendar.
 */
const ORIGIN = { "1w": 3456e5 };

/** Slot origin for one interval; `0` means the candle grid is epoch-aligned. */
export function intervalOrigin(iv) {
  return ORIGIN[iv] || 0;
}

/** True only for an interval this app actually serves — never the 1m fallback. */
export function isSupportedInterval(iv) {
  return Object.prototype.hasOwnProperty.call(MS, iv);
}

/** Which slot of the grid a timestamp falls in, as its opening millisecond. */
export function slotOf(time, iv) {
  const ms = intervalMs(iv);
  return Math.floor((time - intervalOrigin(iv)) / ms) * ms + intervalOrigin(iv);
}
