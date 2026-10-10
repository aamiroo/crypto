# Phase 1 — Market Terminal: Architecture Decisions & WS Protocol

## 1. تصمیم‌های معماری قبل از پیاده‌سازی

قبل از کد، چند نکته که نیاز به تصمیم داشتند:

**۱. یک NATS subject tree واحد برای همه صرافی‌ها یا جدا؟**
تصمیم: subject بر اساس `market.<venue>.<symbol>.<channel>` (مثل `market.binance.BTCUSDT.orderbook`).
این کار baseline-per-venue را حفظ می‌کند و Gateway می‌تواند بعداً یک "aggregated" stream هم بسازد (برای Index Price) بدون اینکه ساختار داده صرافی خاص را از دست بدهد.

**۲. Order Book: full snapshot هر بار یا snapshot + delta؟**
تصمیم: snapshot + delta با sequence number، دقیقاً طبق چیزی که خواستی. صرافی‌ها (Binance/Bybit) خودشان همین مدل را در API‌شان دارند، پس Normalizer فقط قالب را یکسان می‌کند، منطق re-sync را از new می‌سازیم چون نمی‌توانیم به sequence خود Binance به عنوان source of truth داخلی تکیه کنیم (چون بعداً می‌خواهیم چند صرافی را merge کنیم).

**۳. Sequence number از کجا صادر می‌شود؟**
تصمیم: Gateway (نه صرافی بیرونی) sequence داخلی خودش را per-symbol-per-channel تولید می‌کند. یعنی وقتی داده از NATS به Gateway می‌رسد، Gateway شماره‌گذاری می‌کند و به کلاینت می‌فرستد. این باعث می‌شود اگر بعداً منبع داده عوض شد (مثلاً چند صرافی merge شد)، پروتکل کلاینت دست‌نخورده بماند.

**۴. Reconnect/Resync logic کجا زندگی کند؟**
تصمیم: تمام منطق resync سمت کلاینت (Frontend) است؛ سرور فقط statless snapshot+delta می‌فرستد. کلاینت اگر gap در sequence دید، دوباره `subscribe` می‌زند و منتظر `snapshot` تازه می‌ماند.

## 2. WebSocket Protocol (Gateway ⇄ Frontend)

تمام پیام‌ها JSON با envelope یکسان هستند:

```json
{
  "type": "string",
  "channel": "string",
  "symbol": "string",
  "seq": 12345,
  "ts": 1717000000000,
  "data": { }
}
```

### Client → Server

**subscribe**
```json
{
  "type": "subscribe",
  "channels": [
    { "channel": "orderbook", "symbol": "BTCUSDT", "depth": 25 },
    { "channel": "trades", "symbol": "BTCUSDT" },
    { "channel": "kline", "symbol": "BTCUSDT", "interval": "1m" },
    { "channel": "ticker", "symbol": "BTCUSDT" }
  ]
}
```

**unsubscribe** — همان شکل subscribe.

**ping** — `{ "type": "ping" }` هر ۱۵ ثانیه از کلاینت؛ سرور با `pong` جواب می‌دهد. اگر ۳ بار پشت‌سرهم pong نیامد، کلاینت reconnect می‌زند.

### Server → Client

**orderbook_snapshot** (شروع هر subscription یا بعد از gap)
```json
{
  "type": "orderbook_snapshot",
  "channel": "orderbook",
  "symbol": "BTCUSDT",
  "seq": 88210,
  "ts": 1717000000000,
  "data": {
    "bids": [["65000.5", "0.421"], ["65000.0", "1.200"]],
    "asks": [["65001.0", "0.300"], ["65001.5", "0.900"]]
  }
}
```

سرور این snapshot را از کتاب سفارش نگه‌داشته‌ی خودش و با **seq لحظه‌ای** بازسازی می‌کند (نه snapshot قدیمی صرافی)؛ بنابراین اولین delta بعد از آن همیشه `seq + 1` است و کتاب مشترک جدید از همان لحظه سازگار می‌ماند.

**orderbook_delta** (بعد از snapshot، seq باید دقیقا `prev.seq + 1` باشد)
```json
{
  "type": "orderbook_delta",
  "channel": "orderbook",
  "symbol": "BTCUSDT",
  "seq": 88211,
  "ts": 1717000000123,
  "data": {
    "bids": [["65000.5", "0.000"]],
    "asks": [["65001.0", "0.550"]]
  }
}
```
قیمت با size = "0.000" یعنی آن سطح قیمت حذف شود.

