/**
 * The chart paints on a canvas, which cannot resolve `var(...)`, so the theme
 * used to be duplicated as literal hex in the panel and in the stylesheet — and
 * the two copies had already drifted. This reads the CSS custom properties once
 * per theme change, so `globals.css` is the only place a colour is written.
 */

export interface ChartPalette {
  bg: string;
  text: string;
  grid: string;
  border: string;
  borderStrong: string;
  crosshair: string;
  up: string;
  down: string;
  volumeUp: string;
  volumeDown: string;
  accent: string;
  danger: string;
  /** Background of a label drawn on top of the plot (axis tags, shape labels). */
  labelBg: string;
  labelText: string;
  /** Colour of the price/time axis tags the chart draws for a selected shape. */
  selection: string;
  fontSize: number;
  fontFamily: string;
}

const FALLBACK: ChartPalette = {
  bg: "#0b0e11",
  text: "#7c828d",
  grid: "#171b21",
  border: "#1c2027",
  borderStrong: "#2a303a",
  crosshair: "#3f4550",
  up: "#10b981",
  down: "#f43f5e",
  volumeUp: "rgba(16,185,129,0.35)",
  volumeDown: "rgba(244,63,94,0.35)",
  accent: "#f59e0b",
  danger: "#f43f5e",
  labelBg: "#12161b",
  labelText: "#a6adb8",
  selection: "#f59e0b",
  fontSize: 11,
  fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
};

/** `#rgb`/`#rrggbb` -> `rgba(r,g,b,a)`; anything else is passed through so
 *  `color-mix()` or `oklch()` values still render, just without an alpha. */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex);
  if (!m) return hex;
  let body = hex.slice(1);
  if (body.length === 3 || body.length === 4) body = body.replace(/./g, (c) => c + c);
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function readVars(el: Element): ChartPalette {
  const cs = getComputedStyle(el);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const up = get("--candle-up", FALLBACK.up);
  const down = get("--candle-down", FALLBACK.down);
  return {
    bg: get("--chart-bg", FALLBACK.bg),
    text: get("--chart-text", FALLBACK.text),
    grid: get("--chart-grid", FALLBACK.grid),
    border: get("--border", FALLBACK.border),
    borderStrong: get("--border-strong", FALLBACK.borderStrong),
    crosshair: get("--chart-crosshair", FALLBACK.crosshair),
    up,
    down,
    volumeUp: withAlpha(up, 0.35),
    volumeDown: withAlpha(down, 0.35),
    accent: get("--accent", FALLBACK.accent),
    danger: get("--danger", FALLBACK.danger),
    labelBg: get("--bg-elevated", FALLBACK.labelBg),
    labelText: get("--text-secondary", FALLBACK.labelText),
    selection: get("--accent", FALLBACK.selection),
    fontSize: FALLBACK.fontSize,
    fontFamily: get("--font-ui", FALLBACK.fontFamily),
  };
}

let cache: { key: string; palette: ChartPalette } | null = null;

/**
 * Resolved from the live `:root` / `[data-theme]` element. Cheap enough to call
 * on every theme switch, and cached per theme so a re-render never pays for
 * `getComputedStyle` on the whole document.
 */
export function chartPalette(theme: string): ChartPalette {
  if (cache?.key === theme) return cache.palette;
  const el = document.documentElement;
  const palette = typeof getComputedStyle === "function" ? readVars(el) : FALLBACK;
  cache = { key: theme, palette };
  return palette;
}

export function invalidateChartPalette(): void {
  cache = null;
}
