import { useMarketStore } from "@/lib/store/marketStore";
import { EMPTY_KLINES, MAX_KLINES, klineKey, normalizeKlines } from "@/lib/utils/klines";
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
const BACKFILL_COOLDOWN_MS = 2000;

const inFlightHistorical = new Set<string>();
const inFlightBackfill = new Set<string>();
const backfillCooldown = new Map<string, number>();
const backfillExhausted = new Set<string>();

async function fetchKlineBatch(
  symbol: string,
  interval: Timeframe | string,
  limit: number,
  endTime?: number,
): Promise<KlineData[]> {
  const params = new URLSearchParams({ symbol, interval: String(interval), limit: String(limit) });
  if (endTime !== undefined) params.set("endTime", String(endTime));
  const res = await fetch(`${API_BASE}/api/klines?${params.toString()}`);
  if (!res.ok) throw new Error(`klines HTTP ${res.status}`);
  const json = (await res.json()) as { data?: unknown; error?: string };
  if (json.error) throw new Error(String(json.error));
  if (!Array.isArray(json.data)) throw new Error("malformed klines response");
  return normalizeKlines(json.data, String(interval));
}

/**
 * Load (or refresh) the most recent history window for a symbol+interval.
 * Status transitions: loading -> ready | error.
 */
export async function loadHistoricalKlines(symbol: string, interval: Timeframe | string, limit = HISTORICAL_LIMIT): Promise<boolean> {
  const key = klineKey(symbol, interval);
  if (inFlightHistorical.has(key)) return false;
  inFlightHistorical.add(key);
  const store = useMarketStore.getState();
  store.setKlineStatus(symbol, interval, "loading");
  try {
    let batch: KlineData[];
    try {
      batch = await fetchKlineBatch(symbol, interval, limit);
    } catch {
      // One delayed retry: transient gateway/proxy failures shouldn't show
      // the error state on first paint.
      await new Promise((r) => setTimeout(r, 600));
      batch = await fetchKlineBatch(symbol, interval, limit);
    }
    // A fresh window may have older data behind it.
    backfillExhausted.delete(key);
    useMarketStore.getState().mergeKlinesInto(symbol, interval, batch);
    useMarketStore.getState().setKlineStatus(symbol, interval, "ready");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useMarketStore.getState().setKlineStatus(symbol, interval, "error", message);
    return false;
  } finally {
    inFlightHistorical.delete(key);
  }
}

/**
 * Backfill older candles (scroll-back). Returns true when older data was
 * merged in. Safe to call on every visible-range change: in-flight, cooldown
 * and exhausted guards apply per (symbol, interval).
 */
export async function loadOlderKlines(symbol: string, interval: Timeframe | string, limit = BACKFILL_LIMIT): Promise<boolean> {
  const key = klineKey(symbol, interval);
  if (inFlightBackfill.has(key) || backfillExhausted.has(key)) return false;
  const lastAttempt = backfillCooldown.get(key);
  if (lastAttempt !== undefined && Date.now() - lastAttempt < BACKFILL_COOLDOWN_MS) return false;

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
  backfillCooldown.set(key, Date.now());
  try {
    const batch = await fetchKlineBatch(symbol, interval, wanted, oldestOpenTime);
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
    return false;
  } finally {
    inFlightBackfill.delete(key);
  }
}
