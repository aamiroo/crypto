// ── Protocol types (mirrors backend/gateway) ──────────────────────────
export type PriceLevel = [price: string, size: string];

export interface Envelope<T = unknown> {
  type: string;
  channel?: string;
  symbol?: string;
  seq?: number;
  ts: number;
  data?: T;
}

export interface OrderBookSnapshotData { bids: PriceLevel[]; asks: PriceLevel[]; }
export interface OrderBookDeltaData   { bids: PriceLevel[]; asks: PriceLevel[]; }

export interface TradeData {
  id: string;
  price: string;
  size: string;
  side: "buy" | "sell";
  ts?: number;
}

export interface KlineData {
  interval: string;
  openTime: number;
  closeTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closed: boolean;
}

/** `kline_snapshot`: the gateway's answer to a kline subscribe — the bars it
 *  cached, collapsed to the newest tick per openTime. `interval` is top level
 *  because the client keys sequence recovery on (channel, symbol, interval). */
export interface KlineSnapshotData { interval: string; candles: KlineData[]; }

export interface TickerData {
  lastPrice: string;
  bidPrice?: string;
  askPrice?: string;
  /** Percent, not fraction: the gateway converts the venue's 24h ratio. */
  change24h: string;
  high24h: string;
  low24h: string;
  volume24h: string;
  turnover24h?: string;
  ts?: number;
}

export type ChannelName = "orderbook" | "trades" | "kline" | "ticker";

export interface ChannelSubRequest {
  channel: ChannelName;
  symbol: string;
  depth?: number;
  interval?: string;
}

export interface ClientMessage {
  type: "subscribe" | "unsubscribe" | "ping" | "select_symbol";
  channels?: ChannelSubRequest[];
  symbol?: string;
}

/** One tradable instrument as advertised by the venue (docs/PROTOCOL.md §2). */
export interface InstrumentInfo {
  symbol: string;
  baseCoin: string;
  priceDecimals: number;
  qtyDecimals: number;
}

export interface SymbolsData {
  venue: string;
  instruments: InstrumentInfo[];
}

/** Codes the gateway returns in an `error` envelope. */
export type ErrorCode =
  | "BAD_JSON" | "BAD_REQUEST" | "BAD_CHANNEL" | "BAD_INTERVAL"
  | "UNKNOWN_SYMBOL";

// ── App types ─────────────────────────────────────────────────────────
export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w";
export type ChartType = "candlestick" | "line" | "area";

export interface IndicatorConfig {
  id: string;
  type: "sma" | "ema" | "rsi" | "macd" | "bb" | "vol";
  period: number;
  visible: boolean;
  color?: string;
}

export type DrawingType =
  | "horizontal" | "vertical" | "trendline" | "ray"
  | "fibonacci" | "measure" | "longPosition" | "shortPosition";

export interface DrawingPoint {
  /** Bar open time in ms. */
  time: number;
  price: number;
}

export interface Drawing {
  id: string;
  type: DrawingType;
  /** Drawings belong to the symbol they were drawn on. */
  symbol: string;
  points: DrawingPoint[];
  color: string;
  locked?: boolean;
  visible?: boolean;
}

export interface SymbolPrecision {
  priceDecimals: number;
  qtyDecimals: number;
}

export type ThemeName = "dark" | "light";

/** A client-side price alert. Triggered by evaluating live ticker updates. */
export type AlertCondition = "above" | "below";

export interface PriceAlert {
  id: string;
  symbol: string;
  condition: AlertCondition;
  price: number;
  createdAt: number;
  triggeredAt?: number;
  triggeredPrice?: number;
}

/** Persisted layout preferences (panel widths / collapsed state). */
export interface LayoutState {
  watchlistOpen: boolean;
  watchlistWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
}

export type ToastKind = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  createdAt: number;
}

export interface ChartSettings {
  chartType: ChartType;
  showGrid: boolean;
  showVolume: boolean;
  showDrawings: boolean;
  showIndicators: boolean;
  autoScale: boolean;
}

export type ChartTool =
  | "crosshair" | "horizontal" | "vertical" | "trendline" | "ray"
  | "fibonacci" | "measure" | "longPosition" | "shortPosition";

