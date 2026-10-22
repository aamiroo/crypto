import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MarketWSClient } from "../frontend/lib/ws/client.ts";

/**
 * Regression tests for the two reconnect bugs that silently killed the
 * Order Book + Recent Trades panels:
 *   1. `select_symbol` was fire-and-forget, so it was dropped while the socket
 *      was still CONNECTING and never replayed after a reconnect.
 *   2. Sequence state survived a reconnect, so the first replayed frame looked
 *      like a gap and triggered an endless resubscribe loop.
 */

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  simulateMessage(env: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(env) });
  }
  count(type: string) {
    return this.sent.filter((m) => m.type === type).length;
  }
}

const OriginalWS = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = OriginalWS;
});

test("select_symbol sent before the socket opens is replayed on open", () => {
  const client = new MarketWSClient("ws://test");
  client.connect();
  client.selectSymbol("BTCUSDT");

  const ws = FakeWebSocket.instances[0]!;
  assert.equal(ws.sent.length, 0, "must not throw/drop while CONNECTING");

  ws.simulateOpen();
  assert.deepEqual(
    ws.sent.find((m) => m.type === "select_symbol"),
    { type: "select_symbol", symbol: "BTCUSDT" },
  );
  client.disconnect();
});

test("select_symbol is re-sent after a reconnect", () => {
  const client = new MarketWSClient("ws://test");
  client.connect();
  client.selectSymbol("ETHUSDT");
  FakeWebSocket.instances[0]!.simulateOpen();
  assert.equal(FakeWebSocket.instances[0]!.count("select_symbol"), 1);

  // Simulate a dropped connection followed by a fresh socket.
  client.connect();
  const second = FakeWebSocket.instances[1]!;
  second.simulateOpen();
  assert.equal(second.count("select_symbol"), 1);
  assert.deepEqual(
    second.sent.find((m) => m.type === "select_symbol"),
    { type: "select_symbol", symbol: "ETHUSDT" },
  );
  client.disconnect();
});

test("active subscriptions are replayed on open", () => {
  const client = new MarketWSClient("ws://test");
  client.connect();
  client.subscribe({ channel: "orderbook", symbol: "BTCUSDT", depth: 25 });
  client.subscribe({ channel: "trades", symbol: "BTCUSDT" });

  const ws = FakeWebSocket.instances[0]!;
  assert.equal(ws.count("subscribe"), 0);
  ws.simulateOpen();
  // Both topics come back in one grouped frame, not two round trips.
  assert.equal(ws.count("subscribe"), 1);
  const channels = (ws.sent.find((m) => m.type === "subscribe")!.channels as unknown[]).length;
  assert.equal(channels, 2);
  client.disconnect();
});

test("reconnect clears sequence state so replayed history is not a gap", () => {
  const client = new MarketWSClient("ws://test");
  client.connect();
  const first = FakeWebSocket.instances[0]!;
  first.simulateOpen();
  client.subscribe({ channel: "kline", symbol: "BTCUSDT", interval: "1m" });
  first.simulateMessage({ type: "kline", channel: "kline", symbol: "BTCUSDT", seq: 5, data: { interval: "1m" } });

  // Reconnect on a fresh socket, then replay history from seq 1.
  client.connect();
  const second = FakeWebSocket.instances[1]!;
  second.simulateOpen();
  const subscribesAfterOpen = second.count("subscribe");
  second.simulateMessage({ type: "kline", channel: "kline", symbol: "BTCUSDT", seq: 1, data: { interval: "1m" } });

  assert.equal(
    second.count("subscribe"),
    subscribesAfterOpen,
    "a stale lastSeq must not force a resubscribe after reconnect",
  );
  client.disconnect();
});

test("subscribeBatch groups topics and never re-registers a live one", () => {
  const client = new MarketWSClient("ws://test");
  client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.simulateOpen();
  const before = ws.sent.length;

  const reqs = Array.from({ length: 120 }, (_, i) => ({ channel: "ticker" as const, symbol: `SYM${i}USDT` }));
  client.subscribeBatch(reqs);
  const frames = ws.sent.slice(before);
  assert.equal(frames.length, 3, "120 topics in frames of 50");
  assert.deepEqual(frames.map((f) => (f.channels as unknown[]).length), [50, 50, 20]);

  // Re-announcing the same list (the gateway pushes `symbols` again on refresh)
  // must not re-subscribe what is already live.
  client.subscribeBatch(reqs);
  assert.equal(ws.sent.length, before + 3);
  client.disconnect();
});

test("a real sequence gap within a connection still triggers a resubscribe", () => {
  const client = new MarketWSClient("ws://test");
  client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.simulateOpen();
  client.subscribe({ channel: "kline", symbol: "BTCUSDT", interval: "1m" });
  ws.simulateMessage({ type: "kline", channel: "kline", symbol: "BTCUSDT", seq: 1, data: { interval: "1m" } });
  const before = ws.count("subscribe");
  ws.simulateMessage({ type: "kline", channel: "kline", symbol: "BTCUSDT", seq: 4, data: { interval: "1m" } });
  assert.equal(ws.count("subscribe"), before + 1, "seq gap should resubscribe");
  client.disconnect();
});
