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
