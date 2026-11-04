import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync, gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import path from "node:path";
import { intervalMs, slotOf } from "../intervals.js";
import { isValidTuple, toValidTuple, tuplesFromPage } from "../candleValidation.js";

/** The async halves of the two codecs: a window is a few hundred kB, and reading
 *  or deflating it on the serving thread is what makes a chart stutter. */
const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

/**
 * Candle windows per (symbol, interval): history depth on disk, live edge in RAM.
 *
 * Two facts shape this store.
 *
 * - History is immutable, so a page fetched once never has to be fetched again.
 *   That makes the disk the right place to keep depth, and leaves the websocket
 *   as the only thing that has to stay fresh.
 * - Bybit answers at most 1000 candles per request, so any depth past that is a
 *   *collection of pages* arriving over minutes. The store therefore keeps
 *   per-window progress — how deep we are, where the next page starts, why the
 *   last one failed — not just candles.
 *
 * Each window is one gzip file (`BTCUSDT_1m.json.gz`) written through a tmp file
 * and renamed, so a crash mid-write leaves the previous window intact. One file
 * per window because rewriting a shared mirror would re-compress every window
 * every time any candle ticks, and because a corrupt file should cost one pair,
 * not the whole history.
 *
 * Only the hot windows keep their candles in RAM (an LRU of `hotWindows`); the
 * rest stay complete on disk. A window that went cold is read back *asynchronously*
 * by `warm()` before the serving path touches it, so a chart never pays disk time
 * on the event loop; the synchronous read stays only for mutators that must merge
 * against the window's bytes before anything else happens.
 */

/** Where per-window files live. */
const DEFAULT_DIR = path.join(import.meta.dirname, "..", "..", "data", "klines");
/** The pre-M5b single-file mirror, split into per-window files on first boot. */
const LEGACY_FILE = path.join(import.meta.dirname, "..", "..", "data", "klines-cache.json");

/**
 * History depth to work toward, per timeframe, in candles. A target, never a
 * guarantee: the venue's own history ends whenever it ends, and then the window
 * is simply shorter. Sized so a chart plus a deep scroll fits without the browser
 * having to page the exchange: 1m at 10000 is about a week, 1h at 9000 about a
 * year, and 1d/1w are capped far above any contract's whole life.
 */
export const DEPTH_TARGETS = {
  "1m": 10_000,
  "3m": 8_000,
  "5m": 8_000,
  "15m": 6_000,
  "30m": 6_000,
  "1h": 9_000,
  "4h": 4_000,
  "1d": 20_000,
  "1w": 20_000,
};
/** A timeframe nobody listed still gets a sane depth. */
export const DEFAULT_DEPTH = 6_000;

export function depthTarget(interval) {
  return DEPTH_TARGETS[interval] ?? DEFAULT_DEPTH;
}

/** Windows allowed to hold candle bytes in RAM. ~1.3 MB per 10000 candles, so
 *  this is the history memory budget (KLINE_HOT_WINDOWS overrides it). */
const HOT_WINDOWS = 12;
/** Windows tracked at all (bytes on disk, progress in RAM). */
const MAX_WINDOWS = 48;
/** Payload writes are debounced per window: a page records thousands of candles,
 *  and a gzip pass over 10000 of them is real CPU. */
const PERSIST_DEBOUNCE_MS = 1500;
/** Progress fields are the resume point after a restart, so they reach disk
 *  sooner than the next candle happens to change. */
const STATE_DEBOUNCE_MS = 300;
/** gzip level 1: the pages are written often and read back rarely, and the
 *  difference between level 1 and 6 on 10000 candles is CPU, not worth it. */
const GZIP_LEVEL = 1;
/** Read errors that mean "the disk did not answer", not "the file is junk". A
 *  window is never overwritten on the strength of one of these. */
const TRANSIENT_READ_CODES = new Set(["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE", "EBUSY", "ENOMEM", "ENOSPC", "EISDIR", "ENOTDIR"]);
/** How many slots may be absent at the end of a window before that counts as a
 *  hole. The bar covering the present moment is still forming and belongs to the
 *  websocket, so asking the venue for one or two skipped slots on every pass
 *  would spend a request on bars that arrive by themselves within a minute. */
const TAIL_GAP_MIN_BARS = 2;

/** A stored tuple is re-validated on the way in, so a file written by an older,
 *  laxer build cannot keep a broken bar alive: `>= 0` prices used to pass here,
 *  which is how a venue field that never arrived could be read back as a candle
 *  priced at zero. */
function isTuple(v, interval) {
  return isValidTuple(v, interval);
}

/** Tuples back to the wire shape. `closed` is derived, never stored: a cached bar
 *  must not claim to be closed when the clock says it is still forming. */
function toCandles(tuples, interval) {
  const ms = intervalMs(interval);
  const now = Date.now();
  return tuples.map((t) => ({
    interval,
    openTime: t[0],
    closeTime: t[0] + ms - 1,
    open: t[1],
    high: t[2],
    low: t[3],
    close: t[4],
    volume: t[5],
    closed: t[0] + ms <= now,
  }));
}

/** Pages arrive in whatever order their source produced: the venue itself answers
 *  newest-first, the websocket arrives one bar at a time, and a mirror file that
 *  predates this store can be in any order at all. Every merge below assumes
 *  ascending, so the window's own order is normalized on the way in — otherwise
 *  one out-of-order page scrambles the edges, and the crawl cursor read from
 *  `candles[0]` then points at the middle of the history. Repeated slots keep
 *  the later read, the same rule `mergeTuples` applies across two pages. */
function normalizeTuples(tuples) {
  let unsorted = false;
  let duplicate = false;
  for (let i = 1; i < tuples.length; i++) {
    if (tuples[i][0] < tuples[i - 1][0]) unsorted = true;
    else if (tuples[i][0] === tuples[i - 1][0]) duplicate = true;
  }
  if (!unsorted && !duplicate) return tuples;
  const ordered = unsorted ? [...tuples].sort((a, b) => a[0] - b[0]) : tuples;
  const out = [];
  for (const t of ordered) {
    if (out.length && out[out.length - 1][0] === t[0]) out[out.length - 1] = t;
    else out.push(t);
  }
  return out;
}

