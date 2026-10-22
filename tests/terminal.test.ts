import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useAlertsStore } from "../frontend/lib/store/alertsStore.ts";
import { useWatchlistStore } from "../frontend/lib/store/watchlistStore.ts";
import { useLayoutStore, WATCHLIST_MIN, WATCHLIST_MAX } from "../frontend/lib/store/layoutStore.ts";
import { drawingForTool, drawingTypeForTool, isPlacementTool, makeDrawing, pointsRequired, positionMetrics } from "../frontend/lib/utils/drawings.ts";

beforeEach(() => {
  useAlertsStore.getState().clearAll();
  useWatchlistStore.getState().reset();
  useLayoutStore.getState().reset();
});

test("alerts: 'above' fires when price reaches the threshold", () => {
  const { addAlert, evaluate } = useAlertsStore.getState();
  addAlert({ symbol: "BTCUSDT", condition: "above", price: 100 });
  assert.equal(evaluate("BTCUSDT", 99).length, 0);
  const fired = evaluate("BTCUSDT", 100);
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.condition, "above");
});

test("alerts: 'below' fires when price drops to the threshold", () => {
  const { addAlert, evaluate } = useAlertsStore.getState();
  addAlert({ symbol: "ETHUSDT", condition: "below", price: 50 });
  assert.equal(evaluate("ETHUSDT", 51).length, 0);
  assert.equal(evaluate("ETHUSDT", 50).length, 1);
});

test("alerts: a fired alert does not fire twice", () => {
  const { addAlert, evaluate } = useAlertsStore.getState();
  addAlert({ symbol: "BTCUSDT", condition: "above", price: 100 });
  assert.equal(evaluate("BTCUSDT", 101).length, 1);
  assert.equal(evaluate("BTCUSDT", 102).length, 0);
});

test("alerts: only the matching symbol is evaluated", () => {
  const { addAlert, evaluate } = useAlertsStore.getState();
  addAlert({ symbol: "BTCUSDT", condition: "above", price: 100 });
  assert.equal(evaluate("SOLUSDT", 200).length, 0);
});

test("alerts: clearTriggered removes fired alerts but keeps pending ones", () => {
  const { addAlert, evaluate, clearTriggered } = useAlertsStore.getState();
  addAlert({ symbol: "BTCUSDT", condition: "above", price: 100 });
  addAlert({ symbol: "BTCUSDT", condition: "above", price: 500 });
  evaluate("BTCUSDT", 150);
  clearTriggered();
  const remaining = useAlertsStore.getState().alerts;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.price, 500);
});

test("watchlist: toggleFavorite adds then removes", () => {
  const store = useWatchlistStore.getState();
  assert.equal(store.isFavorite("DOGEUSDT"), false);
  store.toggleFavorite("DOGEUSDT");
  assert.equal(useWatchlistStore.getState().isFavorite("DOGEUSDT"), true);
  useWatchlistStore.getState().toggleFavorite("DOGEUSDT");
  assert.equal(useWatchlistStore.getState().isFavorite("DOGEUSDT"), false);
});

test("layout: watchlist width is clamped to the valid range", () => {
  const store = useLayoutStore.getState();
  store.setWatchlistWidth(10);
  assert.equal(useLayoutStore.getState().watchlistWidth, WATCHLIST_MIN);
  useLayoutStore.getState().setWatchlistWidth(9999);
  assert.equal(useLayoutStore.getState().watchlistWidth, WATCHLIST_MAX);
});

test("layout: toggle flips panel visibility and reset restores defaults", () => {
  const store = useLayoutStore.getState();
  const initial = store.watchlistOpen;
  store.toggle("watchlistOpen");
  assert.equal(useLayoutStore.getState().watchlistOpen, !initial);
  useLayoutStore.getState().reset();
  assert.equal(useLayoutStore.getState().watchlistOpen, initial);
});

test("drawings: every toolbar tool maps to a placement shape or the cursor", () => {
  assert.equal(isPlacementTool("trendline"), true);
  assert.equal(isPlacementTool("ray"), true);
  assert.equal(isPlacementTool("longPosition"), true);
  assert.equal(isPlacementTool("crosshair"), false);
  assert.equal(pointsRequired("trendline"), 2);
  assert.equal(pointsRequired("horizontal"), 1);
  assert.equal(pointsRequired("longPosition"), 3);
  assert.equal(pointsRequired("crosshair"), 0);
  assert.equal(drawingTypeForTool("measure"), "measure");
  assert.equal(drawingTypeForTool("crosshair"), null);
});

test("drawings: makeDrawing builds a valid shape tagged with its symbol", () => {
  const d = makeDrawing("BTCUSDT", "horizontal", [{ time: 1_700_000_000, price: 100 }]);
  assert.equal(d.type, "horizontal");
  assert.equal(d.symbol, "BTCUSDT");
  assert.equal(d.points.length, 1);
  assert.ok(d.id.length > 0);
  assert.equal(d.locked, false);
  assert.equal(drawingForTool("BTCUSDT", "crosshair", []), null);
});

test("drawings: a position tool mirrors the risk when the third click is missing", () => {
  const d = makeDrawing("ETHUSDT", "longPosition", [
    { time: 1_700_000_000, price: 2000 },
    { time: 1_700_003_600, price: 2200 },
  ]);
  assert.equal(d.points.length, 3);
  assert.equal(d.points[2]!.price, 1800);
});

test("drawings: position metrics report risk, reward and R:R without any order state", () => {
  const m = positionMetrics([
    { time: 1_700_000_000, price: 100 },
    { time: 1_700_003_600, price: 130 },
    { time: 1_700_003_600, price: 90 },
  ]);
  assert.ok(m);
  assert.equal(m.isLong, true);
  assert.equal(m.risk, 10);
  assert.equal(m.reward, 30);
  assert.equal(m.rr, 3);
  assert.equal(m.riskPct, 10);
  assert.equal(m.rewardPct, 30);

  const s = positionMetrics([
    { time: 1_700_000_000, price: 100 },
    { time: 1_700_003_600, price: 80 },
    { time: 1_700_003_600, price: 110 },
  ]);
  assert.equal(s?.isLong, false);
  assert.equal(s?.stop, 110);
  assert.equal(positionMetrics([]), null);
});

test("drawings: a flat stop yields no R:R ratio", () => {
  const m = positionMetrics([
    { time: 1_700_000_000, price: 100 },
    { time: 1_700_003_600, price: 120 },
    { time: 1_700_003_600, price: 100 },
  ]);
  assert.equal(m?.rr, null);
});
