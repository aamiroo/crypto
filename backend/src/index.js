import { createGateway } from "./gateway/server.js";
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

// Symbols come from the exchange, never from a hand-maintained list: the
// gateway needs instrument metadata (tick size) too, and half of any static
// list is delisted within a few months.
const instruments = new Instruments({ logger: log, quote });
await instruments.bootstrap();

if (process.env.SYMBOLS) {
  instruments.restrict(process.env.SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean));
}
const symbols = instruments.symbols;
log.info("starting", { symbolCount: symbols.length, source: instruments.source, port });

const collector = new BybitCollector(log);
const { server } = createGateway(instruments, ["bybit"], log, collector);

// Bybit's spot ticker stream only pushes for pairs that trade, so seed the
// Hub's "latest" cache from REST and keep refreshing quiet pairs.
const stopTickerSeed = startTickerSeed({
  logger: log,
  getSymbols: () => instruments.symbols,
  intervalMs: Number(process.env.TICKER_SEED_MS || 20000),
});

void collector.run(symbols);

server.listen(port, () => {
  log.info("gateway listening", { port, path: "/ws" });
});

/** Order matters: stop producing (ticker seed, collector sockets) before the
 *  gateway closes, otherwise a bus event would hit a dead client set. */
function shutdown() {
  stopTickerSeed();
  collector.close();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
