import type { ChannelSubRequest, ClientMessage, Envelope } from "@/lib/types";

type MessageListener = (env: Envelope) => void;
type StateListener = (connected: boolean) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const PING_INTERVAL_MS = 15000;
const MAX_MISSED_PONGS = 3; // PROTOCOL.md §2: reconnect after 3 missed pongs

/**
 * MarketWSClient owns exactly one WebSocket connection to the Gateway.
 * It is deliberately dumb about *what* the messages mean — that's the
 * store's job (see lib/store/marketStore.ts). This class only owns:
 *   - connect/reconnect with backoff
 *   - re-subscribing to whatever topics were active after a reconnect
 *   - per-(channel,symbol) sequence gap detection -> automatic resubscribe
 *   - a heartbeat ping so we detect dead connections through proxies
 *
 * Sequence recovery matches docs/PROTOCOL.md §3: any *_delta whose seq
 * isn't exactly lastSeq+1 triggers an immediate resubscribe, which the
 * gateway answers with a fresh *_snapshot that resets the sequence.
 */
export class MarketWSClient {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners = new Set<MessageListener>();
  private stateListeners = new Set<StateListener>();
  private activeSubs = new Map<string, ChannelSubRequest>(); // key -> request
  private lastSeq = new Map<string, number>(); // "channel:symbol" -> seq
  private reconnectAttempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private closedByUser = false;

  constructor(url: string) {
    this.url = url;
  }

  connect() {
    this.closedByUser = false;
    this.openSocket();
  }

  disconnect() {
    this.closedByUser = true;
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  onMessage(fn: MessageListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStateChange(fn: StateListener) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  subscribe(req: ChannelSubRequest) {
    const key = topicKey(req.channel, req.symbol, req.interval);
    this.activeSubs.set(key, req);
    this.lastSeq.delete(key);
    this.send({ type: "subscribe", channels: [req] });
  }

  unsubscribe(channel: ChannelSubRequest["channel"], symbol: string, interval?: string) {
    const key = topicKey(channel, symbol, interval);
    this.activeSubs.delete(key);
    this.lastSeq.delete(key);
    this.send({ type: "unsubscribe", channels: [{ channel, symbol, interval }] });
  }

  /** Send arbitrary message (e.g. select_symbol). */
  sendMessage(msg: Record<string, unknown>) {
    this.send(msg as unknown as ClientMessage);
  }

  private openSocket() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.missedPongs = 0;
      this.startPing();
      for (const fn of this.stateListeners) fn(true);
      for (const req of this.activeSubs.values()) {
        this.send({ type: "subscribe", channels: [req] });
      }
    };

    ws.onmessage = (evt) => {
      const env = JSON.parse(evt.data) as Envelope;
      this.handleEnvelope(env);
    };

    ws.onclose = () => {
      this.stopPing();
      for (const fn of this.stateListeners) fn(false);
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private handleEnvelope(env: Envelope) {
    if (env.type === "pong") {
      this.missedPongs = 0;
      return;
    }

    if (env.channel && env.symbol && env.seq !== undefined) {
      const iv = (env.data as Record<string, unknown>)?.interval as string | undefined;
      const key = topicKey(env.channel as string, env.symbol, iv);

      if (env.type.endsWith("_snapshot")) {
        this.lastSeq.delete(key);
      } else {
        const prev = this.lastSeq.get(key);
        if (prev !== undefined && env.seq !== prev + 1) {
          this.resync(env.channel as ChannelSubRequest["channel"], env.symbol, iv);
          return;
        }
        this.lastSeq.set(key, env.seq);
      }
    }

    for (const fn of this.listeners) fn(env);
  }

  private resync(channel: ChannelSubRequest["channel"], symbol: string, interval?: string) {
    const key = topicKey(channel, symbol, interval);
    const req = this.activeSubs.get(key);
    if (!req) return;
    this.lastSeq.delete(key);
    this.send({ type: "subscribe", channels: [req] });
  }

  private send(msg: ClientMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private sendPing() {
    if (this.missedPongs >= MAX_MISSED_PONGS) {
      this.ws?.close(); // onclose -> scheduleReconnect
      return;
    }
    if (this.send({ type: "ping" })) this.missedPongs += 1;
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect() {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    setTimeout(() => {
      if (!this.closedByUser) this.openSocket();
    }, delay);
  }
}

function topicKey(channel: string, symbol: string, interval?: string) {
  return interval ? `${channel}:${symbol}:${interval}` : `${channel}:${symbol}`;
}
