import { useMarketStore } from "@/lib/store/marketStore";
import {
  EMPTY_KLINES, MAX_KLINES, TIMEFRAME_SPAN_MS, klineKey, normalizeKlines,
} from "@/lib/utils/klines";
import type { KlineData, Timeframe } from "@/lib/types";

/**
 * Historical kline REST access (single place that talks to /api/klines).
 *
 * - Results are validated/normalized and merged (never blindly replaced) so a
 *   slow response can't clobber newer live data or reorder the series.
 * - Per (symbol, interval) in-flight + cooldown guards prevent request storms
 *   from the chart's "scroll back to load more" trigger.
 * - `exhausted` remembers that the exchange has no more history for a window.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:8080` : "http://localhost:8080");

const HISTORICAL_LIMIT = 500;
const BACKFILL_LIMIT = 500;
/** After a failed page, let the user scroll a bit before probing again. */
const BACKFILL_RETRY_MS = 5000;
/** Ceiling on one /api/klines round trip. The gateway bounds its own upstream
 *  work and answers from cache, so anything slower than this means the request
 *  is stuck — and without a ceiling the browser waits indefinitely, the status
 *  stays `loading` and Retry can't do anything because the key is in flight. */
const REQUEST_TIMEOUT_MS = 15000;

const inFlightHistorical = new Set<string>();
const inFlightBackfill = new Set<string>();
const backfillRetryAt = new Map<string, number>();
const backfillExhausted = new Set<string>();
const historyRetry = new Map<string, ReturnType<typeof setTimeout>>();

/** While the venue is unreachable the terminal keeps probing on a decaying
 *  schedule instead of leaving the chart stuck on "failed" until the user
 *  notices and presses Retry — then it stops, so an outage is not hammered. */
const HISTORY_RETRY_DELAYS_MS = [5000, 15000, 30000];

function clearHistoryRetry(key: string) {
  const pending = historyRetry.get(key);
  if (pending) { clearTimeout(pending); historyRetry.delete(key); }
}

/** The single call site for /api/klines. Throws on any failure — HTTP status,
 *  a gateway `error` body, a non-array payload, or the timeout — so callers can
 *  read a throw as "retry/abort" and an empty array as genuine "no more
 *  history". */
