# Market Radar

Unified crypto alert platform delivered by one Telegram bot:

- 🟢 DEX dormant-token revival (watchlist, DexScreener)
- 🚨 Liquidity-pull (rug) alarms on watchlist tokens
- 🚀📉👀 CEX pump / sell-off / stealth-volume across Binance, MEXC, Bybit, Gate, KuCoin, Bitget (fast ~5min + slow 1h windows)
- 🆕 New-listing detection on all six exchanges
- ⚡ Funding-rate extremes on Binance perps (squeeze setups)
- 🐋 On-chain whale transfers (Etherscan V2 + Helius)
- 📊 Outcome tracker: every alert is scored at +1h/+6h/+24h — send /stats to the bot
- 💓 Daily heartbeat so you know it's alive

## Quick start

1. Node 18+ required. No npm install — zero dependencies.
2. Create a bot with @BotFather on Telegram, copy the token.
3. `cp .env.example .env` and paste the token into TELEGRAM_BOT_TOKEN.
4. Edit `watchlist.json` — add the dormant tokens you want to monitor
   (chainId + token address, as used on dexscreener.com).
5. Optional: add free ETHERSCAN_API_KEY / HELIUS_API_KEY to enable whale alerts.
6. `npm start`
7. Open your bot in Telegram and send `/start` to subscribe.

Run `npm run once` for a single poll cycle (good for testing).
Without a token it runs console-only and prints alerts to stdout.

## Signals

### 🟢 DEX revival (watchlist tokens, via DexScreener)

| Signal | Rule |
|---|---|
| Volume spike | 1h volume ≥ 3× the 24h hourly average |
| Price move | ≥ +10% in 1h |
| Txn surge | 1h txns ≥ 3× the 24h hourly average |
| Liquidity add | ≥ +20% vs rolling baseline |

Thresholds: `src/sources/dex/revival.js`

### 🚀📉👀 CEX (all USDT spot pairs on Binance, MEXC, Bybit)

| Alert | Rule |
|---|---|
| 🚀 Pump | price ≥ +5% across the ~5 min window (+10% = big) |
| 📉 Sell-off | price ≤ −5% across the window (−10% = big) |
| 👀 Unusual volume | window volume ≥ 10× normal with flat price — quiet accumulation/distribution |

Pairs under $200K 24h volume are ignored. Thresholds: `src/sources/cex/pump.js`

### 🐋 Whale transfers (watchlist tokens, on-chain, optional)

Alerts when a single transfer exceeds **min($1M, 20% of pair liquidity)** — so
dormant low-liquidity tokens still trigger. Direction is tagged best-effort
against known exchange hot wallets:

- **→ exchange deposit** = possible incoming sell-off (HIGH)
- **← exchange withdrawal** = possible accumulation (MEDIUM)
- wallet → wallet = watch for follow-up (LOW)

EVM chains use a free [Etherscan V2 key](https://etherscan.io/apis) (one key,
all chains); Solana uses a free [Helius key](https://helius.dev). Extend the
exchange-wallet labels in `src/sources/chain/whale.js`.

Severity: 🟡 LOW / 🟠 MEDIUM / 🔴 HIGH. Per-key cooldown (default 30 min)
prevents alert spam.

## Architecture

```
src/
  index.js            entry: scheduler + bot
  config.js           .env loader
  core/
    dispatcher.js     ONE alert path for all sources
    telegram.js       bot (subscribe via /start) + broadcast
    store.js          JSON state: subscribers, baselines, cooldowns
  sources/
    dex/              DexScreener poll + revival rules
    cex/              exchange fetchers + pump/dump/volume rules
    chain/            whale-transfer monitor (Etherscan V2 + Helius)
```
