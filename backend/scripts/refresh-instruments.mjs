// Regenerates backend/src/symbols.js (the offline fallback snapshot) from live
// Bybit spot instruments: `node scripts/refresh-instruments.mjs`
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchInstruments } from "../src/instruments.js";

const items = await fetchInstruments("USDT");
const out = path.resolve(import.meta.dirname, "..", "src", "symbols.js");
const rows = items
  .map((i) => `  { symbol: ${JSON.stringify(i.symbol)}, baseCoin: ${JSON.stringify(i.baseCoin)}, `
    + `priceDecimals: ${i.priceDecimals}, qtyDecimals: ${i.qtyDecimals} },`)
  .join("\n");

await writeFile(out, `// Offline fallback snapshot of Bybit spot USDT instruments (source: GET
// /v5/market/instruments-info?category=spot, captured ${new Date().toISOString().slice(0, 10)}).
// Live discovery in instruments.js is the primary source; this file is only used when
// Bybit REST is unreachable and no cache exists. Regenerate by running
//   node scripts/refresh-instruments.mjs
export const fallbackInstruments = [
${rows}
];

export const fallbackSymbols = fallbackInstruments.map((i) => i.symbol);
`);
console.log(`wrote ${items.length} instruments -> ${out}`);
