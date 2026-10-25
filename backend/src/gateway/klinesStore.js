import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import path from "node:path";
import { intervalMs } from "../intervals.js";

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
 * rest stay complete on disk and are read back synchronously the moment someone
 * asks for them — a few hundred kB, on a path that was already going to answer
 * from that data.
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
/** Older than this the mirror is not worth painting: the gap to "now" would be
 *  wider than the websocket can replay. */
const MAX_AGE_MS = 3 * 3600e3;
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

/** Candles are stored as tuples to keep the on-disk mirror small. */
function toTuple(k) {
  return [k.openTime, k.open, k.high, k.low, k.close, k.volume];
}

function isTuple(v) {
  return Array.isArray(v) && v.length === 6 && Number.isFinite(v[0]) && typeof v[1] === "string";
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
   *  rather than the window growing without bound. */
  function capWindow(w) {
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

  /** Whether a window still reaches the present, judged from its newest bar and
   *  not from when the file was written: a daily window legitimately changes once
   *  a day, and a websocket-fed one has to be dropped the moment the stream stops
   *  feeding it. Past that it is history — still worth serving as a backfill page,
   *  never as the live edge. */
  function reachesNow(w, newestOpenTime) {
    if (!Number.isFinite(newestOpenTime)) return false;
    return Date.now() - newestOpenTime <= Math.max(MAX_AGE_MS, 2 * intervalMs(w.interval));
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

  function encode(w) {
    if (!w.candles) return null;
    const started = Date.now();
    const body = {
      symbol: w.symbol, interval: w.interval, at: w.at, venue: w.venue, current: w.current,
      bars: w.bars, venueBars: w.venueBars, venueFrom: w.venueFrom, venueTo: w.venueTo,
      cursor: w.cursor, status: w.status, nextRetryAt: w.nextRetryAt,
      lastError: w.lastError, attempts: w.attempts, exhaustedAt: w.exhaustedAt,
      pages: w.pages, target: w.target,
      candles: w.candles,
    };
    const buf = gzipSync(Buffer.from(JSON.stringify(body)), { level: GZIP_LEVEL });
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

  /** A corrupt or unreadable window costs that window, never the store. */
  function readWindow(w) {
    const started = Date.now();
    io.reads += 1;
    try {
      const body = JSON.parse(gunzipSync(readFileSync(fileOf(w))).toString("utf8"));
      if (!body || !Array.isArray(body.candles)) throw new Error("malformed window");
      const candles = normalizeTuples(body.candles.filter(isTuple));
      w.candles = candles;
      w.loaded = true;
      w.bars = candles.length;
      w.at = Number.isFinite(body.at) ? body.at : w.at;
      w.venue = body.venue === true;
      // The file's own claim about the live edge is only true while its newest
      // bar still reaches the present; a window read back days later is history
      // and must not answer a "what is recent" read.
      w.current = body.current !== false && reachesNow(w, candles[candles.length - 1]?.[0]);
      w.venueFrom = Number.isFinite(body.venueFrom) ? body.venueFrom : null;
      w.venueTo = Number.isFinite(body.venueTo) ? body.venueTo : null;
      w.venueBars = Number.isFinite(body.venueBars) ? body.venueBars : (w.venue ? w.bars : 0);
      w.cursor = Number.isFinite(body.cursor) ? body.cursor : null;
      // A crawl that was mid-page when the process died is not crawling any
      // more; the cursor it left is exactly where it picks up.
      w.status = typeof body.status === "string" ? body.status : "idle";
      if (w.status === "crawling") w.status = "idle";
      w.nextRetryAt = Number.isFinite(body.nextRetryAt) ? body.nextRetryAt : 0;
      w.lastError = typeof body.lastError === "string" ? body.lastError : null;
      w.attempts = Number.isFinite(body.attempts) ? body.attempts : 0;
      w.exhaustedAt = Number.isFinite(body.exhaustedAt) ? body.exhaustedAt : 0;
      w.pages = Number.isFinite(body.pages) ? body.pages : 0;
      // A window file written under a different depth policy keeps its own
      // target; only a file that never recorded one falls back to the table.
      w.target = Number.isFinite(body.target) ? body.target : targetFor(w.interval);
      w.writtenGen = w.gen;
      w.writtenSig = signature(w);
      io.readMs += Date.now() - started;
      return true;
    } catch (err) {
      io.readMs += Date.now() - started;
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
      w.writtenSig = null;
      return false;
    }
  }

  /** The window's candles in RAM, read back from disk when it was cold. Every
   *  mutator goes through here so a page never merges against a half-known
   *  window and then writes the missing half away. */
  function openWindow(symbol, interval) {
    const key = keyOf(symbol, interval);
    let w = windows.get(key);
    if (!w) {
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
    }
    if (!w.loaded) readWindow(w);
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
      w.candles = normalizeTuples(v.candles.filter(isTuple));
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
      const snapshot = encode(w);
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
     *  `hotWindows`, the rest being read back on demand. */
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
      for (const name of names) {
        if (!name.endsWith(".json.gz") || name.includes(".tmp")) continue;
        const [symbol, interval] = name.replace(".json.gz", "").split("_");
        if (!symbol || !interval) continue;
        const w = newWindow(symbol, interval, targetFor(interval));
        windows.set(keyOf(symbol, interval), w);
        try {
          const started = Date.now();
          io.reads += 1;
          const body = JSON.parse(gunzipSync(readFileSync(path.join(root, name))).toString("utf8"));
          io.readMs += Date.now() - started;
          if (!body || !Array.isArray(body.candles)) throw new Error("malformed window");
          w.at = Number.isFinite(body.at) ? body.at : 0;
          w.venue = body.venue === true;
          w.current = body.current !== false;
          w.bars = body.candles.length;
          w.venueFrom = Number.isFinite(body.venueFrom) ? body.venueFrom : null;
          w.venueTo = Number.isFinite(body.venueTo) ? body.venueTo : null;
          w.venueBars = Number.isFinite(body.venueBars) ? body.venueBars : (w.venue ? w.bars : 0);
          w.cursor = Number.isFinite(body.cursor) ? body.cursor : null;
          w.status = typeof body.status === "string" ? body.status : "idle";
          if (w.status === "crawling") w.status = "idle";
          w.nextRetryAt = Number.isFinite(body.nextRetryAt) ? body.nextRetryAt : 0;
          w.lastError = typeof body.lastError === "string" ? body.lastError : null;
          w.pages = Number.isFinite(body.pages) ? body.pages : 0;
          w.attempts = Number.isFinite(body.attempts) ? body.attempts : 0;
          w.exhaustedAt = Number.isFinite(body.exhaustedAt) ? body.exhaustedAt : 0;
          w.target = Number.isFinite(body.target) ? body.target : targetFor(interval);
          // A window whose newest bar no longer reaches the present is history,
          // not a live edge: its depth, cursor and status are exactly what a
          // restart should keep, but answering "what is recent" from it would
          // paint a frozen chart.
          if (!reachesNow(w, body.candles[body.candles.length - 1]?.[0])) w.current = false;
        } catch (err) {
          io.failedReads += 1;
          windows.delete(keyOf(symbol, interval));
          log.warn("klines window skipped", { file: name, err: err.message });
        }
      }
      // Touch order by how recently the window changed, so the LRU's first
      // victims are the stale ones. Bytes only for the newest `cap`; the rest
      // stay complete on disk and are read back the moment someone asks.
      const byAge = [...windows.values()].sort((a, b) => a.at - b.at);
      for (const w of byAge) w.lastTouched = ++seq;
      for (const w of byAge.slice(-cap)) readWindow(w);
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
      const incoming = normalizeTuples(data.map(toTuple));
      noteVenue(w, incoming);
      w.candles = mergeTuples(w.candles ?? [], incoming);
      w.at = Date.now();
      w.current = true;
      capWindow(w);
      if (w.cursor === null || (w.candles[0]?.[0] ?? 0) - 1 < w.cursor) w.cursor = (w.candles[0]?.[0] ?? 0) - 1;
      queuePersist(w);
    },

    /** Fold a page of *older* candles in, so scroll-back is answered from the
     *  mirror instead of re-fetching a page the terminal already had.
     *
     *  The deepening path, and it deliberately does not make the window
     *  `current`: bars that end months ago are history, not the live edge, and a
     *  "what is recent" read must not quietly return stale ones. */
    rememberOlder(symbol, interval, data) {
      if (!Array.isArray(data) || data.length === 0) return;
      const w = openWindow(symbol, interval);
      if (!w.loaded) return;
      const incoming = normalizeTuples(data.map(toTuple));
      noteVenue(w, incoming);
      w.candles = mergeTuples(w.candles ?? [], incoming);
      w.at = Date.now();
      capWindow(w);
      w.cursor = (w.candles[0]?.[0] ?? 0) - 1;
      queuePersist(w);
    },

    /** Fold one streamed candle into its window.
     *
     *  The venue's REST history is not always reachable (its CDN refuses some
     *  networks), while the websocket keeps delivering candles. A stream tick is
     *  a live candle, not fetched history, so it never extends `venueBars` — the
     *  difference between "the chart is current" and "we have history" has to
     *  survive the tail arriving. */
    append(symbol, interval, k) {
      const openTime = Number(k?.openTime);
      if (!Number.isFinite(openTime) || openTime <= 0) return false;
      const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? String(v) : null);
      const ohlcv = [num(k.open), num(k.high), num(k.low), num(k.close), num(k.volume)];
      if (ohlcv.some((v) => v === null)) return false;
      const w = openWindow(symbol, interval);
      if (!w.loaded) return false;
      const candles = w.candles ?? [];
      const tuple = [openTime, ...ohlcv];
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
      w.current = true;
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
     *  a short window from an ended one. */
    progress(symbol, interval) {
      const w = windows.get(keyOf(symbol, interval));
      if (!w) {
        return { target: targetFor(interval), bars: 0, venueBars: 0, status: "idle",
          cursor: null, nextRetryAt: 0, lastError: null, attempts: 0, exhaustedAt: 0,
          pages: 0, venue: false, current: false, loaded: false, file: fileName(symbol, interval) };
      }
      return { target: w.target, bars: w.bars, venueBars: w.venueBars, status: w.status,
        cursor: w.cursor, nextRetryAt: w.nextRetryAt, lastError: w.lastError,
        attempts: w.attempts, exhaustedAt: w.exhaustedAt, pages: w.pages,
        venue: w.venue, current: w.current, loaded: w.loaded,
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

    /** Read one window's bytes now, so a request path never pays disk time while
     *  a client waits. Cheap for a window already hot. */
    async warm(symbol, interval) {
      const w = openWindow(symbol, interval);
      return w.loaded;
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
