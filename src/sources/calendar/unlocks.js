// TOKEN UNLOCK REMINDERS — 7 days and 3 days ahead.
// Unlock APIs are all paywalled now (DefiLlama, CryptoRank Pro $4,750/yr,
// Tokenomist), so this reads a local schedule file harvested from the free
// public calendar at cryptorank.io/token-unlock.
// Most vesting contracts release on a fixed day each month, so entries use
// `monthlyDay` (recurring) — the file stays valid without constant refreshing.
// One-off entries can use `date: "YYYY-MM-DD"`.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from '../../config.js';
import { dispatch } from '../../core/dispatcher.js';

const FILE = join(ROOT, 'unlocks.json');
const LEAD_DAYS = [7, 3];          // ping windows
const CHECK_EVERY = 6 * 3600e3;    // re-evaluate every 6h
let lastPoll = 0;
let cache = null, cacheTs = 0;

function loadSchedule() {
  if (cache && Date.now() - cacheTs < 3600e3) return cache;
  if (!existsSync(FILE)) return null;
  try { cache = JSON.parse(readFileSync(FILE, 'utf8')); cacheTs = Date.now(); return cache; }
  catch (e) { console.error('[unlocks] bad unlocks.json:', e.message); return null; }
}

// Next occurrence of a monthly cliff (handles short months: day 31 -> last day)
function nextMonthlyDate(day, from = new Date()) {
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(day, lastDay)));
    if (target.getTime() >= from.setUTCHours(0, 0, 0, 0)) return target;
  }
  return null;
}

export async function pollUnlocks() {
  if (Date.now() - lastPoll < CHECK_EVERY) return;
  lastPoll = Date.now();
  const sched = loadSchedule();
  if (!sched?.tokens?.length) return;

  const now = new Date();
  let fired = 0;
  for (const t of sched.tokens) {
    const when = t.date ? new Date(t.date + 'T00:00:00Z') : (t.monthlyDay ? nextMonthlyDate(t.monthlyDay, new Date()) : null);
    if (!when) continue;
    const daysOut = Math.round((when - now) / 86400e3);

    for (const lead of LEAD_DAYS) {
      if (daysOut !== lead) continue;
      const dateKey = when.toISOString().slice(0, 10);
      const pct = t.pctOfMcap ? ` (~${t.pctOfMcap}% of market cap)` : '';
      const confidence = t.verified
        ? 'Date verified against the public unlock calendar.'
        : '⚠️ Recurring-schedule estimate — confirm the exact date on cryptorank.io/token-unlock.';
      if (await dispatch({
        source: 'CAL', type: 'UNLOCK',
        severity: lead === 3 ? 'HIGH' : 'MEDIUM',
        key: `${t.sym}:${dateKey}:${lead}`, cooldownMin: 2 * 24 * 60,
        title: `${t.sym} unlock in ${lead} days — ${dateKey}`,
        lines: [
          `${t.name || t.sym}: scheduled token unlock${pct}`,
          t.note ? `Context: ${t.note}` : 'Unlocks add sell-side supply; thin-liquidity tokens absorb it worst.',
          lead === 7
            ? 'Early warning — price often bleeds into the unlock as holders front-run it.'
            : '🔔 Close now — the days just before an unlock are where the drift usually shows.',
          confidence,
        ],
        url: `https://cryptorank.io/price/${(t.name || t.sym).toLowerCase().replace(/\s+/g, '-')}/vesting`,
      })) fired++;
    }
  }
  if (config.debug || fired) console.log(`[unlocks] ${sched.tokens.length} tracked${fired ? ` · ${fired} reminders sent` : ''}`);
}
