/**
 * Symbol normalization for Bybit.
 * Internal format: BTCUSDT (no separator).
 * Display format: BTC/USDT.
 */

import type { InstrumentInfo, SymbolPrecision } from "@/lib/types";

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

// ── Price precision per instrument ────────────────────────────────────
// Filled from the gateway's instrument metadata (Bybit tick size / lot size),
// which is the only source that is both complete and correct — a hand-kept map
// drifts and mis-formats prices (BTC ticks at 0.1, not the 0.01 this file used
// to claim).
const registry = new Map<string, SymbolPrecision>();
const DEFAULT_PRECISION: SymbolPrecision = { priceDecimals: 4, qtyDecimals: 2 };

/** Replaces the whole map from the gateway's `symbols` envelope. Called on
 *  every instrument refresh, so a delisted pair stops being formatted here. */
export function setInstruments(instruments: InstrumentInfo[]) {
  registry.clear();
  for (const i of instruments) {
    registry.set(normalizeSymbol(i.symbol), { priceDecimals: i.priceDecimals, qtyDecimals: i.qtyDecimals });
  }
}

/** Unknown symbols (a stale watchlist entry, SSR before the envelope lands)
 *  fall back to DEFAULT_PRECISION rather than showing raw venue strings. */
export function precisionFor(symbol?: string): SymbolPrecision {
  if (!symbol) return DEFAULT_PRECISION;
  return registry.get(normalizeSymbol(symbol)) ?? DEFAULT_PRECISION;
}

export function getPriceDecimals(symbol?: string): number {
  return precisionFor(symbol).priceDecimals;
}

export function getQtyDecimals(symbol?: string): number {
  return precisionFor(symbol).qtyDecimals;
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
