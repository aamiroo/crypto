import { useMarketStore, klineTickCursor } from "@/lib/store/marketStore";
import {
  EMPTY_KLINES, MAX_KLINES, TIMEFRAME_SPAN_MS, isCurrentBar, klineKey, missingHistory, normalizeKlines,
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

/** Bybit serves at most 1000 candles per page, and so does the gateway. */
const HISTORICAL_LIMIT = 1000;
const BACKFILL_LIMIT = 1000;
/** A freshly opened chart is primed to roughly this many candles, so the first
 *  screen shows real history instead of the ~3 weeks a single 1h page covers.
 *  It is a *first screen* target, not the history depth: the gateway keeps the
 *  policy depth (see `meta.history.target`) and answers a scroll from its mirror
 *  without the browser having to ask for it in advance. */
const HISTORY_TARGET = 2000;
/** After a failed page, let the user scroll a bit before probing again. */
const BACKFILL_RETRY_MS = 5000;
/** Ceiling on one /api/klines round trip. The gateway bounds its own upstream
 *  work and answers from cache, so anything slower than this means the request
 *  is stuck — and without a ceiling the browser waits indefinitely, the status
 *  stays `loading` and Retry can't do anything because the key is in flight. */
const REQUEST_TIMEOUT_MS = 15000;

const inFlightHistorical = new Set<string>();
const inFlightBackfill = new Set<string>();
const inFlightGapRepair = new Set<string>();
const backfillRetryAt = new Map<string, number>();
const backfillExhausted = new Set<string>();
/** Windows already widened once to HISTORY_TARGET this session. */
const primed = new Set<string>();
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
 *  history".
 *
 *  `meta` is the gateway's own statement about the page it just answered:
 *  `venueBacked` — real exchange history, not the websocket tail (the two are
 *  the same length, so the chart cannot tell them apart from the candles);
 *  `canGoOlder` — an older page behind this one can actually be fetched right
 *  now; `source` — whether the page is the venue's answer or our mirror's, which
 *  is what decides if a short page means the end of history. Absent meta means an
 *  older gateway: take the page as the venue's own. */
async function fetchKlineBatch(
  symbol: string,
  interval: Timeframe | string,
  limit: number,
  endTime?: number,
): Promise<{
  candles: KlineData[];
  venueBacked: boolean;
  canGoOlder: boolean;
  fromVenue: boolean;
  /** The gateway's own crawl state for this window: how deep the policy wants it,
   *  how deep it is, and what history says. `status === "exhausted"` is the
   *  exchange ending the range — the one end-of-history signal a client may
   *  trust. Absent on an older gateway. */
  history?: { target: number; bars: number; status: string };
}> {
  const params = new URLSearchParams({ symbol, interval: String(interval), limit: String(limit) });
  if (endTime !== undefined) params.set("endTime", String(endTime));
  const res = await fetch(`${API_BASE}/api/klines?${params.toString()}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`klines HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: unknown;
    error?: string;
    meta?: {
      venueBacked?: unknown; canGoOlder?: unknown; source?: unknown;
      history?: { target?: unknown; bars?: unknown; status?: unknown };
    };
  };
  if (json.error) throw new Error(String(json.error));
  if (!Array.isArray(json.data)) throw new Error("malformed klines response");
  const h = json.meta?.history;
  return {
    candles: normalizeKlines(json.data, String(interval)),
    venueBacked: json.meta?.venueBacked === true,
    canGoOlder: json.meta?.canGoOlder === true,
    fromVenue: json.meta?.source !== "mirror",
    history: Number.isFinite(h?.target) && Number.isFinite(h?.bars) && typeof h?.status === "string"
      ? { target: Number(h.target), bars: Number(h.bars), status: h.status }
      : undefined,
  };
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
    const cursor = klineTickCursor();
    const page = await fetchKlineBatch(symbol, interval, limit);
    clearHistoryRetry(key);
    // A fresh window may have older data behind it after all: the previous page
    // ending short was this session's inference, not a fact about the exchange.
    backfillExhausted.delete(key);
    backfillRetryAt.delete(key);
    // The page is a snapshot of the venue as of `cursor`: the store keeps any
    // candle the stream touched after that instead of painting over it.
    useMarketStore.getState().mergeKlinesInto(symbol, interval, page.candles, cursor);
    useMarketStore.getState().setKlineStatus(symbol, interval, "ready", undefined, page.history?.status);
    primeOlder(symbol, interval, page, page.candles.length >= limit);
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

/** Widen a window the client has just landed, once per (symbol, interval): one
 *  page is what the chart asked for, the second is what makes the first screen
 *  show real history. It runs only when all three hold: the candles on hand fall
 *  short of the target, the gateway says that page is exchange history, and it
 *  says an older page can actually be fetched right now. A stream-fed mirror
 *  window is just as long but has nothing behind it, and while the venue refuses
 *  the window the follow-up only buys another refusal.
 *
 *  The fourth condition is M5b's: when the gateway's mirror already holds the
 *  first screen's depth, the client asks for nothing. The crawl is what gathers
 *  that depth, a scroll-back is answered from the mirror in about a millisecond,
 *  and a second page here would only be a duplicate of work already done. */
function primeOlder(
  symbol: string,
  interval: Timeframe | string,
  page: { candles: KlineData[]; venueBacked: boolean; canGoOlder: boolean; history?: { bars: number } },
  fullPage: boolean,
) {
  const key = klineKey(symbol, interval);
  if (primed.has(key) || backfillExhausted.has(key)) return;
  const have = useMarketStore.getState().klines[symbol]?.[interval]?.length ?? 0;
  if (have >= HISTORY_TARGET || (page.history?.bars ?? 0) >= HISTORY_TARGET) {
    primed.add(key);
    return;
  }
  if (!fullPage || !page.venueBacked || !page.canGoOlder) return;
  primed.add(key);
  void loadOlderKlines(symbol, interval, Math.min(BACKFILL_LIMIT, HISTORY_TARGET - have));
}

/** Floor between tail refreshes. `loadHistoricalKlines` re-arms its retry
 *  ladder on every call, so an unguarded refresh would defeat the decay. */
const REFRESH_MIN_MS = 5_000;

const lastRefreshAt = new Map<string, number>();

/** True when the newest stored candle still covers the present moment. */
export function hasRecentTail(klines: KlineData[]): boolean {
  const last = klines[klines.length - 1];
  return last ? isCurrentBar(last) : false;
}

/**
 * Heal a frozen right-hand edge or an interior gap the gateway may have filled
 * since this window was served. Used for events that can silently stall delivery
 * (a backgrounded tab throttles timers and WebSocket handling without the socket
 * ever reporting a drop) and for the chart's gap poll. Skips when a load is
 * pending or failing — that path owns its own retry ladder. Returns whether the
 * window is live.
 */
export async function refreshRecentKlines(symbol: string, interval: Timeframe | string): Promise<boolean> {
  const key = klineKey(symbol, interval);
  const state = useMarketStore.getState();
  const existing = state.klines[symbol]?.[interval] ?? EMPTY_KLINES;
  const live = hasRecentTail(existing);
  const missing = missingHistory(existing, interval as Timeframe).bars;
  if (live && missing === 0) return true;

  const klineStatus = state.klineStatus[key];
  if (klineStatus?.state === "error") return false;

  const last = lastRefreshAt.get(key) ?? 0;
  if (Date.now() - last < REFRESH_MIN_MS) return false;
  lastRefreshAt.set(key, Date.now());

  // Repair the newest internal gap directly instead of repeatedly fetching
  // the latest page, which cannot fill a gap deeper in the series.
  const span = TIMEFRAME_SPAN_MS[interval as Timeframe] ?? 60_000;
  let gap: { endTime: number; bars: number } | undefined;

  for (let i = existing.length - 1; i > 0; i--) {
    const prev = existing[i - 1]!;
    const next = existing[i]!;
    const bars = Math.floor((next.openTime - prev.openTime) / span) - 1;
    if (bars > 0) {
      gap = { endTime: next.openTime - 1, bars };
      break;
    }
  }

  if (gap && !inFlightGapRepair.has(key)) {
    inFlightGapRepair.add(key);
    try {
      const cursor = klineTickCursor();
      const page = await fetchKlineBatch(
        symbol,
        interval,
        Math.min(BACKFILL_LIMIT, gap.bars),
        gap.endTime,
      );
      useMarketStore.getState().mergeKlinesInto(symbol, interval, page.candles, cursor);
    } catch (err) {
      console.warn("[GapRepair] Failed:", {
        symbol,
        interval,
        gap,
        error: err,
      });
    } finally {
      inFlightGapRepair.delete(key);
    }
  }

  const afterGap = useMarketStore.getState().klines[symbol]?.[interval] ?? EMPTY_KLINES;
  if (!hasRecentTail(afterGap)) {
    await loadHistoricalKlines(symbol, interval);
  }

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
    // The browser is full, the exchange is not: scrolling further would push the
    // live tail out of the series. Re-checked on every scroll rather than stored,
    // so a window that has room again is never left looking like ended history.
    return false;
  }

  const oldestOpenTime = existing[0]!.openTime;
  const wanted = Math.min(limit, budget);
  inFlightBackfill.add(key);
  try {
    // `end` is inclusive upstream, so asking for one ms before the oldest bar
    // keeps the boundary candle out of the page instead of wasting a slot.
    const cursor = klineTickCursor();
    const page = await fetchKlineBatch(symbol, interval, wanted, oldestOpenTime - 1);
    const batch = page.candles;
    // The gateway's own history state outranks anything inferred from a page
    // length: `exhausted` is the exchange ending the range, whatever the number
    // of candles on this page happens to look like.
    const ended = page.history?.status === "exhausted";
    if (ended) backfillExhausted.add(key);
    const older = batch.filter((k) => k.openTime < oldestOpenTime);
    if (older.length === 0) {
      // Only the venue can end a window. An empty mirror page would mean nothing
      // older than this in what we hold, which is a depth question, not history.
      if (ended || page.fromVenue) backfillExhausted.add(key);
      else backfillRetryAt.set(key, Date.now() + BACKFILL_RETRY_MS);
      return false;
    }
    useMarketStore.getState().mergeKlinesInto(symbol, interval, older, cursor);
    // A venue page shorter than asked is the exchange saying it has nothing
    // older. A mirror page shorter than asked is only how deep our mirror goes,
    // so the window stays open for a later scroll instead of being closed off.
    if (ended || batch.length < wanted) {
      if (page.fromVenue) backfillExhausted.add(key);
      else backfillRetryAt.set(key, Date.now() + BACKFILL_RETRY_MS);
    } else {
      backfillExhausted.delete(key);
    }
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
