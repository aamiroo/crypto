import { getPriceDecimals, getQtyDecimals } from "./symbol";

/** Format price with proper decimals. */
export function fmtPrice(price: string | number, symbol?: string): string {
  const n = typeof price === "string" ? parseFloat(price) : price;
  if (isNaN(n)) return "—";
  const d = getPriceDecimals(symbol);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Format quantity */
export function fmtQty(qty: string | number, symbol?: string): string {
  const n = typeof qty === "string" ? parseFloat(qty) : qty;
  if (isNaN(n)) return "—";
  const d = getQtyDecimals(symbol);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Format volume: auto-scale K/M/B */
export function fmtVolume(vol: string | number): string {
  const n = typeof vol === "string" ? parseFloat(vol) : vol;
  if (isNaN(n) || n === 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
}

/** Format percent change */
export function fmtPct(pct: string | number): string {
  const n = typeof pct === "string" ? parseFloat(pct) : pct;
  if (isNaN(n)) return "0.00%";
  // Bybit sends as decimal fraction (e.g., 0.05 = 5%)
  const pctVal = Math.abs(n) < 1 ? n * 100 : n;
  return (pctVal >= 0 ? "+" : "") + pctVal.toFixed(2) + "%";
}

/** Format change value with + prefix */
export function fmtChange(change: string | number): string {
  const n = typeof change === "string" ? parseFloat(change) : change;
  if (isNaN(n)) return "0.00";
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

/** Get base asset from symbol */
export { baseAsset } from "./symbol";

/** Format time HH:MM:SS */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

/** Format timestamp to short date */
export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Flash color for price change direction */
export function priceFlashClass(prev: number, next: number): string {
  if (next > prev) return "flash-green";
  if (next < prev) return "flash-red";
  return "";
}
