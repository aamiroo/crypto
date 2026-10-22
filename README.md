# Crypto Market Terminal — Phase 1

ترمینال تحلیل تکنیکال ارز دیجیتال (در سبک TradingView) به‌صورت کاملاً npm-based (بدون Docker). داده از Bybit جمع می‌شود، نرمالایز و مستقیم به WebSocket کلاینت تحویل می‌شود. **این پروژه پلتفرم معامله نیست:** هیچ سفارش، موجودی یا PnL ای وجود ندارد؛ ابزار Long/Short فقط یک رسم روی نمودار برای تحلیل ریسک/ریوارد است.

## ساختار پوشه‌ها

```
crypto-terminal/
├── docs/
│   └── PROTOCOL.md              # پروتکل WS + REST + قرارداد دقت/درصد + تصمیم‌های معماری
├── backend/
│   ├── package.json
│   ├── data/instruments.json    # کش کشف زنده نمادها (tickSize/lotSize)
│   ├── scripts/refresh-instruments.mjs  # بازتولید snapshot آفلاین نمادها
│   ├── test_sym.js              # تست دستی: اتصال، تعویض نماد، شمارش پیام
│   └── src/
│       ├── index.js              # نقطه ورود — کلکتور + گیت‌وی
│       ├── bus.js                # EventBus داخلی (جایگزین NATS)
│       ├── instruments.js        # کشف زنده نمادها + دقت قیمت/تعداد از رجیستری
│       ├── symbols.js            # snapshot آفلاین (فقط وقتی شبکه در دسترس نباشد)
│       ├── collector/
│       │   ├── bybit.js          # کلکتور Bybit (فعال — sync بر اساس تقاضا)
│       │   ├── tickers.js        # نرمالایز تیکر + hydration اولیه از REST
│       │   └── binance.js        # کلکتور Binance (پیش‌نویس — هنوز در index.js فعال نشده)
│       └── gateway/
│           ├── server.js         # HTTP + WebSocket server (ping/pong + REST klines)
│           ├── hub.js            # مدیریت کلاینت‌ها + کتاب سفارش سمت سرور + broadcast
│           └── sequencer.js      # sequence داخلی per (channel, symbol, interval)
├── frontend/
│   ├── app/page.tsx              # صفحه اصلی Trading Terminal (layout میزکار)
│   ├── components/               # TopBar, MarketHeader, ChartPanel, ChartToolbar,
│   │                             # DrawingLayer, IndicatorMenu, ChartSettingsMenu,
│   │                             # Watchlist, SymbolPicker, OrderBook, TradeList,
│   │                             # AlertsPanel, ShortcutsModal, Toasts (+ components/ui/*)
│   └── lib/
│       ├── types.ts              # نوع‌های TS منطبق با پروتکل
│       ├── api/klines.ts         # خواندن تاریخچه کندل از REST گیت‌وی
│       ├── ws/client.ts          # MarketWSClient: reconnect + sequence recovery + batch subscribe
│       ├── ws/useMarketFeed.ts   # اتصال WS به Zustand store
│       ├── hooks/                # useAlertEngine, useKeyboardShortcuts,
│       │                         # useMediaQuery, useVirtualList
│       ├── store/                # marketStore, chartStore, themeStore,
│       │                         # layoutStore, watchlistStore, alertsStore,
│       │                         # toastStore, uiStore, persist
│       └── utils/                # format, indicators, symbol, klines, drawings
├── tests/                        # تست‌های node:test (بک‌اند، پروتکل WS، کلاینت، state ترمینال)
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

# تست‌ها (از ریشه)
npm test

# بازتولید snapshot آفلاین نمادها (اختیاری — کش زنده خودکار است)
node backend/scripts/refresh-instruments.mjs
```

**پیش‌نیاز:** فقط Node.js 22+. نیازی به Docker، NATS یا Go نیست.

## معماری

```
Bybit WS ──> Collector ──> EventBus (درون‌پروسسی) ──> Gateway ──> WebSocket ──> Frontend
```

