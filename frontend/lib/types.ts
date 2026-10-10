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

export interface TickerData {
  lastPrice: string;
  indexPrice: string;
  markPrice: string;
  bidPrice?: string;
  askPrice?: string;
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
  | "trendline" | "horizontal" | "vertical" | "ray"
  | "rectangle" | "fibonacci" | "fibextension" | "text"
  | "pricelabel" | "measure";

export interface Drawing {
  id: string;
  type: DrawingType;
  points: { time: number; price: number }[];
  color: string;
  label?: string;
  fibLevels?: number[];
  locked?: boolean;
  visible?: boolean;
}

export interface PaperOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  price: string;
  qty: string;
  status: "open" | "filled" | "cancelled";
  filledAt?: number;
  filledPrice?: string;
  createdAt: number;
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  qty: string;
  avgEntry: string;
  unrealizedPnl: string;
  margin: string;
}

export interface SymbolPrecision {
  priceDecimals: number;
  qtyDecimals: number;
}

export type ThemeName = "dark" | "light";

export interface ChartSettings {
  chartType: ChartType;
  showGrid: boolean;
  showVolume: boolean;
  showDrawings: boolean;
  showIndicators: boolean;
  autoScale: boolean;
  magnetMode: boolean;
  lockDrawings: boolean;
}

export type ChartTool =
  | "crosshair" | "trendline" | "horizontal" | "vertical"
  | "ray" | "extended" | "channel" | "rectangle"
  | "fibonacci" | "fibextension" | "text"
  | "pricelabel" | "measure"
  | "eraser" | "magnet" | "lock" | "hide";

export interface DataStatus {
  connected: boolean;
  lastTickerTs: number | null;
  lastTradeTs: number | null;
  lastOrderbookTs: number | null;
  lastKlineTs: number | null;
  currentExchange: string;
  currentSymbol: string;
  currentTimeframe: string;
}

