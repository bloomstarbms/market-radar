# CEX pump detector

Monitors USDT spot pairs on Binance, MEXC, and Bybit via public APIs (no keys).

- `exchanges.js` — normalized 24h-ticker fetchers per exchange
- `pump.js` — rolling snapshot buffer + pump rules (price jump, volume surge)
- `monitor.js` — poll loop, sends alerts through the shared dispatcher

Tune thresholds in `pump.js` (RULES). Disable exchanges via CEX_EXCHANGES in .env.