/** Two ascending tuple runs into one ascending, de-duplicated run. On a shared
 *  timestamp the incoming page wins — it is the fresher read of the same bar. */
function mergeTuples(base, incoming) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < base.length && j < incoming.length) {
    const b = base[i][0];
    const n = incoming[j][0];
    if (b < n) out.push(base[i++]);
    else if (b > n) out.push(incoming[j++]);
    else { out.push(incoming[j]); i++; j++; }
  }
  while (i < base.length) out.push(base[i++]);
  while (j < incoming.length) out.push(incoming[j++]);
  return out;
}

/** Pages arrive newest-end-first from the venue and are merged ascending, so a
 *  page's own span is its first and last openTime. */
function pageSpan(tuples) {
  return { from: tuples[0][0], to: tuples[tuples.length - 1][0] };
}

function fileName(symbol, interval) {
  return `${symbol}_${interval}.json.gz`;
}

function newWindow(symbol, interval, target) {
  return {
    symbol,
    interval,
    /** Last time anything in this window changed. Drives the MAX_AGE test. */
    at: 0,
    loaded: false,
    candles: null,
    /** Candles held, whether or not they are in RAM. */
    bars: 0,
    /** Candles the venue itself served, as opposed to websocket ticks: what
     *  "we have history" and "we have a tail" really mean. */
    venue: false,
    venueFrom: null,
    venueTo: null,
    venueBars: 0,
    /** The live edge is in this window. A page of month-old bars is history and
     *  must never answer a "what is recent" read. */
    current: false,
    /** Crawl progress, kept even while the window is cold: this is what makes a
     *  restart continue from where it stopped instead of starting over. */
    cursor: null,
    status: "idle",
    nextRetryAt: 0,
    lastError: null,
    /** Consecutive failed pages, so the backoff can grow across steps. */
    attempts: 0,
    /** When the venue itself ended this range, for the history state a client
     *  or an operator reads next to `bars`. */
    exhaustedAt: 0,
    pages: 0,
    target,
    lastTouched: 0,
    /** What the last file on disk actually contained, so an unchanged window is
     *  never rewritten, and a newer write always wins over an older one. */
    writtenGen: 0,
    writtenSig: null,
    gen: 0,
    /** Bumped by anything that changes the window's candles. `gap`/`missing` are
     *  functions of the candles and nothing else, so this is the key their memo is
     *  validated against (see `scanMeta`). */
    rev: 0,
    /** { rev, slot, out } — the last scan result and exactly what it describes. */
    scan: null,
    /** The async read in flight for this window, shared by every caller that asks
     *  for it, so two charts on one cold window cost one disk read. */
    reading: null,
  };
}

/**
 * @param file         the window mirror's identity: `<file without .json>.d/`
 *                     becomes the per-window directory, so callers (and tests)
 *                     that isolate a temp path isolate their windows with it.
 * @param dir          override the directory directly.
 * @param legacyFile   the pre-M5b single-file mirror to migrate from.
 */
