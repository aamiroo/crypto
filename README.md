# Crypto Market Terminal

A real-time cryptocurrency market analysis terminal built with Node.js and Next.js. It collects live market data from Bybit, normalizes it, and distributes it to connected clients through WebSocket.

The application provides a desktop-style trading interface with interactive charts, technical indicators, drawing tools, market depth, trade history, watchlists, and price alerts.

**This is an analysis-only terminal, not a trading platform.** It does not support order execution, account balances, portfolios, or PnL tracking. Long and Short Position tools are visual chart annotations used exclusively for risk/reward analysis.

## Features

### Real-Time Market Data

- Live market data collection from Bybit WebSocket.
- Centralized data distribution through an internal EventBus and WebSocket Gateway.
- Automatic WebSocket reconnection and sequence recovery.
- Batched ticker updates and grouped subscriptions.
- REST API for retrieving historical candlestick data.
- Connection state monitoring: LIVE, STALE, RECONNECTING, and CONNECTING.

### Charts & Technical Analysis

- Interactive candlestick charts with multiple timeframes.
- Overlay indicators:
  - SMA
  - EMA
  - Bollinger Bands
- Oscillators:
  - RSI (independent 0–100 scale)
  - MACD
- Independent oscillator scales.
- Indicator management through the chart menu.

### Drawing Tools

Nine chart interaction modes and drawing tools:

- Crosshair
- Horizontal Line
- Vertical Line
- Trendline
- Ray
- Fibonacci Retracement (7 levels)
- Measure
- Long Position
- Short Position

Drawing capabilities:

- SVG-based drawing overlays.
- Per-symbol drawing persistence using localStorage.
- Select, drag, resize, lock, hide, and delete drawings.
- Undo and Redo support.
- Individual drawing selection and management.

**Long/Short Position drawings** display Entry, Take Profit, Stop Loss, risk percentage, reward percentage, and Risk/Reward ratio. They do not execute trades or interact with exchange accounts.

### Market Data & Precision

- Automatic discovery of active USDT trading pairs from Bybit.
- Currently supports approximately 389 active USDT pairs.
- Live instrument metadata discovery.
- Tick size and lot size precision derived from exchange instrument information.
- Symbol-specific price formatting.
- Consistent 24-hour ticker percentage change calculations.
- Offline instrument snapshot as a fallback when network access is unavailable.

### Market Interface

- Real-time Watchlist with customizable favorites.
- Default favorites: BTC, ETH, SOL, BNB, and XRP.
- Searchable symbol selector.
- Order Book visualization.
- Recent Trades display.
- Responsive three-column desktop layout.
- Tab-based mobile layout.
- Resizable and collapsible panels.
- Automatic layout persistence.

### Alerts & Notifications

- Price alerts for above/below conditions.
- Real-time ticker-based alert evaluation.
- Toast notifications when alerts are triggered.
- Connection and subscription event notifications.
- Local alert persistence.

### Performance & Optimization

- Virtualized lists for large datasets.
- Batched ticker updates.
- Grouped WebSocket subscriptions.
- Throttled indicator recalculation.
- Client-side state management.
- Sequence-aware market data synchronization.

## Architecture

The application uses a collector–gateway architecture to separate exchange connectivity from client communication.

```text
                  Bybit WebSocket
                         |
                         v
                  Market Collector
                         |
                         v
                     EventBus
                         |
                         v
                  WebSocket Gateway
                    /          \
                   /            \
             REST API       WebSocket
                 |               |
                 v               v
          Historical Data    Frontend Clients
                                 |
                                 v
                         Market State Store
                                 |
                                 v
                         Trading Interface
```

**Core components:**

- **Collector:** Maintains exchange connections, receives market updates, and handles demand-driven synchronization.
- **EventBus:** Provides internal event distribution between backend components.
- **Gateway:** Manages client connections, subscriptions, message broadcasting, and historical candle requests.
- **Sequencer:** Maintains message ordering independently for each channel, symbol, and interval.
- **Frontend:** Processes real-time updates and maintains the application state for charts and market components.

## Requirements

- Node.js 22 or newer.
- npm.
- Internet connection for live Bybit market data.

No Docker, NATS, Go, or external message broker is required.

## Installation

Clone the repository and install all dependencies:

```bash
npm run install:all
```

## Running the Application

Start the backend and frontend simultaneously:

```bash
npm run dev
```

Or run them separately:

**Backend** — Port 8080:

```bash
npm run dev:backend
```

**Frontend** — Port 3000:

```bash
npm run dev:frontend
```

## Development & Testing

### Run Tests

Execute the complete test suite from the project root:

```bash
npm test
```

The test suite covers backend functionality, WebSocket protocol, gateway REST endpoints, WebSocket client behavior, state management, formatting, alerts, watchlists, layouts, and drawing tools.

### Lint & Type Checking

```bash
cd frontend
npm run lint
npx tsc --noEmit
```

### Refresh Offline Instrument Snapshot

The live instrument cache is maintained automatically. To regenerate the offline snapshot manually:

```bash
node backend/scripts/refresh-instruments.mjs
```

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `1`–`9` | Switch chart timeframe |
| `F` | Toggle chart fullscreen |
| `R` | Reset chart view / jump to latest candle |
| `V` | Crosshair tool |
| `H` | Horizontal Line |
| `B` | Vertical Line |
| `T` | Trendline |
| `J` | Ray |
| `G` | Fibonacci |
| `M` | Measure |
| `L` | Long Position |
| `K` | Short Position |
| `Ctrl/⌘ + Z` | Undo drawing |
| `Ctrl/⌘ + Y` | Redo drawing |
| `Del` | Delete selected drawing |
| `Esc` | Cancel active tool / close dialog |
| `?` | Open keyboard shortcuts reference |

## Current Limitations

- **No trade execution:** The application is strictly for market analysis. It does not place orders, manage balances, or calculate portfolio PnL.
- **Local drawings:** Chart drawings are stored in browser localStorage and are not synchronized across devices.
- **Limited indicators:** Only SMA, EMA, Bollinger Bands, RSI, and MACD are currently available.
- **Local alerts:** Alert evaluation runs in the browser while the application tab is open. Alerts are not processed by a persistent backend service.
- **Single exchange:** Bybit is the only active exchange integration in this phase. The Binance collector is preliminary and not enabled.
- **Spot price limitations:** Bybit Spot markPrice and indexPrice are not available or published in Phase 1.

## Roadmap

### Phase 2 — Multi-Exchange Integration

- Enable the Binance market data collector.
- Normalize and merge market data across exchanges.
- Extend market depth aggregation.

### Future Development

- Server-side alert evaluation and persistence.
- Strategy development and historical backtesting.
- Analysis journal.
- Server-side persistence for watchlists, layouts, and drawings.
- Cross-device synchronization.

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.
See the [LICENSE](LICENSE) file for the complete license text.