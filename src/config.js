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

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  pollIntervalSec: Number(process.env.POLL_INTERVAL || 60),
  cooldownMin: Number(process.env.ALERT_COOLDOWN_MIN || 30),
  dataDir: join(ROOT, 'data'),
  watchlistPath: join(ROOT, 'watchlist.json'),
};