**trade**
```json
{
  "type": "trade",
  "channel": "trades",
  "symbol": "BTCUSDT",
  "seq": 4471,
  "ts": 1717000000456,
  "data": { "id": "t-9981", "price": "65000.5", "size": "0.02", "side": "buy" }
}
```

**kline**
```json
{
  "type": "kline",
  "channel": "kline",
  "symbol": "BTCUSDT",
  "seq": 1029,
  "ts": 1717000000456,
  "data": {
    "interval": "1m", "openTime": 1717000000000, "closeTime": 1717000059999,
    "open": "64990.0", "high": "65010.0", "low": "64980.0", "close": "65000.5",
    "volume": "12.44", "closed": false
  }
}
```

**ticker**
```json
{
  "type": "ticker",
  "channel": "ticker",
  "symbol": "BTCUSDT",
  "seq": 771,
  "ts": 1717000000456,
  "data": {
    "lastPrice": "65000.5",
    "indexPrice": "64998.2",
    "markPrice": "64999.0",
    "change24h": "1.32",
    "high24h": "65900.0",
    "low24h": "63800.0",
    "volume24h": "18211.5"
  }
}
```
(در Phase 1 markPrice/indexPrice صرفاً به عنوان placeholder از last price venue اصلی محاسبه می‌شود؛ methodology واقعی چند-صرافی در Phase 3 اضافه می‌شود، ولی فیلدها را از همین الان جدا نگه می‌داریم که schema بعداً عوض نشود.)

**error**
```json
{ "type": "error", "data": { "code": "UNKNOWN_SYMBOL", "message": "..." } }
```

## 3. منطق Sequence Recovery (سمت کلاینت)

1. برای هر `(channel, symbol[, interval])` یک `lastSeq` نگه دار (برای kline، interval هم بخشی از کلید است — sequence به‌ازای هر interval جدا صادر می‌شود).
2. وقتی پیام جدید رسید: اگر `msg.seq !== lastSeq + 1` و پیام از نوع snapshot نبود → یعنی gap افتاده.
3. در آن حالت: بلافاصله دوباره `subscribe` بزن (سرور یک `orderbook_snapshot` تازه می‌فرستد) و بافر delta های بینابین را دور بریز.
4. `orderbook_snapshot` همیشه lastSeq را reset می‌کند، صرف نظر از مقدار قبلی.

## 4. جریان داده داخلی (Collector → EventBus → Gateway)

**پیاده‌سازی فعلی (Phase 1) — تک‌پروسسی، بدون NATS/Redis:**

```
Bybit WS ──> Collector (نرمالایز) ──> EventBus درون‌پروسسی
                                       subject: market.<venue>.<symbol>.<channel>
                                                │
                                                ▼
                                    Gateway (همین پروسه):
                                    - ثبت listener به‌ازای هر subject
                                    - اختصاص sequence داخلی per (symbol, channel, interval)
                                    - نگهداری کتاب سفارش برای rebuild snapshot مشترکان جدید
                                    - fan-out به WS کلاینت‌ها
```

EventBus از همان قرارداد subject NATS استفاده می‌کند (`bus.js`)؛ یعنی در Phase 2 می‌توان بدون تغییر سمت Collector/Gateway آن را با NATS JetStream جایگزین کرد.

**نقشه راه باقی‌مانده:**

- **NATS JetStream (Phase 2):** زمانی که Gateway و Collector از هم جدا شدند یا scale افقی لازم شد.
- **Redis (Phase 2):** فقط برای **caching آخرین order book snapshot** — تا وقتی Gateway جدید بالا می‌آید یا کلاینت تازه وصل می‌شود، لازم نباشد صبر کند تا صرافی دوباره snapshot بفرستد. Redis منبع حقیقت نیست، صرفاً hot cache است — طبق اصل شماره ۳. در Phase 1 این نقش را همان کش in-memory در `Hub` انجام می‌دهد.
- **Merge چند صرافی (Phase 3):** تا این مرحله ترتیب sequence بر اساس **یک** صرافی صادر می‌شود؛ فعال‌سازی هم‌زمان چند صرافی نیازمند merge سطوح کتاب سفارش و بازتعریف sequence است.
