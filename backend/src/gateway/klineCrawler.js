/**
 * The history crawl: the page-by-page walk that turns "one 1000-candle page"
 * into the depth the store's policy table asks for.
 *
 * Why it is not a boot-time sweep: Bybit answers at most 1000 candles per
 * request, so a 10000-candle window is ten requests per pair, and most of the
 * pairs the terminal can list are never opened. The crawl therefore starts at
 * the moment a window is actually demanded and continues while that window is
 * still wanted, one page per pass, in the same serialized lane as everything
 * else upstream. The chart never waits for it: the first paint comes from the
 * mirror or from the page the client asked for.
 *
 * What makes it resumable: the cursor (the `endTime` the next page starts at)
 * and the status live in the window's metadata and reach disk before the next
 * page is attempted. So a 403, a restart or a shutdown between pages resumes
 * from the last bar actually held — never from zero, and never with a gap.
 *
 * What makes it stop: `complete` when the depth target is met, `exhausted` when
 * the venue itself returns a short page (the exchange saying it has nothing
 * older), and `waiting` for everything else — including the mirror answering
 * from its own memory, which is never evidence about history.
 */

/** Candles per page: the venue's own ceiling. Deeper is not possible, so a
 *  bigger number would only mean fewer, larger, slower-to-merge steps. */
export const CRAWL_PAGE = 1000;
/** Pause between two crawl pages of the same window. It is deliberately longer
 *  than the lane's minimum spacing: crawl work must not crowd out a client's
 *  own request for the serialized Bybit queue. */
const CRAWL_GAP_MS = 750;
/** First backoff after a refused page, and the ceiling it decays to. A window
 *  the venue blocks stays blocked for minutes, not seconds — probing faster
 *  only extends the ban the crawl exists to ride out. */
const CRAWL_BACKOFF_MS = 5000;
const CRAWL_BACKOFF_MAX_MS = 300_000;

