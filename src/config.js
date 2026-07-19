import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (zero-dependency)
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

export const VERSION = '0.7.0';

export const config = {
  minSeverity: ['LOW','MEDIUM','HIGH'].includes((process.env.ALERT_MIN_SEVERITY || 'LOW').toUpperCase())
    ? (process.env.ALERT_MIN_SEVERITY || 'LOW').toUpperCase() : 'LOW',
  debug: ['1','true','yes'].includes((process.env.DEBUG || '').toLowerCase()),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  pollIntervalSec: Number(process.env.POLL_INTERVAL || 60),
  cooldownMin: Number(process.env.ALERT_COOLDOWN_MIN || 30),
  cexExchanges: (process.env.CEX_EXCHANGES ?? 'binance,mexc,bybit,gate,kucoin,bitget')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  heartbeatHours: Number(process.env.HEARTBEAT_HOURS ?? 24),
  etherscanKey: process.env.ETHERSCAN_API_KEY || '',
  heliusKey: process.env.HELIUS_API_KEY || '',
  arkhamKey: process.env.ARKHAM_API_KEY || '',
  moralisKey: process.env.MORALIS_API_KEY || '',
  coinmarketcalKey: process.env.COINMARKETCAL_API_KEY || '',
  dataDir: join(ROOT, 'data'),
  watchlistPath: join(ROOT, 'watchlist.json'),
};
