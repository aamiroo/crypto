import type { KlineData } from "@/lib/types";

/** Simple Moving Average */
export function sma(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j]!;
    out.push(sum / period);
  }
  return out;
}

/** Exponential Moving Average */
export function ema(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (prev === null) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += closes[j]!;
      prev = sum / period;
    } else {
      prev = closes[i]! * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

/** Relative Strength Index */
export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = [];
  if (closes.length < period + 1) return closes.map(() => null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = 0; i < period; i++) out.push(null);
  out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

/** MACD (macd line, signal line, histogram) */
export function macd(closes: number[], fast = 12, slow = 26, sig = 9) {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastEma[i] == null || slowEma[i] == null) { macdLine.push(null); continue; }
    macdLine.push(fastEma[i]! - slowEma[i]!);
  }
  const validMacd = macdLine.filter((v): v is number => v !== null);
  const sigLine = ema(validMacd, sig);
  const signalLine: (number | null)[] = [];
  let vi = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null) { signalLine.push(null); continue; }
    signalLine.push(sigLine[vi] ?? null);
    vi++;
  }
  const histogram: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] == null || signalLine[i] == null) { histogram.push(null); continue; }
    histogram.push(macdLine[i]! - signalLine[i]!);
  }
  return { macdLine, signalLine, histogram };
}

/** Bollinger Bands (upper, middle, lower) */
export function bollinger(closes: number[], period = 20, stdDev = 2) {
  const middle = sma(closes, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (middle[i] == null) { upper.push(null); lower.push(null); continue; }
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j]! - middle[i]!) ** 2;
    const sd = Math.sqrt(sumSq / period);
    upper.push(middle[i]! + stdDev * sd);
    lower.push(middle[i]! - stdDev * sd);
  }
  return { upper, middle, lower };
}

/** Convert klines to close prices */
export function klineCloses(klines: KlineData[]): number[] {
  return klines.map((k) => parseFloat(k.close));
}
