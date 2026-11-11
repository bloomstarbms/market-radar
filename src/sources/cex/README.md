<!-- PREMISE
Written against: v0.37.21
Tracks: live
Reviewed: 2026-08-29
Assumes:
- Module-local doc: describes the files in this directory only.
- PUMP and DUMP are LADDER-RETIRED (measured, disabled — 22 of 30 PUMP-HIGH
  reverted within 24h, n=30). This README describes machinery that is still
  present and instrumented but does NOT push. Do not read it as live behaviour.
- The live fact-emitting modules in this directory are listings, announcements,
  funding, coinbase, upbit, perp-watch and tradfi, not pump.
-->

# CEX pump detector

Monitors USDT spot pairs on Binance, MEXC, and Bybit via public APIs (no keys).

- `exchanges.js` — normalized 24h-ticker fetchers per exchange
- `pump.js` — rolling snapshot buffer + pump rules (price jump, volume surge)
- `monitor.js` — poll loop, sends alerts through the shared dispatcher
- `perp-watch.js` — Bybit linear and Binance USD-M instrument lists (60 s, persisted
  baseline, shrink guard): new perps as PERP facts, stock/ETF contracts to `tradfi.js`
- `tradfi.js` — TradFi perps, their own category: at most 5 messages a UTC day, the
  rest in one digest line; never tier-1, no outcomes row

Tune thresholds in `pump.js` (RULES). Disable exchanges via CEX_EXCHANGES in .env.
