import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fallbackInstruments } from "./symbols.js";

const BYBIT_REST = process.env.BYBIT_REST || "https://api.bybit.com";
const REFRESH_MS = 6 * 60 * 60 * 1000;
const CACHE_FILE = path.join(import.meta.dirname, "..", "data", "instruments.json");

/** Registry states that came from the venue and can therefore be *widened* by a
 *  discovery pass. `empty`, `test` and `override` cannot: the first knows
 *  nothing, the second and third are complete by construction. See `resolve`. */
const DISCOVERABLE = new Set(["live", "cache", "fallback"]);

/** Decimal places implied by an exchange step size ("0.01" -> 2, "1" -> 0). */
export function decimalsOf(step) {
  const s = String(step ?? "");
  const dot = s.indexOf(".");
  if (dot < 0) return s.length > 0 ? 0 : null;
  const frac = s.slice(dot + 1);
  if (!/^[0-9]+$/.test(frac)) return null;
  return frac.length;
}

/** Bybit spot instruments -> terminal instruments, keeping active USDT pairs only. */
export function normalizeInstruments(list, quote = "USDT") {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item?.symbol) continue;
    if (quote && item.quoteCoin !== quote) continue;
    if (item.status && item.status !== "Trading") continue;
    const priceDecimals = decimalsOf(item.priceFilter?.tickSize);
    const qtyDecimals = decimalsOf(item.lotSizeFilter?.basePrecision);
    if (priceDecimals === null || qtyDecimals === null) continue;
    out.push({
      symbol: String(item.symbol).toUpperCase(),
      baseCoin: String(item.baseCoin ?? "").toUpperCase(),
      priceDecimals,
      qtyDecimals,
    });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

/**
 * Live spot instrument list. Throws on any transport or retCode failure so the
 * registry can fall back to its disk cache and then to the bundled snapshot —
 * a partial list would silently hide tradeable pairs.
 */
export async function fetchInstruments(quote = "USDT") {
  const url = `${BYBIT_REST}/v5/market/instruments-info?category=spot&limit=1000`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; CryptoTerminal/1.0)" },
  });
  if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(j.retMsg || `Bybit error ${j.retCode}`);
  return normalizeInstruments(j.result?.list, quote);
}

/**
 * Registry of tradable instruments. Live discovery is the source of truth; a
 * disk cache keeps restarts fast and `symbols.js` is the last-resort snapshot
 * when Bybit is unreachable and no cache exists.
 */
export class Instruments {
  constructor({ logger, quote = "USDT", cacheFile = CACHE_FILE } = {}) {
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.quote = quote;
    this.cacheFile = cacheFile;
    this.items = new Map();
    this.source = "empty";
    this.updatedAt = 0;
    this.onChange = null;
    /** False only while a background hydration pass is in flight. A registry that
     *  has not had its first look at the disk yet must not be the reason a valid
     *  symbol gets rejected — see `hydrate`. */
    this.ready = true;
    /** One discovery attempt at a time, and not more often than this: a client
     *  typoing a symbol must not turn into a live fetch per request. */
    this.discovery = null;
    this.discoveryUntil = 0;
  }

  get symbols() { return [...this.items.keys()]; }

  /** The gate every inbound symbol passes, on both the WS subscribe path and
   *  `/api/klines`, before it can reach the exchange URL. Keys are uppercase, so
   *  the normalisation has to happen here — client input is not trusted to be. */
  has(symbol) { return this.items.has(String(symbol || "").toUpperCase()); }

  /** Same case normalisation as `has`; a miss is reported as null, not undefined,
   *  so the return shape stays single-typed for callers that store the result. */
  get(symbol) { return this.items.get(String(symbol || "").toUpperCase()) || null; }

  /** Insertion order of the last `replace`, which is alphabetical for live and
   *  cached lists but operator-sorted for a `SYMBOLS` override — this array is
   *  what `/api/symbols` ships verbatim. */
  list() { return [...this.items.values()]; }

  /** Whole-map swap, never a merge, so a delisted pair cannot survive a refresh.
   *  `onChange` is how the gateway learns to attach bus listeners for symbols that
   *  just appeared; it must fire after the maps are already consistent. */
  replace(items, source) {
    this.items = new Map(items.map((i) => [i.symbol, i]));
    this.source = source;
    this.updatedAt = Date.now();
    this.logger.info("instruments loaded", { count: this.items.size, source });
    this.onChange?.(this);
    return this;
  }

  /** Restrict to an operator-supplied symbol list (SYMBOLS env var). */
  restrict(symbols) {
    const keep = symbols.map((s) => String(s).toUpperCase()).filter(Boolean);
    const items = keep.map((symbol) => this.get(symbol) || {
      symbol,
      baseCoin: symbol.endsWith(this.quote) ? symbol.slice(0, -this.quote.length) : "",
      priceDecimals: 4,
      qtyDecimals: 2,
    });
    return this.replace(items, "override");
  }

