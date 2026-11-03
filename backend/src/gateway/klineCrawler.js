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
 * What makes it stop: `complete` when the depth target is met *and* nothing is
 * missing from the window, `exhausted` when the venue itself returns a short page
 * at the oldest end (the exchange saying it has nothing older), and `waiting` for
 * everything else — including the mirror answering from its own memory, which is
 * never evidence about history.
 *
 * What it digs for: not only depth. A gateway that was down for three days comes
 * back with a window that is full of holes — bars on either side of the outage
 * sitting next to each other, painting a chart that looks continuous and stops
 * wherever the process did. Those runs are `gap`s, they are filled newest first,
 * and a window is not finished until both the count and the run are right.
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
  const stats = { pages: 0, merged: 0, completed: 0, exhausted: 0, waited: 0, skipped: 0, healed: 0 };

  /** How long to sit out after a page that did not land. Two refused pages in a
   *  row are worth waiting longer for: a venue that banned this host does not
   *  unban it because we asked again. */
  const failDelay = (attempts) => Math.min(backoffMs * 2 ** Math.min(attempts, 4), backoffMaxMs);

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
   *  queued — crawling from a stale cursor would refetch a page we just got.
   *
   *  `store.warm` is why this pass can afford to look at the candles at all: the
   *  read (and the gunzip of a 20 000-candle window) happens off the event loop,
   *  so a crawl step never delays the request it is sharing the lane with. */
  async function step(symbol, interval) {
    const key = `${symbol}|${interval}`;
    if (stopped || running.has(key)) return false;
    let before = store.progress(symbol, interval);
    // Asked before the candles are touched: a window in backoff is not going to
    // the venue on this pass, and deciding that from a cold window would cost a
    // disk read and a gap scan on exactly the path the backoff exists to slow down.
    if (Date.now() < before.nextRetryAt) {
      schedule(key, symbol, interval, before.nextRetryAt - Date.now());
      return false;
    }
    // The gap decides whether a full window is really finished, so it is asked of
    // the candles themselves — a cold window is read back rather than trusted on
    // the label a previous run left on disk.
    if (!before.loaded) {
      await store.warm(symbol, interval);
      if (stopped) return false;
      // Re-read: the stream may have appended, and the crawl's decision has to be
      // made on the window as it is now, not as it looked before the read.
      before = store.progress(symbol, interval);
    }
    const gap = before.gap;
    if (before.status === "complete" && !gap) {
      stats.skipped += 1;
      return false;
    }
    // "Nothing older than the oldest bar" is still true when the middle of the
    // window has a hole: the exchange ended the range behind us, not in front of
    // the missing run. Depth stops, a gap does not.
    if (before.status === "exhausted" && !gap) {
      stats.skipped += 1;
      return false;
    }
    if (!gap && before.bars >= before.target) {
      store.markProgress(symbol, interval, { status: "complete", lastError: null, nextRetryAt: 0 });
      stats.completed += 1;
      return false;
    }
    // A hole is dug for before depth: an absent afternoon is worse than a window
    // that is 9,000 candles deep instead of 10,000, and the chart is showing the
    // hole right now. Asked from the newest end of the run, so a page that lands
    // short leaves a smaller hole rather than an ambiguous one.
    const cursor = gap
      ? gap.to
      // Nothing held yet: there is no older bound to crawl from. The page the
      // client asked for anchors the window, and the trigger fires again after it.
      : (before.cursor ?? (store.oldest(symbol, interval) === null
        ? null : store.oldest(symbol, interval) - 1));
    if (cursor === null) {
      store.markProgress(symbol, interval, { status: "idle", nextRetryAt: 0 });
      return false;
    }
    const limit = gap ? Math.min(page, gap.bars) : page;

    running.add(key);
    store.markProgress(symbol, interval, { status: "crawling" });
    let page1;
    try {
      page1 = await fetchPage(symbol, interval, limit, cursor, { background: true });
    } catch (err) {
      page1 = null;
      stats.waited += 1;
      const attempts = before.attempts ?? 0;
      const delay = failDelay(attempts);
      store.markProgress(symbol, interval, {
        status: "waiting",
        lastError: err.message,
        // The cursor is deliberately untouched: the same range is what has to
        // be fetched again once the venue is reachable — depth or hole alike.
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
    // cool-off). Nothing was learned about history, so nothing is concluded —
    // and the pass waits like a refused page instead of re-arming at crawl speed:
    // a cool-off outlives a page, and spinning a timer against it is churn with
    // no upstream request to show for it.
    if (!page1) {
      stats.skipped += 1;
      const attempts = (before.attempts ?? 0) + 1;
      const delay = failDelay(before.attempts ?? 0);
      store.markProgress(symbol, interval, {
        status: "waiting",
        lastError: "the request lane did not go out",
        attempts,
        nextRetryAt: Date.now() + delay,
      });
      schedule(key, symbol, interval, delay);
      return false;
    }
    stats.pages += 1;

    // The mirror answering an older page is our own memory, not the venue's:
    // it cannot extend history, and treating it as if it did would freeze the
    // cursor on bars we already counted. This is what a blocked venue looks like
    // from here — the fetcher fell back to the mirror — so the streak grows and
    // the next probe waits instead of arriving every few seconds.
    if (page1.source !== "venue") {
      stats.waited += 1;
      const attempts = (before.attempts ?? 0) + 1;
      const delay = failDelay(before.attempts ?? 0);
      store.markProgress(symbol, interval, {
        status: "waiting",
        lastError: "venue did not answer",
        attempts,
        nextRetryAt: Date.now() + delay,
      });
      schedule(key, symbol, interval, delay);
      return false;
    }

    const rows = Array.isArray(page1.data) ? page1.data : [];
    store.markProgress(symbol, interval, { pages: (before.pages ?? 0) + 1, attempts: 0, lastError: null });
    if (rows.length === 0) {
      // A hole the venue answers with nothing for is a range we are not going to
      // get — the market did not print there, or the block covers it. That is not
      // the end of history (the bars after the hole are already held), so the
      // window waits and re-probes on the backoff while the gap stays reported.
      if (gap) {
        stats.waited += 1;
        store.markProgress(symbol, interval, {
          status: "waiting",
          lastError: `venue had no ${interval} candles for the gap from ${gap.from}`,
          attempts: (before.attempts ?? 0) + 1,
          nextRetryAt: Date.now() + failDelay(before.attempts ?? 0),
        });
        schedule(key, symbol, interval, failDelay(before.attempts ?? 0));
        return false;
      }
      // A valid venue page with nothing in it: the exchange says there is no
      // older history at all. Stop asking for this window.
      store.markProgress(symbol, interval, { status: "exhausted", exhaustedAt: Date.now(), nextRetryAt: 0 });
      stats.exhausted += 1;
      return true;
    }
    const added = store.rememberOlder(symbol, interval, rows);
    stats.merged += rows.length;

    if (gap) {
      // Nothing new inside the run means the venue only re-served bars the window
      // already had: the hole is not fetchable, and re-asking at crawl speed for
      // the same answer would be a request loop over a range of chart.
      if (added === 0) {
        stats.waited += 1;
        store.markProgress(symbol, interval, {
          status: "waiting",
          lastError: `venue served no new candles for the gap from ${gap.from}`,
          attempts: (before.attempts ?? 0) + 1,
          nextRetryAt: Date.now() + failDelay(before.attempts ?? 0),
        });
        schedule(key, symbol, interval, failDelay(before.attempts ?? 0));
        return false;
      }
      stats.healed += 1;
      log.info("klines gap healed", { symbol, interval, from: gap.from, to: gap.to, bars: gap.bars, added });
      // Straight on: the next pass re-scans and either finds the rest of this run,
      // the next hole, or the depth the window is still short of. A middle page
      // says nothing about where history ends, so none of the depth conclusions
      // below apply to it.
      schedule(key, symbol, interval, gapMs);
      return true;
    }

    const after = store.progress(symbol, interval);
    if (after.bars >= after.target && !after.gap) {
      store.markProgress(symbol, interval, { status: "complete", nextRetryAt: 0 });
      stats.completed += 1;
      return true;
    }
    // A page shorter than the request is the venue ending the range behind it.
    if (rows.length < limit) {
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
     *  same pair cost one crawl, not one per caller.
     *
     *  Synchronous and disk-free by construction: this is called straight after
     *  a client's chart request is answered, so the one thing it must not do is
     *  read a cold window back from disk to decide. A window whose bytes are not
     *  in RAM has an *unknown* gap, which is treated as "worth a look": the step
     *  warms it asynchronously and skips itself if it turns out to be finished. */
    trigger(symbol, interval) {
      const key = `${symbol}|${interval}`;
      const p = store.progress(symbol, interval);
      // In backoff is in backoff: the next attempt already has a time on it, and
      // looking up whether this window is *also* hollow would cost a disk read for
      // a page that is not allowed to go out yet.
      if (p.nextRetryAt > Date.now()) return false;
      // Finished means finished: deep *and* unbroken. A window that reached its
      // target before the gateway went down is labelled complete on disk and is
      // not — the outage left a hole in it, and that hole is what the chart shows.
      const settled = p.status === "complete" || p.status === "exhausted" || p.bars >= p.target;
      if (settled && p.loaded && !p.gap) return false;
      if (active.has(key) || running.has(key)) return false;
      schedule(key, symbol, interval, 0);
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