- **Collector:** به صرافی وصل می‌شود، داده خام را نرمالایز می‌کند و روی bus منتشر می‌کند. موقع بالا آمدن، یک‌بار snapshot تیکر ۲۴ ساعته از REST می‌خواند تا Watchlist خالی شروع نشود.
- **رجیستری نماد:** لیست نمادها به‌جای یک فایل ثابت، به‌صورت زنده از `GET /v5/market/instruments-info?category=spot` کشف می‌شود (فقط جفت‌های USDT فعال) و در `backend/data/instruments.json` کش می‌شود؛ اگر شبکه در دسترس نباشد snapshot آفلاین `symbols.js` مصرف می‌شود. `tickSize`/`lotSize` همانجا به `priceDecimals`/`qtyDecimals` تبدیل می‌شوند و به کلاینت فرستاده می‌شوند.
- **EventBus:** جایگزین NATS برای deployment تک‌پروسسی — subject با همان قرارداد `market.<venue>.<symbol>.<channel>`؛ در صورت نیاز به scale می‌توان NATS را جایگزین کرد
- **Gateway:** sequence داخلی اختصاص می‌دهد، کتاب سفارش را سمت سرور نگه می‌دارد (برای مشترکان جدید snapshot تازه می‌سازد)، کش‌ها را با TTL و LRU تمیز نگه می‌دارد و به کلاینت‌های WS فن‌اوت می‌کند؛ ورودی‌های REST/WS را اعتبارورزی می‌کند و کد خطا برمی‌گرداند.

> **وضعیت چند-صرافی:** کلکتور Binance به‌صورت پیش‌نویس موجود است ولی هنوز فعال نیست (Phase 2). ترتیب sequence فعلی بر اساس یک صرافی طراحی شده؛ فعال‌سازی هم‌زمان چند صرافی نیازمند merge سطوح (Phase 3) است.

## قابلیت‌ها

### داده و نمودار
- ✅ Order Book (snapshot + delta با sequence recovery — snapshot سمت server برای مشترکان جدید rebuild می‌شود) + نمایش spread و عمق تجمعی
- ✅ Trades لحظه‌ای (قیمت/حجم رنگی، جهت خرید/فروش)
- ✅ نمودار کندل (lightweight-charts) + نوع candle/line/area + volume
- ✅ اندیکاتورها: overlay (SMA، EMA، Bollinger) و اسیلاتور (RSI، MACD) — هر اسیلاتور در پنل و scale مستقل خودش (RSI روی بازه ۰–۱۰۰ قفل می‌شود) — add/remove از منوی Indicator
- ✅ ابزارهای رسم (۹ ابزار، همه با رندر واقعی در SVG overlay): خط افقی، خط عمودی، Trendline، Ray، Fibonacci (۷ سطح)، Measure، Long Position و Short Position برای تحلیل ریسک/ریوارد + Crosshair
- ✅ رسم‌ها per-symbol در localStorage ذخیره می‌شوند و تک‌تک قابل انتخاب، درگ (بدنه یا هندل‌ها)، lock، مخفی‌سازی و حذف‌اند + Undo/Redo
- ✅ Long/Short Position فقط یک رسم است: entry/TP/SL با برچسب ریسک٪، ریوارد٪ و نسبت R:R — بدون هیچ سفارش یا موجودی
- ✅ دقت نمایش از متادیتای instrument صرافی (tickSize/lotSize) می‌آید؛ مثلاً BTCUSDT یک رقم و LUNCUSDT هشت رقم اعشار
- ✅ Ticker 24 ساعته با تغییر درصد (قرارداد درصد در همه مسیرها یکسان)
- ✅ Reconnect خودکار با backoff + heartbeat (ping/pong، بازاتصال بعد از ۳ pong از دست رفته) + replay اشتراک‌ها و `select_symbol`
- ✅ Kline تاریخی از REST + استریم زنده (interval جداگانه به‌ازای هر کلاینت)
- ✅ Multi-symbol (تمام جفت‌های USDT فعال Bybit — زنده کشف می‌شود، در حالت فعلی ۳۸۹ نماد — با انتخاب و جست‌وجو در لحظه)
- ✅ Render بهینه: لیست‌های بلند virtualized، batching تیکرها، اشتراک‌های گروهی، recomput اندیکاتورها با throttle

