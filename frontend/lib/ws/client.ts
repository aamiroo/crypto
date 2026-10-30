import type { ChannelSubRequest, ClientMessage, Envelope } from "@/lib/types";

type MessageListener = (env: Envelope) => void;
type StateListener = (connected: boolean) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
/** 8 s × 3 missed pongs: a socket that dies quietly (a proxy dropping it without
 *  a close event) freezes the chart for ~24-32 s. At the old 15 s the freeze ran
 *  past 45 s, well after the UI had already declared itself STALE. */
const PING_INTERVAL_MS = 8000;
const MAX_MISSED_PONGS = 3; // PROTOCOL.md §2: reconnect after 3 missed pongs
const SUBSCRIBE_BATCH = 50; // topics per subscribe frame

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
  /**
   * The symbol whose *detail* channels (orderbook + trades) the gateway should
   * stream. Treated like a subscription so it survives reconnects — the
   * gateway derives its collector sync from `select_symbol`, so losing it means
   * those channels silently go quiet.
   */
  private selectedSymbol: string | null = null;
  private reconnectAttempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private closedByUser = false;

  /** Stores the gateway URL but does not dial yet; call `connect()` only after
   *  registering listeners so the very first frames are not missed. */
  constructor(url: string) {
    this.url = url;
  }

  /** Open the socket and re-arm auto-reconnect: clearing the user-closed flag
   *  is what makes a later unexpected close back off and retry. */
  connect() {
    this.closedByUser = false;
    this.openSocket();
  }

  /** Deliberate teardown. The user-closed flag keeps `onclose` from reading
   *  this as a dropped connection and scheduling a reconnect. */
  disconnect() {
    this.closedByUser = true;
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  /** Subscribe to every inbound envelope; returns a disposer. Listeners live
   *  in a Set, so registering the same function twice still delivers it once. */
  onMessage(fn: MessageListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Observe connect/disconnect (true on open, false on close); returns a
   *  disposer. Kept off the message path so status UI ignores the hot fan-out. */
  onStateChange(fn: StateListener) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  /** Track the topic so it is replayed after a reconnect, and clear its stored
   *  seq so the snapshot that follows a fresh subscribe isn't read as a gap. */
  subscribe(req: ChannelSubRequest) {
    const key = topicKey(req.channel, req.symbol, req.interval);
    this.activeSubs.set(key, req);
    this.lastSeq.delete(key);
    this.send({ type: "subscribe", channels: [req] });
  }

  /**
   * Register many topics at once. The watchlist subscribes a ticker for every
   * listed pair, and one frame per symbol meant hundreds of round trips on
   * every connect and reconnect.
   */
  subscribeBatch(reqs: ChannelSubRequest[]) {
    const fresh: ChannelSubRequest[] = [];
    for (const req of reqs) {
      const key = topicKey(req.channel, req.symbol, req.interval);
      if (this.activeSubs.has(key)) continue;
      this.activeSubs.set(key, req);
      this.lastSeq.delete(key);
      fresh.push(req);
    }
    this.sendGrouped(fresh);
  }

  private sendGrouped(reqs: ChannelSubRequest[]) {
    for (let i = 0; i < reqs.length; i += SUBSCRIBE_BATCH) {
      this.send({ type: "subscribe", channels: reqs.slice(i, i + SUBSCRIBE_BATCH) });
    }
  }

  /** Stop streaming a topic and forget it, so a later reconnect no longer
   *  re-subscribes it; its sequence tracker is cleared too. */
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

  /**
   * Select the symbol whose orderbook+trades the gateway should stream. Unlike
   * `sendMessage`, this is remembered and replayed after a (re)connect, which
   * is what keeps the Order Book and Recent Trades panels alive.
   */
  selectSymbol(symbol: string) {
    this.selectedSymbol = symbol;
    this.send({ type: "select_symbol", symbol });
  }

  private openSocket() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.missedPongs = 0;
      this.startPing();
      // Every subscription is (re)established from scratch, so any sequence
      // numbers from the previous connection are meaningless. Clearing them
      // prevents a false gap -> resubscribe loop on the very first frame.
      this.lastSeq.clear();
      for (const fn of this.stateListeners) fn(true);
      this.sendGrouped([...this.activeSubs.values()]);
      // Detail channels (orderbook/trades) are gated by select_symbol on the
      // gateway, so it must be re-sent too — otherwise they never restart.
      if (this.selectedSymbol) {
        this.send({ type: "select_symbol", symbol: this.selectedSymbol });
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

/** Map key for a topic. Interval joins the key only for klines, matching the
 *  gateway's per-(symbol, channel, interval) sequence (docs/PROTOCOL.md §3). */
function topicKey(channel: string, symbol: string, interval?: string) {
  return interval ? `${channel}:${symbol}:${interval}` : `${channel}:${symbol}`;
}
