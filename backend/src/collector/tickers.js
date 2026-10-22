import { bus, subject } from "../bus.js";

const BYBIT_REST = process.env.BYBIT_REST || "https://api.bybit.com";

/**
 * Bybit reports 24h change as a signed fraction ("0.0123" = 1.23%). The
 * terminal protocol carries percentages, so the conversion happens once here —
 * every surface (watchlist, header, alerts) can then treat `change24h` as
 * percent without guessing from magnitude.
 */
export function normalizeTicker(venue, raw, ts) {
  const num = (v) => {
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  const str = (v) => (v === undefined || v === null || v === "" ? undefined : String(v));
  const out = {
    venue,
    symbol: String(raw.symbol ?? "").toUpperCase(),
    lastPrice: String(raw.lastPrice ?? "0"),
    change24h: String(round(num(raw.change24h ?? raw.price24hPcnt) * 100, 4)),
    high24h: String(raw.high24h ?? raw.highPrice24h ?? "0"),
    low24h: String(raw.low24h ?? raw.lowPrice24h ?? "0"),
    volume24h: String(raw.volume24h ?? "0"),
    turnover24h: String(raw.turnover24h ?? "0"),
    // Every envelope needs a numeric ts — the terminal derives LIVE/STALE from it.
    ts: Number.isFinite(ts) ? ts : Date.now(),
  };
  // Bybit's *streaming* spot ticker has no bid/ask (only the REST snapshot
  // does). Emitting "0" would make the terminal show a fake zero spread, so
  // the fields are simply absent and the client keeps the last known level.
  const bid = str(raw.bidPrice ?? raw.bid1Price);
  const ask = str(raw.askPrice ?? raw.ask1Price);
  if (bid !== undefined) out.bidPrice = bid;
  if (ask !== undefined) out.askPrice = ask;
  return out;
}

/** Trims the binary noise the *100 scaling introduces — "0.29" becomes
 *  28.999999999999996 — so `change24h` never carries a 17-digit value that every
 *  consumer would then have to round for itself. */
function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Full spot ticker snapshot from REST. The WS ticker stream only speaks for
 * symbols that actually traded, so without this the watchlist shows "—" for
 * most pairs until a fill happens.
 */
export async function fetchSpotTickers() {
  const url = `${BYBIT_REST}/v5/market/tickers?category=spot`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; CryptoTerminal/1.0)" },
  });
  if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(j.retMsg || `Bybit error ${j.retCode}`);
  const list = Array.isArray(j.result?.list) ? j.result.list : [];
  const out = [];
  for (const t of list) {
    if (!t.symbol || !(parseFloat(t.lastPrice) > 0)) continue;
    out.push(normalizeTicker("bybit", t, Date.now()));
  }
  return out;
}

/** Publish a REST ticker snapshot onto the bus so it flows through the Hub. */
export function publishTickers(tickers, knownSymbols) {
  let published = 0;
  for (const t of tickers) {
    if (knownSymbols && !knownSymbols.has(t.symbol)) continue;
    bus.pub(subject("bybit", t.symbol, "ticker"), t);
    published += 1;
  }
  return published;
}

/**
 * Periodically re-seed tickers from REST. Liquid pairs are already covered by
 * the WS stream (and their Hub `latest` entry is overwritten by live data),
 * while quiet pairs stop showing stale prices.
 */
export function startTickerSeed({ logger, getSymbols, intervalMs = 20000 }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const tickers = await fetchSpotTickers();
      const known = new Set(getSymbols());
      const n = publishTickers(tickers, known);
      logger.info("ticker seed published", { fromRest: tickers.length, published: n });
    } catch (err) {
      logger.warn("ticker seed failed", { err: err.message });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
