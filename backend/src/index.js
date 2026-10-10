import { createGateway } from "./gateway/server.js";
import { symbols as defaultSymbols } from "./symbols.js";
import { BybitCollector } from "./collector/bybit.js";

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
function argsToObj(args) {
  if (args.length === 0) return {};
  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) return args[0];
  const obj = {};
  for (let i = 0; i < args.length; i += 2) obj[String(args[i])] = args[i + 1];
  return obj;
}
const log = makeLogger();

const symbols = process.env.SYMBOLS
  ? process.env.SYMBOLS.split(",").map((s) => s.trim().toUpperCase())
  : defaultSymbols;
const port = parseInt(process.env.PORT || "8080", 10);

log.info("starting", { symbolCount: symbols.length, port });

// Create collector first so gateway can reference it
const collector = new BybitCollector(log);

// Start gateway (hub, WS server, REST endpoints)
const { server } = createGateway(symbols, ["bybit"], log, collector);

// Start Bybit feed → publishes to bus → gateway subscribes bus → hub broadcasts to WS clients
collector.run(symbols);

server.listen(port, () => {
  log.info("gateway listening", { port, path: "/ws" });
});

process.on("SIGINT",  () => { server.close(); process.exit(0); });
process.on("SIGTERM", () => { server.close(); process.exit(0); });
