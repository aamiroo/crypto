import { createGateway } from "./gateway/server.js";
import { createKlinesStore } from "./gateway/klinesStore.js";
import { Instruments } from "./instruments.js";
import { BybitCollector } from "./collector/bybit.js";
import { startTickerSeed } from "./collector/tickers.js";

// ── Logger ──────────────────────────────────────────────────────────
function makeLogger() {
  const fmt = (level, msg, extra = {}) =>
    JSON.stringify({ level, msg, ...extra });
  return {
    info:  (msg, ...args) => console.log(fmt("info",  msg, argsToObj(args))),
    warn:  (msg, ...args) => console.log(fmt("warn",  msg, argsToObj(args))),
    error: (msg, ...args) => console.error(fmt("error", msg, argsToObj(args))),
  };
}
/** `fmt` spreads this into the JSON line, so loose `key, value` pairs must be
 *  zipped first — a raw array would serialise under numeric keys. A lone object is
 *  passed through as-is, and an odd trailing arg is dropped by JSON.stringify. */
function argsToObj(args) {
  if (args.length === 0) return {};
  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) return args[0];
  const obj = {};
  for (let i = 0; i < args.length; i += 2) obj[String(args[i])] = args[i + 1];
  return obj;
}
const log = makeLogger();

const port = parseInt(process.env.PORT || "8080", 10);
const quote = process.env.QUOTE || "USDT";
const restrictTo = process.env.SYMBOLS
  ? process.env.SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean)
  : null;

// Symbols come from the exchange, never from a hand-maintained list: the
// gateway needs instrument metadata (tick size) too, and half of any static
// list is delisted within a few months.
//
// `INSTRUMENTS_CACHE` and `KLINE_DIR` exist so a caller (a test, a second
// instance, a read-only deploy) can point the two on-disk stores somewhere else
// without touching the code's default layout.
const instruments = new Instruments({
  logger: log,
  quote,
  cacheFile: process.env.INSTRUMENTS_CACHE || undefined,
});
const collector = new BybitCollector(log);
// The last candle windows the venue served, so a REST outage or a restart does
// not leave the terminal without history. Created empty and hydrated behind the
// listening port below: reading it is disk work, and disk work must not be what
// keeps a socket from accepting.
const klineDir = process.env.KLINE_DIR || undefined;
// A relocated mirror migrates from the legacy file *beside it*, so pointing the
// mirror somewhere else never makes the default data dir a write target.
const klineLegacy = klineDir ? `${klineDir}/klines-cache.json` : undefined;
const klines = createKlinesStore({ logger: log, dir: klineDir, legacyFile: klineLegacy });
const { server, klineCrawler } = createGateway(instruments, ["bybit"], log, collector, klines);

// Bybit's spot ticker stream only pushes for pairs that trade, so seed the
// Hub's "latest" cache from REST and keep refreshing quiet pairs. The seed reads
// the symbol list per tick, so it simply sends nothing until hydration lands.
const stopTickerSeed = startTickerSeed({
  logger: log,
  getSymbols: () => instruments.symbols,
  intervalMs: Number(process.env.TICKER_SEED_MS || 20000),
});

// ── listen first ──────────────────────────────────────────────────────────
// Nothing the browser needs may sit behind a venue round trip: an unreachable
// exchange used to hold the port closed for the whole 10 s instrument timeout,
// which reads as "Connecting…" forever because a refused socket is what makes
// the client back off. So the port opens with whatever is on disk (and an empty
// registry is honestly reported as `source: "empty"` on `/healthz`), and both
// hydrations run after it.
server.listen(port, () => {
  log.info("gateway listening", { port, path: "/ws", klineWindows: klines.size(), instruments: instruments.symbols.length });
});

/** Background boot: registry and kline mirror, each in its own time. Orderly
 *  failure — a venue that answers in an hour still leaves the disk mirror
 *  serving, and `/api/klines` never waits on either pass. */
void (async () => {
  const mirror = klines.load().catch((err) => log.error("kline mirror hydration failed", { err: err.message }));
  const inst = await instruments.hydrate({ restrictTo });
  log.info("instruments hydrated", { symbolCount: inst.symbols.length, source: inst.source, port });
  // The collector needs the list, so it starts with it. Orderbook/trades/kline
  // streams stay closed until a client selects a symbol anyway.
  void collector.run(inst.symbols);
  // A restricted operator list is the policy; a live refresh would wipe it.
  if (!restrictTo) inst.startAutoRefresh();
  await mirror;
  log.info("kline mirror hydrated", { windows: klines.size(), hot: klines.hotCount() });
})().catch((err) => log.error("background boot failed", { err: err.message }));

/** Order matters: stop producing (ticker seed, collector sockets) before the
 *  gateway closes, otherwise a bus event would hit a dead client set. */
let closing = false;
async function shutdown() {
  // A second signal means the first is stuck behind a disk that will not answer:
  // the mirror stays debounced, so whatever reached disk is what survives.
  if (closing) process.exit(1);
  closing = true;
  stopTickerSeed();
  collector.close();
  // Cancels the crawl's pending pages; a page already in flight still merges,
  // because throwing away fetched history would be the worse loss.
  klineCrawler.stop();
  server.close();
  // Window writes are debounced, and the crawl cursor is what a restart resumes
  // from — exiting before they land would lose both. Bounded, so a wedged disk
  // cannot turn a SIGTERM into a hung process.
  try {
    await Promise.race([klines.flush(), new Promise((r) => setTimeout(r, 2000))]);
  } catch (err) {
    log.warn("klines flush failed on shutdown", { err: err.message });
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
