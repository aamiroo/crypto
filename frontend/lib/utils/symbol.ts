/**
 * Symbol normalization for Bybit.
 * Internal format: BTCUSDT (no separator).
 * Display format: BTC/USDT.
 */

/** Strip slash → "BTC/USDT" → "BTCUSDT" */
export function normalizeSymbol(input: string): string {
  return input.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

/** Internal → display: "BTCUSDT" → "BTC/USDT" */
export function toDisplaySymbol(internal: string): string {
  const s = normalizeSymbol(internal);
  if (s.endsWith("USDT")) return s.slice(0, -4) + "/USDT";
  return s;
}

/** Display → internal: "BTC/USDT" → "BTCUSDT" */
export function toInternalSymbol(display: string): string {
  return normalizeSymbol(display);
}

/** Extract base asset: "BTCUSDT" → "BTC" */
export function baseAsset(symbol: string): string {
  const s = normalizeSymbol(symbol);
  if (s.endsWith("USDT")) return s.slice(0, -4);
  return s;
}

/** Extract quote asset (always USDT for spot). */
export function quoteAsset(_symbol: string): string {
  return "USDT";
}

// ── Price precision per asset ───────────────────────────────────────────
// Bybit spot has specific tick sizes per symbol.
const PRECISION_MAP: Record<string, [priceDec: number, qtyDec: number]> = {
  BTC: [2, 5],
  ETH: [2, 4],
  BNB: [2, 3],
  SOL: [2, 2],
  XRP: [5, 1],
  DOGE: [6, 0],
  SHIB: [8, 0],
  PEPE: [8, 0],
  ADA: [5, 1],
  AVAX: [3, 2],
  DOT: [4, 2],
  LINK: [3, 2],
  MATIC: [5, 1],
  UNI: [3, 2],
  LTC: [3, 3],
  FIL: [3, 2],
  NEAR: [4, 1],
  APT: [3, 2],
  ARB: [5, 1],
  OP: [4, 1],
  TRX: [6, 0],
  ATOM: [4, 2],
  ICP: [3, 2],
  FET: [5, 1],
  SEI: [5, 1],
  WLD: [4, 1],
  TON: [4, 2],
  BONK: [8, 0],
  PEPE2: [8, 0],
};

const DEFAULT_PRECISION: [number, number] = [4, 2];

export function getPriceDecimals(symbol?: string): number {
  if (!symbol) return DEFAULT_PRECISION[0];
  const base = baseAsset(symbol);
  return (PRECISION_MAP[base] ?? DEFAULT_PRECISION)[0];
}

export function getQtyDecimals(symbol?: string): number {
  if (!symbol) return DEFAULT_PRECISION[1];
  const base = baseAsset(symbol);
  return (PRECISION_MAP[base] ?? DEFAULT_PRECISION)[1];
}

/** Format price with exchange-aware decimals. */
export function formatPrice(value: number | string, symbol?: string): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return "—";
  const d = getPriceDecimals(symbol);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Format quantity with exchange-aware decimals. */
export function formatQty(value: number | string, symbol?: string): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return "—";
  const d = getQtyDecimals(symbol);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