export function createKlineCrawler({
  store, fetchPage, logger,
  page = CRAWL_PAGE,
  gapMs = CRAWL_GAP_MS,
  backoffMs = CRAWL_BACKOFF_MS,
  backoffMaxMs = CRAWL_BACKOFF_MAX_MS,
}) {
  const log = logger || { info() {}, warn() {}, error() {} };
  const active = new Map(); // "SYM|iv" -> timer of the next scheduled page
  const running = new Set(); // windows with a page in flight
  let stopped = false;
  const stats = { pages: 0, merged: 0, completed: 0, exhausted: 0, waited: 0, skipped: 0 };

  function schedule(key, symbol, interval, delayMs) {
    if (stopped || active.has(key)) return;
    const t = setTimeout(() => {
      active.delete(key);
      void step(symbol, interval);
    }, delayMs);
    t.unref?.();
    active.set(key, t);
  }

  /** One page for one window. Re-checked against the store every time, because
   *  the client's own scroll-back may have advanced the cursor while this was
   *  queued — crawling from a stale cursor would refetch a page we just got. */
  async function step(symbol, interval) {
    const key = `${symbol}|${interval}`;
    if (stopped || running.has(key)) return false;
    const before = store.progress(symbol, interval);
    if (before.status === "complete" || before.status === "exhausted") {
      stats.skipped += 1;
      return false;
    }
    if (before.bars >= before.target) {
      store.markProgress(symbol, interval, { status: "complete", lastError: null, nextRetryAt: 0 });
      stats.completed += 1;
      return false;
    }
    if (Date.now() < before.nextRetryAt) {
      schedule(key, symbol, interval, before.nextRetryAt - Date.now());
      return false;
    }
    // Nothing held yet: there is no older bound to crawl from. The page the
    // client asked for anchors the window, and the trigger fires again after it.
    const cursor = before.cursor ?? (store.oldest(symbol, interval) === null
      ? null : store.oldest(symbol, interval) - 1);
    if (cursor === null) {
      store.markProgress(symbol, interval, { status: "idle", nextRetryAt: 0 });
      return false;
    }

    running.add(key);
    store.markProgress(symbol, interval, { status: "crawling" });
    let page1;
    try {
      page1 = await fetchPage(symbol, interval, page, cursor, { background: true });
    } catch (err) {
      page1 = null;
      stats.waited += 1;
      const attempts = before.attempts ?? 0;
      // Two refused pages in a row are worth waiting longer for: a venue that
      // banned this host does not unban it because we asked again.
      const delay = Math.min(backoffMs * 2 ** Math.min(attempts, 4), backoffMaxMs);
      store.markProgress(symbol, interval, {
        status: "waiting",
        lastError: err.message,
        // The cursor is deliberately untouched: the same range is what has to
        // be fetched again once the venue is reachable.
        nextRetryAt: Date.now() + delay,
        attempts: attempts + 1,
      });
      schedule(key, symbol, interval, delay);
      running.delete(key);
      return false;
    }
    running.delete(key);
    if (stopped) return false;

    // No page at all means the lane refused to go out (a window or global
    // cool-off). Nothing was learned about history, so nothing is concluded.
    if (!page1) {
      stats.skipped += 1;
      store.markProgress(symbol, interval, { status: "waiting", nextRetryAt: Date.now() + gapMs });
      schedule(key, symbol, interval, gapMs);
      return false;
    }
    stats.pages += 1;

    // The mirror answering an older page is our own memory, not the venue's:
    // it cannot extend history, and treating it as if it did would freeze the
    // cursor on bars we already counted.
    if (page1.source !== "venue") {
      stats.waited += 1;
      store.markProgress(symbol, interval, {
        status: "waiting",
        lastError: "venue did not answer",
        nextRetryAt: Date.now() + Math.min(backoffMs * 2, backoffMaxMs),
      });
      schedule(key, symbol, interval, gapMs * 2);
      return false;
    }

    const rows = Array.isArray(page1.data) ? page1.data : [];
    store.markProgress(symbol, interval, { pages: (before.pages ?? 0) + 1, attempts: 0, lastError: null });
    if (rows.length === 0) {
      // A valid venue page with nothing in it: the exchange says there is no
      // older history at all. Stop asking for this window.
      store.markProgress(symbol, interval, { status: "exhausted", exhaustedAt: Date.now(), nextRetryAt: 0 });
      stats.exhausted += 1;
      return true;
    }
    store.rememberOlder(symbol, interval, rows);
    stats.merged += rows.length;

    const after = store.progress(symbol, interval);
    if (after.bars >= after.target) {
      store.markProgress(symbol, interval, { status: "complete", nextRetryAt: 0 });
      stats.completed += 1;
      return true;
    }
    // A page shorter than the request is the venue ending the range behind it.
    if (rows.length < page) {
      store.markProgress(symbol, interval, { status: "exhausted", exhaustedAt: Date.now(), nextRetryAt: 0 });
      stats.exhausted += 1;
      return true;
    }
    schedule(key, symbol, interval, gapMs);
    return true;
  }

  return {
    /** Start (or keep) crawling one window. Idempotent: a window already
     *  scheduled or in flight is left alone, so several callers demanding the
     *  same pair cost one crawl, not one per caller. */
    trigger(symbol, interval) {
      const key = `${symbol}|${interval}`;
      const p = store.progress(symbol, interval);
      if (p.status === "complete" || p.status === "exhausted") return false;
      if (active.has(key) || running.has(key)) return false;
      schedule(key, symbol, interval, p.nextRetryAt > Date.now() ? p.nextRetryAt - Date.now() : 0);
      return true;
    },

    /** Await the pending page of one window (tests and shutdown). */
    async pending(symbol, interval) {
      const key = `${symbol}|${interval}`;
      while (running.has(key)) await new Promise((r) => setTimeout(r, 5));
      return store.progress(symbol, interval);
    },

    stats() { return { ...stats, scheduled: active.size, running: running.size }; },

    /** Cancel every pending page. A crawl in flight finishes and its page is
     *  still merged — throwing away fetched history would be the worse loss. */
    stop() {
      stopped = true;
      for (const t of active.values()) clearTimeout(t);
      active.clear();
    },
  };
}
