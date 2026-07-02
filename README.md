# Market Radar

Unified crypto alert platform: DEX dormant-token revival signals + CEX pump
detection (coming), delivered by one Telegram bot.

## Quick start

1. Node 18+ required. No npm install — zero dependencies.
2. Create a bot with @BotFather on Telegram, copy the token.
3. `cp .env.example .env` and paste the token into TELEGRAM_BOT_TOKEN.
4. Edit `watchlist.json` — add the dormant tokens you want to monitor
   (chainId + token address, as used on dexscreener.com).
5. `npm start`
6. Open your bot in Telegram and send `/start` to subscribe.

Run `npm run once` for a single poll cycle (good for testing).
Without a token it runs console-only and prints alerts to stdout.

## Signals (DEX revival)

| Signal | Rule |
|---|---|
| Volume spike | 1h volume ≥ 3× the 24h hourly average |
| Price move | ≥ +10% in 1h |
| Txn surge | 1h txns ≥ 3× the 24h hourly average |
| Liquidity add | ≥ +20% vs rolling baseline |

Severity: 1 signal = 🟡 LOW, 2 = 🟠 MEDIUM, 3+ = 🔴 HIGH.
Per-token cooldown (default 30 min) prevents alert spam.
Thresholds live in `src/sources/dex/revival.js` (RULES).

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
    cex/              stub — unlocked after DEX pipeline ships
```