export function createKlinesStore({ file, dir, legacyFile = LEGACY_FILE, logger, hotWindows, depthTargets } = {}) {
  const log = logger || { info() {}, warn() {}, error() {} };
  const cap = Math.max(1, Number(hotWindows ?? process.env.KLINE_HOT_WINDOWS) || HOT_WINDOWS);
  // The policy stays one table; an operator or a test can restate it without
  // editing the module, which is what makes the depth budget configurable.
  const policy = { ...DEPTH_TARGETS, ...(depthTargets ?? {}) };
  const targetFor = (interval) => policy[interval] ?? DEFAULT_DEPTH;
  const root = dir || (file ? `${file.replace(/\.json$/, "")}.d` : DEFAULT_DIR);
  // A caller that names its own mirror file has nowhere else for the old bytes
  // to come from; the default layout keeps the documented legacy path.
  const legacyFrom = file && legacyFile === LEGACY_FILE ? file : legacyFile;
  const windows = new Map(); // "SYM|iv" -> record
  const timers = new Map();
  let dirReady = null;
  let dirMade = false;
  let seq = 0;
  const io = { reads: 0, readMs: 0, writes: 0, writeMs: 0, encodeMs: 0, bytes: 0, failedReads: 0 };

  const keyOf = (symbol, interval) => `${symbol}|${interval}`;
  const fileOf = (w) => path.join(root, fileName(w.symbol, w.interval));

  function recount(w) {
    if (!w.candles) return;
    w.bars = w.candles.length;
    if (w.venue && w.venueFrom !== null && w.venueTo !== null) {
      let n = 0;
      for (const t of w.candles) if (t[0] >= w.venueFrom && t[0] <= w.venueTo) n += 1;
      w.venueBars = n;
    }
  }

  /** Depth is a sliding budget: past the target the oldest bars leave the window
   *  rather than the window growing without bound. Also the one place every
   *  candle mutation passes, so it is where the window's content revision moves. */
  function capWindow(w) {
    w.rev += 1;
    if (!w.candles) return;
    if (w.candles.length > w.target) w.candles = w.candles.slice(w.candles.length - w.target);
    recount(w);
  }

  function hotCount() {
    let n = 0;
    for (const v of windows.values()) if (v.loaded) n += 1;
    return n;
  }

  /** Drop the bytes from RAM, keeping the window complete on disk first. The
   *  write is synchronous: whoever evicted a window may be the one that asks for
   *  it back on the next line, and a rename still in flight would answer them
   *  with an empty window that then gets written as if it were the truth. */
  function evict(w) {
    if (!w.loaded) return;
    const sig = signature(w);
    const snapshot = sig === w.writtenSig ? null : encode(w);
    w.candles = null;
    w.loaded = false;
    // Nothing changed since the file on disk: eviction costs no rewrite at all.
    if (!snapshot) return;
    const started = Date.now();
    try {
      writeSnapshotSync(fileOf(w), snapshot.buf);
    } catch (err) {
      log.warn("klines window write failed", { key: keyOf(w.symbol, w.interval), err: err.message });
      return;
    }
    io.writes += 1;
    io.writeMs += Date.now() - started;
    io.bytes += snapshot.buf.length;
    w.writtenGen = snapshot.gen;
    w.writtenSig = sig;
  }

  function makeRoom() {
    while (hotCount() > cap) {
      let victim = null;
      for (const v of windows.values()) {
        if (!v.loaded) continue;
        // A crawling window owns its bytes: eviction mid-page would make the
        // page merge against a re-read file and lose the point of the cursor.
        if (v.status === "crawling") continue;
        if (!victim || v.lastTouched < victim.lastTouched) victim = v;
      }
      if (!victim) return;
      evict(victim);
    }
  }

  function touch(w) {
    w.lastTouched = ++seq;
    makeRoom();
  }

  /** How many slots are absent between the newest bar and the one still forming
   *  right now. Counted from the newest bar's own slot onward rather than from an
   *  epoch-derived "current slot", because a weekly bar sits four days off the
   *  epoch grid (`intervalOrigin`); an epoch calculation then reports a hole that
   *  is not there, or misses one that is. */
  function tailSlots(newestOpenTime, interval) {
    const ms = intervalMs(interval);
    if (!(ms > 0) || !Number.isFinite(newestOpenTime)) return 0;
    // The slot the market is in now belongs to the forming bar, which arrives on
    // the websocket: only bars strictly between it and the newest bar are missing.
    const forming = slotOf(Date.now(), interval);
    return Math.max(0, Math.round((forming - newestOpenTime - ms) / ms));
  }

  /** Whether a window still reaches the present, judged from its newest bar and
   *  not from when the file was written: a daily window legitimately changes once
   *  a day, and a websocket-fed one has to be dropped the moment the stream stops
   *  feeding it. Past that it is history — still worth serving as a backfill page,
   *  never as the live edge.
   *
   *  Judged as a tail count, not as a wall-clock age: `3 h` is generous beyond use
   *  for a 1 m window (180 absent bars still read as live) and far too tight for a
   *  weekly one, whose newest bar is legitimately six days old. A window is the
   *  live edge only when nothing but the tolerated forming end is missing. */
  function reachesNow(w, newestOpenTime) {
    if (!Number.isFinite(newestOpenTime)) return false;
    return tailSlots(newestOpenTime, w.interval) < TAIL_GAP_MIN_BARS;
  }

  /** The newest run of slots this window should contain and does not.
   *
   *  A mirror develops holes the same way whenever the gateway was down while the
   *  market kept printing: the bars on either side of the outage are neighbours
   *  in the array, so a reader sees a continuous chart and cannot tell that days
   *  of history are absent. The end of the window is the same question — a stream
   *  that stopped feeding leaves bars between its newest candle and now.
   *
   *  Scanned newest-first and returning the first run, because that is the one on
   *  screen: healing the recent hole before the ancient one is what makes the
   *  visible chart correct soonest. `null` means the candles held are unbroken
   *  from their oldest bar up to the present, which is the only state a window
   *  may be called complete in.
   */
  function scanGap(w) {
    const candles = w.candles;
    if (!candles || candles.length === 0) return null;
    const ms = intervalMs(w.interval);
    if (!(ms > 0)) return null;
    /** Slots strictly between two openTimes — adjacent bars give zero. */
    const slots = (a, b) => Math.max(0, Math.floor((b - a - 1) / ms));
    const newest = candles[candles.length - 1][0];
    const tail = tailSlots(newest, w.interval);
    if (tail >= TAIL_GAP_MIN_BARS) {
      // Both ends stay on the venue's own grid: the crawler asks for the hole,
      // not for a range shifted onto an epoch boundary that is not a bar slot.
      return { from: newest + ms, to: newest + tail * ms, bars: tail };
    }
    for (let i = candles.length - 1; i > 0; i--) {
      const missing = slots(candles[i - 1][0], candles[i][0]);
      if (missing > 0) {
        return { from: candles[i - 1][0] + ms, to: candles[i][0] - ms, bars: missing };
      }
    }
    return null;
  }

  /** Everything the window leaves out, not just the newest run.
   *
   *  `scanGap` answers "what is fetched next"; it cannot answer "how much of this
   *  chart is absent", and quoting only its count is what let a 1 m window missing
   *  7,791 bars in 7 runs report a shortfall of 4. One pass, and only for a window
   *  whose bytes are already in RAM — the same rule `scanGap` is held to. */
  function coverage(w) {
    const candles = w.candles;
    if (!candles || candles.length === 0) return null;
    const ms = intervalMs(w.interval);
    if (!(ms > 0)) return null;
    let missing = 0;
    let runs = 0;
    for (let i = candles.length - 1; i > 0; i--) {
      const absent = Math.max(0, Math.floor((candles[i][0] - candles[i - 1][0] - 1) / ms));
      if (absent > 0) { missing += absent; runs += 1; }
    }
    const tail = tailSlots(candles[candles.length - 1][0], w.interval);
    if (tail > 0) { missing += tail; runs += 1; }
    return { missing, runs, held: candles.length };
  }

  /** The two full-window scans, memoized.
   *
   *  `scanGap` and `coverage` walk every bar of a window — up to ten thousand —
   *  and both are read on the serving path for every page, so without a memo the
   *  gateway pays two linear scans per chart request for an answer that only
   *  changes when the candles do. Their inputs are exactly two things: the bars
   *  held (`rev`, bumped by every mutation) and the slot the market is in now
   *  (`slotOf(Date.now())`, the only way either scan sees the clock — the forming
   *  bar's slot is the end of the tail). A memo keyed on both is therefore not a
   *  TTL guess: it is stale precisely when the answer would differ, and never
   *  else. */
  function scanMeta(w) {
    if (!w.loaded || !w.candles || w.candles.length === 0) return { gap: null, missing: null };
    const slot = slotOf(Date.now(), w.interval);
    if (w.scan && w.scan.rev === w.rev && w.scan.slot === slot) return w.scan.out;
    const out = { gap: scanGap(w), missing: coverage(w) };
    w.scan = { rev: w.rev, slot, out };
    return out;
  }

  /** What a window file would have to contain to be worth writing: the depth,
   *  the edges, and the point a crawl resumes from. Two things are deliberately
   *  left out. The retry clock (`nextRetryAt`, `attempts`), because a blocked
   *  venue moves it every few hundred ms and rewriting ten thousand candles to
   *  save a timestamp is the fixed-timer rewrite this store exists to avoid — a
   *  restart re-probes once and the fetcher's cool-off rebuilds it. And the
   *  forming bar's *values*, because the stream rewrites them every second while
   *  a new bar opens once a minute: the newest bar's slot is what counts as
   *  depth, and its fresher close arrives over the websocket anyway. */
  function signature(w) {
    const c = w.candles;
    if (!c) return null;
    const first = c[0], last = c[c.length - 1];
    return [w.bars, first ? first[0] : 0, last ? last[0] : 0,
      w.cursor, w.status, w.venueFrom, w.venueTo, w.pages].join("|");
  }

  function windowBody(w) {
    return {
      symbol: w.symbol, interval: w.interval, at: w.at, venue: w.venue, current: w.current,
      bars: w.bars, venueBars: w.venueBars, venueFrom: w.venueFrom, venueTo: w.venueTo,
      cursor: w.cursor, status: w.status, nextRetryAt: w.nextRetryAt,
      lastError: w.lastError, attempts: w.attempts, exhaustedAt: w.exhaustedAt,
      pages: w.pages, target: w.target,
      candles: w.candles,
    };
  }

  function encode(w) {
    if (!w.candles) return null;
    const started = Date.now();
    const buf = gzipSync(Buffer.from(JSON.stringify(windowBody(w))), { level: GZIP_LEVEL });
    io.encodeMs += Date.now() - started;
    return { buf, gen: ++w.gen };
  }

  /** The same snapshot deflated off the event loop: what the migration pass uses,
   *  because it compresses every window of the old mirror in one go. */
  async function encodeAsync(w) {
    if (!w.candles) return null;
    const started = Date.now();
    const buf = await gzipAsync(Buffer.from(JSON.stringify(windowBody(w))), { level: GZIP_LEVEL });
    io.encodeMs += Date.now() - started;
    return { buf, gen: ++w.gen };
  }

  async function writeSnapshot(target, buf) {
    // The directory is created lazily here rather than in load(): a caller can
    // write a window it never loaded (a test, or the first page of a new pair),
    // and a missing directory must not silently swallow the mirror.
    if (!dirReady) {
      dirReady = mkdir(root, { recursive: true }).then(() => {
        dirMade = true;
        return true;
      }, (err) => {
        dirReady = null;
        throw err;
      });
    }
    await dirReady;
    await writeFile(`${target}.tmp`, buf);
    await rename(`${target}.tmp`, target); // atomic: a crash leaves the last good window
  }

  /** The same write, without the await — for the one path where the reader
   *  cannot be told to wait: eviction writes the bytes it is dropping from RAM
   *  synchronously, because a pending rename would let the very next read of
   *  that window answer with an empty one. */
  function writeSnapshotSync(target, buf) {
    if (!dirMade) {
      mkdirSync(root, { recursive: true });
      dirMade = true;
    }
    writeFileSync(`${target}.tmp`, buf);
    renameSync(`${target}.tmp`, target);
  }

  async function flushSnapshot(w, buf, gen, sig) {
    const started = Date.now();
    const target = fileOf(w);
    // An older snapshot that finishes after a newer one already reached disk
    // must not rename over it.
    if (gen < w.writtenGen) return;
    try {
      await writeSnapshot(target, buf);
    } catch (err) {
      log.warn("klines window write failed", { key: keyOf(w.symbol, w.interval), err: err.message });
      // The window is still unsaved, and the next change (or shutdown flush)
      // tries again. Re-arming a timer here would turn a full disk into a
      // write loop with nothing between the attempts.
      return;
    }
    io.writes += 1;
    io.writeMs += Date.now() - started;
    io.bytes += buf.length;
    if (gen > w.writtenGen) {
      w.writtenGen = gen;
      // What the file now holds, so an identical later change is not written.
      w.writtenSig = sig ?? null;
    }
  }

  function queuePersist(w, delay = PERSIST_DEBOUNCE_MS) {
    // Never write what we could not read: while the disk refuses this window, a
    // merge would be against a missing history and the file would lose to it.
    if (!w.loaded) return;
    const key = keyOf(w.symbol, w.interval);
    if (timers.has(key)) return;
    const t = setTimeout(() => {
      timers.delete(key);
      void persistNow(w);
    }, delay);
    t.unref?.();
    timers.set(key, t);
  }

  /** One window, one write, and only when its content actually moved. */
  function persistNow(w) {
    const sig = signature(w);
    if (sig === null || sig === w.writtenSig) return null;
    const snapshot = encode(w);
    if (!snapshot) return null;
    return flushSnapshot(w, snapshot.buf, snapshot.gen, sig);
  }

  /** The window's bytes in RAM, read back from disk if it had gone cold — and
   *  only when that puts the hot set back over the cap. A read is what makes a
   *  window hot, so the cap is enforced here as much as on the write path;
   *  otherwise a client scrolling through ten pairs would simply hold ten pairs. */
  function ensureBytes(w) {
    if (w.loaded) return true;
    if (!readWindow(w)) return false;
    touch(w);
    return true;
  }

  /** Fold a parsed window file into its record.
   *
   *  `keepExisting` is what makes an async read safe: the bytes were read while
   *  the event loop served something else, and anything merged into this window
   *  in the meantime is newer than the file. History is immutable, so the two are
   *  merged with the in-memory bars winning a shared slot — an old file must
   *  never shallow a live window — and the window's own progress fields, which
   *  only ever move forward while the process is alive, are kept. */
  function applyBody(w, body, { keepExisting = false } = {}) {
    if (!body || !Array.isArray(body.candles)) throw new Error("malformed window");
    const candles = normalizeTuples(body.candles.filter((t) => isTuple(t, w.interval)));
    const live = keepExisting && w.loaded ? w.candles : null;
    w.candles = live ? mergeTuples(candles, live) : candles;
    w.loaded = true;
    w.bars = w.candles.length;
    w.at = Number.isFinite(body.at) ? Math.max(body.at, live ? w.at : 0) : w.at;
    w.venue = body.venue === true || w.venue === true;
    // The file's own claim about the live edge is only true while its newest
    // bar still reaches the present; a window read back days later is history
    // and must not answer a "what is recent" read.
    w.current = body.current !== false && reachesNow(w, w.candles[w.candles.length - 1]?.[0]);
    const from = Number.isFinite(body.venueFrom) ? body.venueFrom : null;
    const to = Number.isFinite(body.venueTo) ? body.venueTo : null;
    w.venueFrom = live && w.venueFrom !== null ? Math.min(w.venueFrom, from ?? w.venueFrom) : from;
    w.venueTo = live && w.venueTo !== null ? Math.max(w.venueTo, to ?? w.venueTo) : to;
    w.venueBars = Number.isFinite(body.venueBars)
      ? Math.max(body.venueBars, live ? w.venueBars : 0)
      : (w.venue ? w.bars : 0);
    const cursor = Number.isFinite(body.cursor) ? body.cursor : null;
    // A crawl that was mid-page when the process died is not crawling any more;
    // the cursor it left is exactly where it picks up.
    const status = typeof body.status === "string" ? body.status : "idle";
    if (!live) {
      w.cursor = cursor;
      w.status = status === "crawling" ? "idle" : status;
      w.nextRetryAt = Number.isFinite(body.nextRetryAt) ? body.nextRetryAt : 0;
      w.lastError = typeof body.lastError === "string" ? body.lastError : null;
      w.attempts = Number.isFinite(body.attempts) ? body.attempts : 0;
      w.exhaustedAt = Number.isFinite(body.exhaustedAt) ? body.exhaustedAt : 0;
      w.pages = Number.isFinite(body.pages) ? body.pages : 0;
    } else {
      // The live crawl is further along than anything a stale file can say.
      if (cursor !== null && w.cursor !== null) w.cursor = Math.min(w.cursor, cursor);
    }
    // A window file written under a different depth policy keeps its own
    // target; only a file that never recorded one falls back to the table.
    w.target = Number.isFinite(body.target) ? body.target : targetFor(w.interval);
    // A window whose newest bar no longer reaches the present is history, not a
    // live edge: its depth and cursor are what a restart keeps, but answering
    // "what is recent" from it would paint a frozen chart.
    if (!reachesNow(w, w.candles[w.candles.length - 1]?.[0])) w.current = false;
    w.rev += 1;
    w.writtenGen = w.gen;
    w.writtenSig = live ? w.writtenSig : signature(w);
  }

  /** The bookkeeping both read paths share when the disk did not answer. */
  function failRead(w, err) {
    io.failedReads += 1;
    if (err.code !== "ENOENT") log.warn("klines window unreadable", { key: keyOf(w.symbol, w.interval), err: err.message });
    // A permission or device error says nothing about the bytes in the file.
    // Treat the window as still cold and refuse to write it: replacing history
    // we never read with an empty window would turn one bad read into data loss.
    if (TRANSIENT_READ_CODES.has(err.code)) {
      w.loaded = false;
      w.candles = null;
      return false;
    }
    // Missing or genuinely corrupt: start the window empty rather than fail the
    // request, and let the next change put a usable file back. The progress
    // fields we may have loaded from a previous read stay as they were.
    w.candles = [];
    w.loaded = true;
    w.bars = 0;
    w.rev += 1;
    w.writtenSig = null;
    return false;
  }

  /** A corrupt or unreadable window costs that window, never the store. */
  function readWindow(w) {
    const started = Date.now();
    io.reads += 1;
    try {
      const body = JSON.parse(gunzipSync(readFileSync(fileOf(w))).toString("utf8"));
      io.readMs += Date.now() - started;
      applyBody(w, body);
      return true;
    } catch (err) {
      io.readMs += Date.now() - started;
      return failRead(w, err);
    }
  }

  /** The same read with the disk and the codec off the event loop: what the
   *  serving path and the boot pass use, so a chart is never painted behind a
   *  synchronous `readFileSync` + `gunzipSync` of a few hundred kB. */
  async function readWindowAsync(w) {
    const started = Date.now();
    io.reads += 1;
    let raw;
    try {
      raw = await readFile(fileOf(w));
    } catch (err) {
      io.readMs += Date.now() - started;
      return failRead(w, err);
    }
    try {
      const body = JSON.parse((await gunzipAsync(raw)).toString("utf8"));
      io.readMs += Date.now() - started;
      applyBody(w, body, { keepExisting: true });
      return true;
    } catch (err) {
      io.readMs += Date.now() - started;
      return failRead(w, err);
    }
  }

  /** One in-flight async read per window, whatever number of callers want it. */
  function readAsyncOnce(w) {
    if (w.loaded) return Promise.resolve(true);
    if (!w.reading) w.reading = readWindowAsync(w).finally(() => { w.reading = null; });
    return w.reading;
  }

  /** The record for a window, without touching the disk: the LRU bookkeeping on
   *  its own, so an async reader can create the record it is about to fill. */
  function registerWindow(symbol, interval) {
    const key = keyOf(symbol, interval);
    let w = windows.get(key);
    if (w) return w;
    w = newWindow(symbol, interval, targetFor(interval));
    windows.set(key, w);
    while (windows.size > MAX_WINDOWS) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of windows) {
        // A crawling window is never dropped: it owns an in-flight page.
        if (v.status === "crawling") continue;
        if (v.lastTouched < oldest) { oldest = v.lastTouched; oldestKey = k; }
      }
      if (!oldestKey) break;
      // Written before the record is forgotten: the file is what a later
      // request reads back, and the record itself is only a cache of it.
      const dropped = windows.get(oldestKey);
      if (dropped.loaded) evict(dropped);
      windows.delete(oldestKey);
    }
    return w;
  }

  /** The window's candles in RAM, read back from disk when it was cold. Every
   *  mutator goes through here so a page never merges against a half-known
   *  window and then writes the missing half away. */
  function openWindow(symbol, interval) {
    const w = registerWindow(symbol, interval);
    if (!w.loaded) readWindow(w);
    touch(w);
    return w;
  }

  /** Async variant: the disk read goes off the event loop, so a stream tick
   *  never stalls Node while the OS page cache is faulting in a cold window.
   *  The in-memory record is always populated before the caller proceeds; the
   *  async read only feeds the *first* append for a (symbol, interval) pair. */
  async function openWindowAsync(symbol, interval) {
    const w = registerWindow(symbol, interval);
    if (!w.loaded) await readAsyncOnce(w);
    touch(w);
    return w;
  }

  /** Widen the range the venue answered for, and the counter that goes with it. */
  function noteVenue(w, tuples) {
    const span = pageSpan(tuples);
    if (w.venueFrom === null) { w.venueFrom = span.from; w.venueTo = span.to; }
    else {
      w.venueFrom = Math.min(w.venueFrom, span.from);
      w.venueTo = Math.max(w.venueTo, span.to);
    }
    w.venue = true;
  }

  /** Split the legacy single-file mirror into per-window files, then retire the
   *  original by renaming it — never by deleting it, so a bad migration is
   *  still recoverable by hand. Idempotent: once the file is gone there is
   *  nothing to do, and windows that already have their own file are skipped. */
  async function migrateLegacy() {
    let raw;
    try {
      raw = await readFile(legacyFrom, "utf8");
    } catch {
      return 0; // no legacy mirror, or unreadable: the per-window files are the truth
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      log.warn("legacy klines mirror is not readable, leaving it in place", { file: legacyFrom });
      return 0;
    }
    await mkdir(root, { recursive: true });
    let moved = 0;
    let failed = 0;
    const now = Date.now();
    for (const [key, v] of Object.entries(body ?? {})) {
      const [symbol, interval] = key.split("|");
      if (!symbol || !interval || !Array.isArray(v?.candles)) continue;
      const w = newWindow(symbol, interval, targetFor(interval));
      w.candles = normalizeTuples(v.candles.filter((t) => isTuple(t, interval)));
      if (!w.candles.length) continue;
      w.loaded = true;
      w.at = Number.isFinite(v.at) ? v.at : now;
      w.venue = v.venue !== false;
      // Migrate every window we can read, even an old one: its history is worth
      // keeping. What an out-of-date window loses is the right to answer "what
      // is recent".
      w.current = v.current !== false && reachesNow(w, w.candles[w.candles.length - 1][0]);
      if (w.venue) { w.venueFrom = w.candles[0][0]; w.venueTo = w.candles[w.candles.length - 1][0]; }
      w.cursor = w.candles[0][0] - 1;
      capWindow(w);
      w.status = w.bars >= w.target ? "complete" : "idle";
      const already = await readFile(fileOf(w)).then(() => true, () => false);
      if (already) { failed += 1; continue; } // never shallow a window already on disk
      const snapshot = await encodeAsync(w);
      if (!snapshot) continue;
      try {
        await writeSnapshot(fileOf(w), snapshot.buf);
        w.writtenGen = snapshot.gen;
        io.writes += 1;
        io.bytes += snapshot.buf.length;
        moved += 1;
      } catch {
        failed += 1;
      }
    }
    if (moved && !failed) {
      try {
        await rename(legacyFrom, `${legacyFrom}.migrated`);
        log.info("legacy klines mirror migrated", { windows: moved, kept: `${path.basename(legacyFrom)}.migrated` });
      } catch (err) {
        log.warn("legacy klines mirror could not be retired", { err: err.message });
      }
    } else if (moved) {
      log.warn("legacy klines mirror migration incomplete", { moved, failed, kept: path.basename(legacyFrom) });
    }
    return moved;
  }

  return {
    /** Migrate the legacy mirror if it is there, then read the per-window files.
     *  Progress is kept for every window; candle bytes only for the newest
     *  `hotWindows`, the rest being read back on demand.
     *
     *  Every step of this is awaited, never synchronous: it runs *behind* the
     *  listening port, so a request that arrives halfway through must be served
     *  while the loop is free, and a window the pass has not reached yet is simply
     *  a window that answers from the venue. A window an earlier request already
     *  opened is merged with, never replaced — see `applyBody`. */
    async load() {
      try {
        await mkdir(root, { recursive: true });
      } catch (err) {
        log.warn("klines directory unavailable", { root, err: err.message });
        return this;
      }
      await migrateLegacy();
      let names = [];
      try {
        names = await readdir(root);
      } catch (err) {
        log.warn("klines directory unreadable", { root, err: err.message });
        return this;
      }
      for (const name of names.filter((n) => n.endsWith(".json.gz") && !n.includes(".tmp"))) {
        const [symbol, interval] = name.replace(".json.gz", "").split("_");
        if (!symbol || !interval) continue;
        const key = keyOf(symbol, interval);
        // A request that got here first owns the record; the boot pass only fills
        // in the metadata it cannot already have.
        const w = windows.has(key) ? windows.get(key) : newWindow(symbol, interval, targetFor(interval));
        if (!windows.has(key)) windows.set(key, w);
        try {
          const started = Date.now();
          io.reads += 1;
          const raw = await readFile(path.join(root, name));
          const body = JSON.parse((await gunzipAsync(raw)).toString("utf8"));
          io.readMs += Date.now() - started;
          if (!body || !Array.isArray(body.candles)) throw new Error("malformed window");
          // Counted after the filter, because `bars` is what the depth conclusion
          // is drawn from: rows that are not candles may not fill a window.
          const kept = body.candles.filter((t) => isTuple(t, interval));
          const bars = kept.length;
          // Boot keeps the depth and the crawl state of every window, and the
          // bytes of none of them: the hot set is chosen below and re-read.
          w.at = Number.isFinite(body.at) ? Math.max(body.at, w.at) : w.at;
          w.venue = body.venue === true || w.venue === true;
          w.current = body.current !== false;
          w.bars = Math.max(bars, w.loaded ? w.bars : 0);
          w.venueFrom = Number.isFinite(body.venueFrom) ? body.venueFrom : w.venueFrom;
          w.venueTo = Number.isFinite(body.venueTo) ? body.venueTo : w.venueTo;
          w.venueBars = Number.isFinite(body.venueBars) ? body.venueBars : (w.venue ? w.bars : 0);
          w.cursor = Number.isFinite(body.cursor)
            ? (w.cursor === null ? body.cursor : Math.min(w.cursor, body.cursor)) : w.cursor;
          if (!w.loaded) {
            const status = typeof body.status === "string" ? body.status : "idle";
            w.status = status === "crawling" ? "idle" : status;
            w.nextRetryAt = Number.isFinite(body.nextRetryAt) ? body.nextRetryAt : 0;
            w.lastError = typeof body.lastError === "string" ? body.lastError : null;
            w.pages = Number.isFinite(body.pages) ? body.pages : 0;
            w.attempts = Number.isFinite(body.attempts) ? body.attempts : 0;
            w.exhaustedAt = Number.isFinite(body.exhaustedAt) ? body.exhaustedAt : 0;
          } else {
            w.pages = Number.isFinite(body.pages) ? Math.max(body.pages, w.pages) : w.pages;
          }
          w.target = Number.isFinite(body.target) ? body.target : targetFor(interval);
          // A window whose newest bar no longer reaches the present is history,
          // not a live edge: its depth, cursor and status are exactly what a
          // restart should keep, but answering "what is recent" from it would
          // paint a frozen chart.
          if (!reachesNow(w, kept[kept.length - 1]?.[0])) w.current = false;
          w.rev += 1;
        } catch (err) {
          io.failedReads += 1;
          if (!w.loaded) windows.delete(key);
          log.warn("klines window skipped", { file: name, err: err.message });
        }
      }
      // Touch order by how recently the window changed, so the LRU's first
      // victims are the stale ones. Bytes only for the newest `cap`; the rest
      // stay complete on disk and are read back the moment someone asks.
      const byAge = [...windows.values()].sort((a, b) => a.at - b.at);
      for (const w of byAge) w.lastTouched = ++seq;
      for (const w of byAge.slice(-cap)) {
        if (!w.loaded) await readAsyncOnce(w);
      }
      makeRoom();
      if (windows.size) log.info("klines windows restored", { windows: windows.size, hot: this.hotCount(), root: path.basename(root) });
      return this;
    },

    /** The most recent window the venue served, folded into whatever depth the
     *  crawl already collected. Merged rather than replaced: a refresh page of
     *  1000 candles would otherwise throw the backfill away on every read, and
     *  the mirror could never get deeper than one page. Newest bars win on
     *  overlap, and the window becomes the live edge. */
    remember(symbol, interval, data) {
      if (!Array.isArray(data) || data.length === 0) return;
      const w = openWindow(symbol, interval);
      if (!w.loaded) return; // disk refused this window: merging would shallow it
      const { tuples, rejected } = tuplesFromPage(data, interval);
      if (rejected) log.warn("klines page rows rejected", { symbol, interval, rejected, of: data.length });
      if (tuples.length === 0) return;
      const incoming = normalizeTuples(tuples);
      noteVenue(w, incoming);
      w.candles = mergeTuples(w.candles ?? [], incoming);
      w.at = Date.now();
      capWindow(w);
      // The live edge is earned by the bars themselves, not by the fact that a
      // venue page just arrived: a page whose newest candle is days old — which is
      // what a window looks like when the venue serves history while the stream is
      // down — must not be painted as the present.
      w.current = reachesNow(w, w.candles[w.candles.length - 1]?.[0]);
      if (w.cursor === null || (w.candles[0]?.[0] ?? 0) - 1 < w.cursor) w.cursor = (w.candles[0]?.[0] ?? 0) - 1;
      queuePersist(w);
    },

    /** Fold a page of *older* candles in, so scroll-back is answered from the
     *  mirror instead of re-fetching a page the terminal already had.
     *
     *  The deepening path, and it deliberately does not claim the live edge: bars
     *  that end months ago are history, not the present, and a "what is recent"
     *  read must not quietly return stale ones. It does restore the claim when a
     *  merged page really does reach now, which is what a healed tail looks like.
     *
     *  Returns how many slots were actually new to the window, so the caller can
     *  tell a page that filled a hole from one that only re-served bars already
     *  held — the difference between progress and a range worth retrying. */
    rememberOlder(symbol, interval, data) {
      if (!Array.isArray(data) || data.length === 0) return 0;
      const w = openWindow(symbol, interval);
      if (!w.loaded) return 0;
      const { tuples, rejected } = tuplesFromPage(data, interval);
      if (rejected) log.warn("klines page rows rejected", { symbol, interval, rejected, of: data.length });
      if (tuples.length === 0) return 0;
      const incoming = normalizeTuples(tuples);
      const held = w.candles ?? [];
      // Measured before the depth cap: bars that push the oldest out of a full
      // window still arrived, and a heal has to be able to tell that from the
      // venue serving a range the window already had.
      const merged = mergeTuples(held, incoming);
      const added = Math.max(0, merged.length - held.length);
      noteVenue(w, incoming);
      w.candles = merged;
      w.at = Date.now();
      capWindow(w);
      w.cursor = (w.candles[0]?.[0] ?? 0) - 1;
      if (reachesNow(w, w.candles[w.candles.length - 1]?.[0])) w.current = true;
      queuePersist(w);
      return added;
    },

    /** Fold one streamed candle into its window.
     *
     *  The venue's REST history is not always reachable (its CDN refuses some
     *  networks), while the websocket keeps delivering candles. A stream tick is
     *  a live candle, not fetched history, so it never extends `venueBars` — the
     *  difference between "the chart is current" and "we have history" has to
     *  survive the tail arriving.
     *
     *  Async: the first append for a cold window reads the mirror file off the
     *  event loop instead of stalling the bus callback that feeds this method.
     */
    async append(symbol, interval, k) {
      const tuple = toValidTuple(k, interval);
      if (!tuple) return false;
      const openTime = tuple[0];
      const w = await openWindowAsync(symbol, interval);
      if (!w.loaded) return false;
      const candles = w.candles ?? [];
      const last = candles[candles.length - 1];
      const grew = !last || last[0] < openTime;
      if (grew) candles.push(tuple);
      // The common case on a stream: the forming bar is already the newest one,
      // so it is rewritten in place without scanning the window.
      else if (last[0] === openTime) candles[candles.length - 1] = tuple;
      else {
        const at = candles.findIndex((c) => c[0] === openTime);
        if (at === -1) candles.splice(candles.findIndex((c) => c[0] > openTime), 0, tuple);
        else candles[at] = tuple;
      }
      w.candles = candles;
      w.at = Date.now();
      // A stream tick only makes the window the live edge if the bar it carries
      // actually covers the present. A replayed or backfilled tick landing days
      // behind must not relabel a history window as current.
      w.current = reachesNow(w, candles[candles.length - 1]?.[0]);
      const before = w.bars;
      capWindow(w);
      // A tick that only rewrites the forming candle changes nothing on disk
      // worth a rewrite: the debounce coalesces, and the count stays the same.
      if (w.bars !== before || grew) queuePersist(w);
      else queuePersist(w, STATE_DEBOUNCE_MS);
      return grew;
    },

    /** Progress without touching the bytes: how deep we are, how much of it is
     *  real exchange history, and where/why the crawl stopped. `bars` is what we
     *  hold, `venueBars` what the venue actually served, `status` what history
     *  says — three different questions, and a client has to be able to tell
     *  a short window from an ended one.
     *
     *  `gap` is only read for a window whose bytes are already in RAM: it is the
     *  question "is what we hold unbroken", and a request path must never pay a
     *  disk read to answer it. `null` therefore means either "unbroken" or "not
     *  looked" — `loaded` tells the two apart, and a caller that may go to disk
     *  (the crawl) calls `warm()` first and re-reads the progress after it. */
    progress(symbol, interval) {
      const w = windows.get(keyOf(symbol, interval));
      if (!w) {
        return { target: targetFor(interval), bars: 0, venueBars: 0, status: "idle",
          cursor: null, nextRetryAt: 0, lastError: null, attempts: 0, exhaustedAt: 0,
          pages: 0, venue: false, current: false, loaded: false, gap: null,
          file: fileName(symbol, interval) };
      }
      const scan = scanMeta(w);
      return { target: w.target, bars: w.bars, venueBars: w.venueBars, status: w.status,
        cursor: w.cursor, nextRetryAt: w.nextRetryAt, lastError: w.lastError,
        attempts: w.attempts, exhaustedAt: w.exhaustedAt, pages: w.pages,
        venue: w.venue, current: w.current, loaded: w.loaded,
        gap: scan.gap,
        missing: scan.missing,
        venueFrom: w.venueFrom, venueTo: w.venueTo, file: fileName(w.symbol, w.interval) };
    },

    /** Record crawl progress. Merged, so a step can move the cursor without
     *  restating the whole state, and written soon: after a restart this is what
     *  says where to continue. */
    markProgress(symbol, interval, patch) {
      const w = openWindow(symbol, interval);
      Object.assign(w, patch);
      w.at = Date.now();
      queuePersist(w, STATE_DEBOUNCE_MS);
      return this.progress(symbol, interval);
    },

    /** True when that window came from a real venue page, not just the stream. */
    venueBacked(symbol, interval) {
      return windows.get(keyOf(symbol, interval))?.venue === true;
    },

    /** True when the candle bytes are in RAM. */
    isLoaded(symbol, interval) {
      return windows.get(keyOf(symbol, interval))?.loaded === true;
    },

    /** Read one window's bytes now, asynchronously, so a request path never pays
     *  disk time while a client waits. Cheap for a window already hot, shared
     *  between callers wanting the same one, and safe against a merge that lands
     *  mid-read: what the file holds is joined under what the window holds. */
    async warm(symbol, interval) {
      const w = registerWindow(symbol, interval);
      if (w.loaded) { touch(w); return true; }
      const ok = await readAsyncOnce(w);
      if (ok) touch(w);
      return w.loaded;
    },

    /** Same question, without the read: is this window's data on demand? */
    isWarming(symbol, interval) {
      const w = windows.get(keyOf(symbol, interval));
      return !!w && !!w.reading;
    },

    /** The newest `limit` candles of that window, or null when we never had one.
     *  Windowed by count rather than stored per count, so any client limit can
     *  be served from the one window on record.
     *
     *  Null for a window that is only history: a page of old bars is not a
     *  stand-in for the live edge, and answering "what is recent" with it would
     *  show a chart that looks frozen but is claimed to be current. */
    candles(symbol, interval, limit) {
      const w = windows.get(keyOf(symbol, interval));
      if (!w || !w.current) return null;
      if (!ensureBytes(w)) return null;
      return toCandles(w.candles.slice(-Math.max(1, limit)), interval);
    },

    /** The newest `limit` candles at or before `endTime` (ms) — the shape an
     *  older/backfill page asks for. `current` does not apply here: history is
     *  exactly what this query wants, and a page already held must not be
     *  refetched. Same filter the venue applies: a bar whose own openTime is at
     *  or before `endTime`. */
    candlesBefore(symbol, interval, endTime, limit) {
      const w = windows.get(keyOf(symbol, interval));
      if (!w) return null;
      if (!ensureBytes(w)) return null;
      const list = w.candles;
      let end = list.length;
      while (end > 0 && list[end - 1][0] > endTime) end -= 1;
      if (end === 0) return [];
      const from = Math.max(0, end - Math.max(1, limit));
      return toCandles(list.slice(from, end), interval);
    },

    /** Oldest candle held for that window, or null. The crawl measures its next
     *  page from here, so it can neither repeat nor skip a boundary bar. */
    oldest(symbol, interval) {
      const w = windows.get(keyOf(symbol, interval));
      if (!w) return null;
      if (w.loaded && w.candles.length) return w.candles[0][0];
      return w.cursor !== null ? w.cursor + 1 : null;
    },

    /** Windows currently held (boot log and metrics). */
    size() { return windows.size; },
    /** Windows holding candle bytes in RAM right now. */
    hotCount() { return hotCount(); },
    metrics() {
      let bars = 0, venueBars = 0;
      const status = { idle: 0, crawling: 0, waiting: 0, complete: 0, exhausted: 0 };
      for (const w of windows.values()) {
        bars += w.bars;
        venueBars += w.venueBars;
        if (status[w.status] !== undefined) status[w.status] += 1;
      }
      return { ...io, windows: windows.size, hot: hotCount(), hotCap: cap, bars, venueBars, status };
    },

    /** Force every debounced write out (shutdown and tests). */
    async flush() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await Promise.all([...windows.values()]
        .filter((w) => w.loaded && w.candles)
        .map((w) => persistNow(w) ?? Promise.resolve()));
    },
  };
}
