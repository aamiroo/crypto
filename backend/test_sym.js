// Manual smoke test: run the gateway first, then `node test_sym.js`.
// Subscribes, switches symbols, and prints per-symbol message counts.
import { WebSocket } from "ws";

const ws = new WebSocket("ws://localhost:8080/ws");
let msgs = [];
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'subscribe', channels: [
    { channel: 'ticker', symbol: 'BTCUSDT' },
    { channel: 'orderbook', symbol: 'BTCUSDT' },
    { channel: 'trades', symbol: 'BTCUSDT' },
    { channel: 'kline', symbol: 'BTCUSDT', interval: '1m' }
  ]}));
  ws.send(JSON.stringify({ type: 'select_symbol', symbol: 'BTCUSDT' }));
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'unsubscribe', channels: [
      { channel: 'orderbook', symbol: 'BTCUSDT' },
      { channel: 'trades', symbol: 'BTCUSDT' },
      { channel: 'kline', symbol: 'BTCUSDT', interval: '1m' }
    ]}));
    ws.send(JSON.stringify({ type: 'subscribe', channels: [
      { channel: 'orderbook', symbol: 'ETHUSDT' },
      { channel: 'trades', symbol: 'ETHUSDT' },
      { channel: 'kline', symbol: 'ETHUSDT', interval: '1m' }
    ]}));
    ws.send(JSON.stringify({ type: 'select_symbol', symbol: 'ETHUSDT' }));
  }, 3000);
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'unsubscribe', channels: [
      { channel: 'orderbook', symbol: 'ETHUSDT' },
      { channel: 'trades', symbol: 'ETHUSDT' },
      { channel: 'kline', symbol: 'ETHUSDT', interval: '1m' }
    ]}));
    ws.send(JSON.stringify({ type: 'subscribe', channels: [
      { channel: 'orderbook', symbol: 'SOLUSDT' },
      { channel: 'trades', symbol: 'SOLUSDT' },
      { channel: 'kline', symbol: 'SOLUSDT', interval: '1m' }
    ]}));
    ws.send(JSON.stringify({ type: 'select_symbol', symbol: 'SOLUSDT' }));
  }, 6000);
});
ws.on('message', (raw) => { msgs.push(JSON.parse(raw.toString())); });
setTimeout(() => {
  const bySym = {};
  for (const m of msgs) {
    const s = m.symbol || 'none';
    if (!bySym[s]) bySym[s] = {};
    const t = m.type;
    bySym[s][t] = (bySym[s][t] || 0) + 1;
  }
  console.log('Total:', msgs.length);
  for (const [s, c] of Object.entries(bySym)) console.log(s + ':', JSON.stringify(c));
  ws.close(); process.exit(0);
}, 10000);
