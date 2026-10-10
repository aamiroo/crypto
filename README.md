# Crypto Market Terminal — Phase 1

ترمینال بازار ارز دیجیتال به‌صورت کاملاً npm-based (بدون Docker). داده از Bybit جمع می‌شود، نرمالایز و مستقیم به WebSocket کلاینت تحویل می‌شود.

## ساختار پوشه‌ها

```
crypto-terminal/
├── docs/
│   └── PROTOCOL.md              # پروتکل WS + تصمیم‌های معماری
├── backend/
│   ├── package.json
│   ├── test_sym.js              # تست دستی: اتصال، تعویض نماد، شمارش پیام
│   └── src/
│       ├── index.js              # نقطه ورود — کلکتور + گیت‌وی
│       ├── bus.js                # EventBus داخلی (جایگزین NATS)
│       ├── symbols.js            # لیست نمادها (۱۶۷ جفت‌ارز)
│       ├── collector/
│       │   ├── bybit.js          # کلکتور Bybit (فعال — sync بر اساس تقاضا)
│       │   └── binance.js        # کلکتور Binance (پیش‌نویس — هنوز در index.js فعال نشده)
│       └── gateway/
│           ├── server.js         # HTTP + WebSocket server (ping/pong + REST klines)
│           ├── hub.js            # مدیریت کلاینت‌ها + کتاب سفارش سمت سرور + broadcast
│           └── sequencer.js      # sequence داخلی per (channel, symbol, interval)
├── frontend/
│   ├── app/page.tsx              # صفحه اصلی Trading Terminal
│   ├── components/               # OrderBook, ChartPanel, TradeList, Watchlist,
│   │                             # MarketHeader, TopBar, TradingPanel, BottomPanel, ...
│   └── lib/
│       ├── types.ts              # نوع‌های TS منطبق با پروتکل
│       ├── ws/client.ts          # MarketWSClient: reconnect + sequence recovery
│       ├── ws/useMarketFeed.ts   # اتصال WS به Zustand store
│       ├── store/                # marketStore, chartStore, themeStore, tradingStore
│       └── utils/                # format, indicators, symbol
└── package.json                  # Root scripts
```

## اجرا (لوکال)

```bash
# نصب همه وابستگی‌ها
npm run install:all

# اجرای همزمان بک‌اند + فرانت‌اند
npm run dev

# یا جداگانه:
npm run dev:backend     # بک‌اند روی پورت 8080
npm run dev:frontend    # فرانت‌اند روی پورت 3000

# بررسی کد
cd frontend && npm run lint && npx tsc --noEmit
```

**پیش‌نیاز:** فقط Node.js 18+. نیازی به Docker، NATS یا Go نیست.

## معماری

```
Bybit WS ──> Collector ──> EventBus (درون‌پروسسی) ──> Gateway ──> WebSocket ──> Frontend
```

- **Collector:** به صرافی وصل می‌شود، داده خام را نرمالایز می‌کند و روی bus منتشر می‌کند
- **EventBus:** جایگزین NATS برای deployment تک‌پروسسی — subject با همان قرارداد `market.<venue>.<symbol>.<channel>`؛ در صورت نیاز به scale می‌توان NATS را جایگزین کرد
- **Gateway:** sequence داخلی اختصاص می‌دهد، کتاب سفارش را سمت سرور نگه می‌دارد (برای مشترکان جدید snapshot تازه می‌سازد) و به کلاینت‌های WS فن‌اوت می‌کند

> **وضعیت چند-صرافی:** کلکتور Binance به‌صورت پیش‌نویس موجود است ولی هنوز فعال نیست (Phase 2). ترتیب sequence فعلی بر اساس یک صرافی طراحی شده؛ فعال‌سازی هم‌زمان چند صرافی نیازمند merge سطوح (Phase 3) است.

## قابلیت‌ها

- ✅ Order Book (snapshot + delta با sequence recovery — snapshot سمت سرور برای مشترکان جدید rebuild می‌شود)
- ✅ Trades لحظه‌ای
- ✅ نمودار کندل (lightweight-charts) + اندیکاتورها
- ✅ Ticker 24 ساعته
- ✅ Reconnect خودکار با backoff + heartbeat (ping/pong، بازاتصال بعد از ۳ pong از دست رفته)
- ✅ Kline تاریخی از REST + استریم زنده (interval جداگانه به‌ازای هر کلاینت)
- ✅ Multi-symbol (۱۶۷ جفت‌ارز، انتخاب نماد در لحظه)
- ✅ lint (ESLint) و typecheck (tsc) بدون خطا
