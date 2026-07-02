# CEX pump detector (Binance / MEXC / Bybit)

Deliberately NOT built yet — discipline rule: no new features until the
DEX → Telegram pipeline works end-to-end in production.

When unlocked, each exchange gets a module here exporting `poll()` that
returns alerts in the dispatcher format ({source:'CEX', ...}).
