import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeIndicators, sanitizeDrawings, sanitizeSettings } from "../frontend/lib/store/chartStore.ts";
import { loadPersisted } from "../frontend/lib/store/persist.ts";
import { COLORS } from "../frontend/lib/utils/drawings.ts";

function trendline(symbol = "BTCUSDT", id = "d1") {
  return { id, type: "trendline", symbol, points: [{ time: 1, price: 2 }, { time: 3, price: 4 }], color: "#fff" };
}

test("sanitizeIndicators: a wrong-shaped cache falls back to the defaults", () => {
  for (const bad of [{ BTCUSDT: ["rsi"] }, "rsi", 42, null, { 0: {} }]) {
    const out = sanitizeIndicators(bad);
    assert.ok(Array.isArray(out));
    assert.deepEqual(out.map((i) => i.id), ["sma20", "ema50"]);
  }
});

test("sanitizeIndicators: keeps valid entries and drops unusable ones", () => {
  const out = sanitizeIndicators([
    { id: "rsi14", type: "rsi", period: 14, visible: true },
    null,
    "rsi",
    { id: "", type: "rsi" },
    { id: "x", type: "nope" },
    { id: "rsi14", type: "ema" },
  ]);
  assert.deepEqual(out.map((i) => i.id), ["rsi14"]);
});

test("sanitizeIndicators: repairs missing period and visible", () => {
  const [ema] = sanitizeIndicators([{ id: "e", type: "ema" }]);
  const [rsi] = sanitizeIndicators([{ id: "r", type: "rsi", period: -3 }]);
  const [bb] = sanitizeIndicators([{ id: "b", type: "bb", period: "20" }]);
  assert.equal(ema?.period, 50);
  assert.equal(rsi?.period, 14);
  assert.equal(bb?.period, 20);
  assert.equal(ema?.visible, true);
  const [hidden] = sanitizeIndicators([{ id: "h", type: "sma", visible: false }]);
  assert.equal(hidden?.visible, false);
});

test("sanitizeDrawings: never returns a shape the renderer cannot anchor", () => {
  assert.deepEqual(sanitizeDrawings([trendline()]), {});
  assert.deepEqual(sanitizeDrawings("x"), {});
  assert.deepEqual(sanitizeDrawings({ BTCUSDT: "nope" }), {});

  const out = sanitizeDrawings({
    BTCUSDT: [
      trendline(),
      trendline("BTCUSDT", "d2"),
      { ...trendline(), id: "ghost", symbol: "ETHUSDT" },
      { ...trendline(), id: "nopoints", points: [] },
      { ...trendline(), id: "badpoints", points: [{ time: "1", price: null }] },
      { ...trendline(), id: "badtype", type: "heikinashi" },
      { ...trendline(), id: "nocolor", color: undefined },
    ],
    numberkey: 7,
  });
  assert.deepEqual(Object.keys(out), ["BTCUSDT"]);
  assert.deepEqual(out.BTCUSDT.map((d) => d.id), ["d1", "d2", "nocolor"]);
  assert.equal(out.BTCUSDT[2]?.color, COLORS.trendline);
});

test("sanitizeDrawings: copies points so stored objects stay detached", () => {
  const stored = trendline();
  const out = sanitizeDrawings({ BTCUSDT: [stored] });
  assert.notEqual(out.BTCUSDT[0]?.points, stored.points);
  assert.deepEqual(out.BTCUSDT[0]?.points[0], { time: 1, price: 2 });
});

test("sanitizeSettings: only known fields override the defaults", () => {
  assert.deepEqual(sanitizeSettings([]), sanitizeSettings(null));
  const out = sanitizeSettings({ showVolume: false, chartType: "area", magnetMode: true, watchlistWidth: "wide" });
  assert.equal(out.showVolume, false);
  assert.equal(out.chartType, "area");
  assert.equal(out.showGrid, true);
  assert.equal("magnetMode" in out, false);

  const junkType = sanitizeSettings({ chartType: "heikinashi", showGrid: "yes" });
  assert.equal(junkType.chartType, "candlestick");
  assert.equal(junkType.showGrid, true);
});

test("loadPersisted: drops a value that fails its guard instead of loading it", () => {
  const store = new Map<string, string>([["k", JSON.stringify({ BTCUSDT: ["rsi"] })]]);
  withLocalStorage({
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }, () => {
    const out = loadPersisted<string[]>("k", ["fallback"], (v): v is string[] => Array.isArray(v));
    assert.deepEqual(out, ["fallback"]);
    assert.equal(store.has("k"), false);
  });
});

test("loadPersisted: unparsable JSON falls back without throwing", () => {
  withLocalStorage({ getItem: () => "{oops", setItem: () => {}, removeItem: () => {} }, () => {
    assert.deepEqual(loadPersisted<number[]>("k", [1]), [1]);
  });
});

/** The stores read `localStorage` unqualified, which works in browsers because
 *  `window === globalThis`; Node needs both halves stubbed to hit that path. */
function withLocalStorage(stub: Record<string, (k: string, v?: string) => unknown>, run: () => void): void {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevStorage = g.localStorage;
  g.localStorage = stub;
  g.window = { localStorage: stub };
  try {
    run();
  } finally {
    g.window = prevWindow;
    g.localStorage = prevStorage;
  }
}