  /** A cache written for another quote is rejected outright: it would validate the
   *  wrong symbols and mint the wrong precisions. False means "nothing usable on
   *  disk", which is what lets `bootstrap` fall through to the live fetch. */
  async loadCache() {
    try {
      const raw = JSON.parse(await readFile(this.cacheFile, "utf8"));
      if (raw?.quote === this.quote && Array.isArray(raw.items) && raw.items.length) {
        this.replace(raw.items, "cache");
        return true;
      }
    } catch { /* first run: no cache yet */ }
    return false;
  }

  /** Failures are logged, never thrown: a read-only or missing data dir must not
   *  undo a good live refresh, it only costs the next restart its fast path. */
  async persist() {
    try {
      await mkdir(path.dirname(this.cacheFile), { recursive: true });
      await writeFile(this.cacheFile, JSON.stringify({
        quote: this.quote, updatedAt: this.updatedAt, items: this.list(),
      }));
    } catch (err) {
      this.logger.warn("instrument cache write failed", { err: err.message });
    }
  }

  /** Compares only count and price precision, so a routine no-change poll costs
   *  neither a disk write nor an `onChange` that re-scans the bus bridge. On any
   *  failure the previously loaded list keeps serving and false is returned. */
  async refresh() {
    try {
      const items = await fetchInstruments(this.quote);
      if (items.length === 0) throw new Error("empty instruments list");
      const changed = items.length !== this.items.size
        || items.some((i) => this.get(i.symbol)?.priceDecimals !== i.priceDecimals);
      if (!changed && this.source === "live") return false;
      this.replace(items, "live");
      await this.persist();
      return true;
    } catch (err) {
      this.logger.warn("instrument refresh failed", { err: err.message });
      return false;
    }
  }

  /** Hands back the disposer. `void` is safe because `refresh` swallows its own
   *  failures, so an unreachable exchange cannot produce an unhandled rejection
   *  from a tick nobody awaits. */
  startAutoRefresh(intervalMs = REFRESH_MS) {
    const timer = setInterval(() => void this.refresh(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** True when this symbol may be served right now, without waiting on anything:
   *  either the registry knows it, or the registry has not finished its first
   *  hydration pass and therefore has no authority to refuse it. */
  usable(symbol) {
    return this.items.has(String(symbol || "").toUpperCase()) || !this.ready;
  }

  /** A structurally valid symbol the cached registry does not know is not proof
   *  of a bad client — the cache can be hours old, and a pair listed yesterday is
   *  not in it. Ask for it once (de-duplicated, cooldown-bounded, on its own
   *  request rather than the kline lane) and only refuse afterwards. A caller that
   *  cannot wait uses this as fire-and-forget: the attempt runs regardless, so the
   *  client's retry finds the symbol instead of hitting the same wall. */
  async resolve(symbol, { budgetMs = 1200, cooldownMs = 30000 } = {}) {
    const s = String(symbol || "").toUpperCase();
    if (this.items.has(s)) return true;
    // An operator's `SYMBOLS` list is the policy, not a cache to be widened, and a
    // registry that never came from the venue (a test fixture) has no wider list
    // to discover into: asking would be a pointless live call.
    if (!DISCOVERABLE.has(this.source)) return false;
    if (!this.discovery && Date.now() >= this.discoveryUntil) {
      this.discoveryUntil = Date.now() + cooldownMs;
      this.discovery = this.refresh()
        .catch((err) => { this.logger.warn("instrument discovery failed", { err: err.message }); return false; })
        .finally(() => { this.discovery = null; });
    }
    if (!this.discovery) return false;
    // Bounded: a client must not pay a whole venue round trip for a registry
    // question. The attempt keeps running behind the answer either way.
    await Promise.race([this.discovery, new Promise((r) => setTimeout(r, budgetMs))]);
    return this.items.has(s);
  }

  /** Boot ordering: disk cache (fast, accurate) → live fetch → bundled snapshot. */
  async bootstrap() {
    await this.loadCache();
    await this.refresh().catch(() => false);
    if (this.items.size === 0) this.replace(fallbackInstruments, "fallback");
    return this;
  }

  /** The same ordering as `bootstrap`, but built to run *behind* a listening
   *  port: the disk cache answers `/api/symbols` and validates symbols as soon as
   *  it has been read (a few ms, async), the live list follows whenever the venue
   *  gets round to answering. `ready` is what the gateway reads to decide that a
   *  mid-pass registry may not reject a well-formed symbol. */
  async hydrate({ restrictTo = null } = {}) {
    this.ready = false;
    try {
      await this.loadCache();
      if (restrictTo?.length) this.restrict(restrictTo);
      await this.refresh();
      if (this.items.size === 0) this.replace(fallbackInstruments, "fallback");
      // A live list replaces the whole map, so the operator's restriction is
      // re-applied on top of whatever the venue just said.
      else if (restrictTo?.length) this.restrict(restrictTo);
    } catch (err) {
      this.logger.warn("instrument hydration failed", { err: err.message });
      if (this.items.size === 0) this.replace(fallbackInstruments, "fallback");
    } finally {
      this.ready = true;
      this.onHydrated?.(this);
    }
    return this;
  }
}