### میزکار و UX
- ✅ Watchlist با favorites (پیش‌فرض BTC/ETH/SOL/BNB/XRP) و جست‌وجو/فیلتر
- ✅ Layout قابل‌تغییر: پنل‌های resizable (drag handle) و collapsible، Auto-save در localStorage
- ✅ چیدمان واکنش‌گرا (desktop سه‌ستونه / موبایل با تب‌ها)
- ✅ علامت‌گذاری شفاف وضعیت اتصال: LIVE / STALE (بدون داده > ۲۰ ثانیه) / RECONNECTING / CONNECTING
- ✅ Alerts قیمتی (above/below) + موتور ارزیابی روی tickerها + Toast هنگام trigger
- ✅ Toast برای رویدادها (خطای اشتراک، فعال شدن alert، رویدادهای اتصال)
- ✅ میان‌برهای صفحه‌کلید (کلید `?` برای راهنما)

### کیفیت
- ✅ ۸۸ تست با node:test: بک‌اند (instruments/precision، معنای تیکر، چرخه عمر Hub و نشتی حافظه، bus)، پروتکل WS و REST گیت‌وی روی سرور واقعی، کلاینت WS (reconnect/replay/batching/gap)، store بازار، فرمت دقت/درصد، alerts/watchlist/layout/drawings
- ✅ lint (ESLint) و typecheck (tsc) و build بدون خطا

## میان‌برهای صفحه‌کلید

| کلید | عملکرد |
| --- | --- |
| `1`–`9` | تغییر تایم‌فریم |
| `F` | تمام‌صفحهٔ نمودار |
| `R` | ریست view / پرش به آخرین کندل |
| `V` | ابزار Crosshair (نشانگر) |
| `H` | ابزار خط افقی |
| `B` | ابزار خط عمودی |
| `T` | ابزار Trendline |
| `J` | ابزار Ray |
| `G` | ابزار Fibonacci |
| `M` | ابزار Measure |
| `L` / `K` | ابزار Long / Short Position |
| `Ctrl/⌘ Z` / `Ctrl/⌘ Y` | Undo / Redo رسم‌ها |
| `Del` | حذف رسم انتخاب‌شده |
| `Esc` | لغو ابزار / بستن دیالوگ |
| `?` | نمایش راهنما |

## محدودیت‌ها (شفاف)

- **بدون معامله:** این ترمینال تحلیل است، نه صرافی. موجودی، سفارش، پورتفوی و PnL حذف شده‌اند و ابزار Long/Short فقط روی نمودار رسم می‌شود.
- **رسم‌ها محلی‌اند:** در localStorage مرورگر و به‌ازای هر نماد ذخیره می‌شوند؛ هم‌گام‌سازی بین دستگاه یا اشتراک تیمی وجود ندارد.
- **اندیکاتورها فقط از منوی موجود:** overlay (SMA/EMA/Bollinger) و اسیلاتور (RSI/MACD) — دیگر اندیکاتورها اضافه نشده‌اند.
- **Alerts فقط در حافظه/دیتابیس محلی:** بدون push server-side؛ صرفاً تا زمانی که تب باز است (و در localStorage) ارزیابی می‌شوند.
- **تک‌صرافی (Bybit):** کلکتور Binance پیش‌نویس و غیرفعال است (Phase 2).
- **markPrice/indexPrice** از Bybit spot قابل دریافت نیستند و در Phase 1 اصلاً منتشر نمی‌شوند (فیلدهای رزروشده برای methodology چند-صرافی Phase 3).

## گام‌های بعدی

- فعال‌سازی کلکتور Binance و merge سطوح کتاب سفارش (Phase 2/3).
- Alerts سمت سرور با نوتیفیکیشن (persist در backend).
- استراتژی‌ها/backtest و ژورنال تحلیل (بدون اجرای سفارش).
- ذخیره‌سازی سرور برای watchlist/layout/رسم‌ها به‌صورت cross-device.
