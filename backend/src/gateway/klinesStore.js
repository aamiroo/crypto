import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { intervalMs } from "../intervals.js";

/**
 * The most recent window of candles the venue actually served, per
 * (symbol, interval): in memory, mirrored to disk.
 *
 * Historical candles never change and the live tail arrives over the websocket,
 * so a window the venue served five minutes ago — or before the last restart —
 * is still a correct chart. Serving it turns "history unavailable" into
 * something the terminal can show instead of an empty canvas.
 */

const DEFAULT_FILE = path.join(import.meta.dirname, "..", "..", "data", "klines-cache.json");
/** Windows an operator actually browses; each is a few thousand compact tuples. */
const MAX_WINDOWS = 48;
/** Older than this the mirror is not worth painting: the gap to "now" would be
 *  wider than the websocket can replay. */
const MAX_AGE_MS = 3 * 3600e3;
const PERSIST_DEBOUNCE_MS = 1500;

/** Candles are stored as tuples to keep the on-disk mirror small. */
function toTuple(k) {
  return [k.openTime, k.open, k.high, k.low, k.close, k.volume];
}

function isTuple(v) {
  return Array.isArray(v) && v.length === 6 && Number.isFinite(v[0]) && typeof v[1] === "string";
}

export function createKlinesStore({ file = DEFAULT_FILE, logger } = {}) {
  const log = logger || { info() {}, warn() {}, error() {} };
  const windows = new Map(); // key -> { at, candles }
  let writeTimer = null;
  let dirty = false;

  async function persist() {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const out = {};
      for (const [key, v] of windows) out[key] = { at: v.at, candles: v.candles };
      await writeFile(file, JSON.stringify(out));
    } catch (err) {
      log.warn("klines cache write failed", { err: err.message });
    }
  }

  /** Writes are debounced: a page scroll records several windows in a row and
   *  each one would otherwise rewrite the whole mirror. */
  function queuePersist() {
    dirty = true;
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      dirty = false;
      void persist();
    }, PERSIST_DEBOUNCE_MS);
    writeTimer.unref?.();
  }

  return {
    /** Read the on-disk mirror into memory. Anything unusable or too old is
     *  skipped, so a corrupt file costs the fallback, never the boot. */
    async load() {
      try {
        const raw = JSON.parse(await readFile(file, "utf8"));
        const now = Date.now();
        for (const [key, v] of Object.entries(raw ?? {})) {
          if (!v || !Array.isArray(v.candles) || !Number.isFinite(v.at)) continue;
          if (now - v.at > MAX_AGE_MS) continue;
          if (!v.candles.every(isTuple)) continue;
          windows.set(key, { at: v.at, candles: v.candles });
        }
        if (windows.size) log.info("klines cache restored", { windows: windows.size });
      } catch { /* first run: no mirror yet */ }
      return this;
    },

    /** The most recent window the venue served for this pair. Only the newest
     *  window is kept — an older backfill page is not a fallback for "now". */
    remember(symbol, interval, data) {
      if (!Array.isArray(data) || data.length === 0) return;
      windows.set(`${symbol}|${interval}`, { at: Date.now(), candles: data.map(toTuple) });
      while (windows.size > MAX_WINDOWS) windows.delete(windows.keys().next().value);
      queuePersist();
    },

    /** The newest `limit` candles of that window, or null when we never had one.
     *  Windowed by count rather than stored per count, so any client limit can
     *  be served from the one window on record. */
    candles(symbol, interval, limit) {
      const hit = windows.get(`${symbol}|${interval}`);
      if (!hit) return null;
      const ms = intervalMs(interval);
      const now = Date.now();
      return hit.candles.slice(-Math.max(1, limit)).map((t) => ({
        interval,
        openTime: t[0],
        closeTime: t[0] + ms - 1,
        open: t[1],
        high: t[2],
        low: t[3],
        close: t[4],
        volume: t[5],
        // Derived, never stored: a cached bar must not claim to be closed.
        closed: t[0] + ms <= now,
      }));
    },

    /** Windows currently held (boot log). */
    size() { return windows.size; },

    /** Force the debounced write out (shutdown and tests). */
    async flush() {
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
      dirty = false;
      await persist();
    },
  };
}