async function fetchKlineBatch(
  symbol: string,
  interval: Timeframe | string,
  limit: number,
  endTime?: number,
): Promise<KlineData[]> {
  const params = new URLSearchParams({ symbol, interval: String(interval), limit: String(limit) });
  if (endTime !== undefined) params.set("endTime", String(endTime));
  const res = await fetch(`${API_BASE}/api/klines?${params.toString()}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`klines HTTP ${res.status}`);
  const json = (await res.json()) as { data?: unknown; error?: string };
  if (json.error) throw new Error(String(json.error));
  if (!Array.isArray(json.data)) throw new Error("malformed klines response");
  return normalizeKlines(json.data, String(interval));
}

/**
 * Load (or refresh) the most recent history window for a symbol+interval.
 * Status transitions: loading -> ready | error.
 * `attempt` is internal: a failed load re-probes on the decaying schedule
 * above, and a fresh call (symbol or timeframe switch, Retry) supersedes that
 * schedule and gets the full budget again.
 */
export async function loadHistoricalKlines(
  symbol: string,
  interval: Timeframe | string,
  limit = HISTORICAL_LIMIT,
  attempt = 0,
): Promise<boolean> {
  const key = klineKey(symbol, interval);
  if (attempt === 0) clearHistoryRetry(key);
  if (inFlightHistorical.has(key)) return false;
  inFlightHistorical.add(key);
  const store = useMarketStore.getState();
  store.setKlineStatus(symbol, interval, "loading");
  try {
    // One request per attempt: the gateway already re-probes the venue and
    // answers from its own cache, so an immediate second round trip here would
    // only double the time the user stares at a spinner.
    const batch = await fetchKlineBatch(symbol, interval, limit);
    clearHistoryRetry(key);
    // A fresh window may have older data behind it.
    backfillExhausted.delete(key);
    backfillRetryAt.delete(key);
    useMarketStore.getState().mergeKlinesInto(symbol, interval, batch);
    useMarketStore.getState().setKlineStatus(symbol, interval, "ready");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useMarketStore.getState().setKlineStatus(symbol, interval, "error", message);
    if (attempt < HISTORY_RETRY_DELAYS_MS.length) {
      historyRetry.set(key, setTimeout(() => {
        historyRetry.delete(key);
        void loadHistoricalKlines(symbol, interval, limit, attempt + 1);
      }, HISTORY_RETRY_DELAYS_MS[attempt]));
    }
    return false;
  } finally {
    inFlightHistorical.delete(key);
  }
}

/** How far behind the present a window may fall before it counts as frozen.
 *  Covers a couple of 1m bars plus normal delivery jitter. */
const RECENT_TAIL_MS = 120_000;
/** Floor between tail refreshes. `loadHistoricalKlines` re-arms its retry
 *  ladder on every call, so an unguarded refresh would defeat the decay. */
const REFRESH_MIN_MS = 30_000;

const lastRefreshAt = new Map<string, number>();

/** True when the newest stored candle still covers the present moment. */
export function hasRecentTail(klines: KlineData[]): boolean {
  const last = klines[klines.length - 1];
  if (!last) return false;
  const span = TIMEFRAME_SPAN_MS[last.interval as Timeframe] ?? 60_000;
  return last.openTime + span > Date.now() - RECENT_TAIL_MS;
}

/**
 * Heal a frozen right-hand edge: re-pull the recent window, but only when the
 * stored one no longer reaches now. Used for events that can silently stall
 * delivery (a backgrounded tab throttles timers and WebSocket handling without
 * the socket ever reporting a drop). Skips when a load is pending or failing —
 * that path owns its own retry ladder. Returns whether the window is live.
 */
export async function refreshRecentKlines(symbol: string, interval: Timeframe | string): Promise<boolean> {
  const key = klineKey(symbol, interval);
  const state = useMarketStore.getState();
  const existing = state.klines[symbol]?.[interval] ?? EMPTY_KLINES;
  if (hasRecentTail(existing)) return true;
  if (state.klineStatus[key]?.state !== "ready") return false;

  const last = lastRefreshAt.get(key) ?? 0;
  if (Date.now() - last < REFRESH_MIN_MS) return false;
  lastRefreshAt.set(key, Date.now());

  await loadHistoricalKlines(symbol, interval);
  const after = useMarketStore.getState().klines[symbol]?.[interval] ?? EMPTY_KLINES;
  return hasRecentTail(after);
}

/**
 * Backfill older candles (scroll-back). Returns true when older data was
 * merged in. Safe to call on every visible-range change: in-flight, retry
 * and exhausted guards apply per (symbol, interval).
 */
export async function loadOlderKlines(symbol: string, interval: Timeframe | string, limit = BACKFILL_LIMIT): Promise<boolean> {
  const key = klineKey(symbol, interval);
  if (inFlightBackfill.has(key) || backfillExhausted.has(key)) return false;
  // Backfilling before the recent window has landed is a wasted full page:
  // with only live candles on screen the viewport already looks "at the start".
  if (useMarketStore.getState().klineStatus[key]?.state !== "ready") return false;
  const retryAt = backfillRetryAt.get(key);
  if (retryAt !== undefined && Date.now() < retryAt) return false;

  const existing = useMarketStore.getState().klines[symbol]?.[interval] ?? EMPTY_KLINES;
  if (existing.length === 0) return false;

  const budget = MAX_KLINES - existing.length;
  if (budget <= 0) {
    backfillExhausted.add(key);
    return false;
  }

  const oldestOpenTime = existing[0]!.openTime;
  const wanted = Math.min(limit, budget);
  inFlightBackfill.add(key);
  try {
    // `end` is inclusive upstream, so asking for one ms before the oldest bar
    // keeps the boundary candle out of the page instead of wasting a slot.
    const batch = await fetchKlineBatch(symbol, interval, wanted, oldestOpenTime - 1);
    const older = batch.filter((k) => k.openTime < oldestOpenTime);
    if (older.length === 0) {
      backfillExhausted.add(key);
      return false;
    }
    useMarketStore.getState().mergeKlinesInto(symbol, interval, older);
    // A partial page means the exchange has nothing older for this window.
    if (batch.length < wanted) backfillExhausted.add(key);
    else backfillExhausted.delete(key);
    return true;
  } catch {
    // Only a failed page is throttled. A successful one is followed up
    // immediately, so a fast scroll-back walks the history at full speed
    // instead of dripping out one page every couple of seconds.
    backfillRetryAt.set(key, Date.now() + BACKFILL_RETRY_MS);
    return false;
  } finally {
    inFlightBackfill.delete(key);
  }
}
