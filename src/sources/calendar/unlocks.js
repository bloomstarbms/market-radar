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
let estimatedSkipped = 0;
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
    // THREE-STATE DISCIPLINE (spec §4.2): only a VERIFIED DATE may alert — a date
    // read from the vesting contract or a project announcement, stored in
    // t.events[]. `monthlyDay` recurrences and pct-only rows are ESTIMATED:
    // logged, ranked for integration priority, never alerted. The module degrades
    // to silence, not to guessing — a 🔴 directive on an admitted guess was the
    // original defect here.
    if (t.retired) continue; // positive state, asserted at boot — never alert
    if (!Array.isArray(t.events) || !t.events.length) { estimatedSkipped++; continue; }
    const when = t.date ? new Date(t.date + 'T00:00:00Z') : (t.monthlyDay ? nextMonthlyDate(t.monthlyDay, new Date()) : null);
    if (!when) continue;
    const daysOut = Math.round((when - now) / 86400e3);

    for (const lead of LEAD_DAYS) {
      if (daysOut !== lead) continue;
      const dateKey = when.toISOString().slice(0, 10);
      const pct = t.pctOfMcap ? ` (~${t.pctOfMcap}% of market cap)` : '';
      // Provenance stated precisely: an events[]-backed date says HOW it was verified
      // (contract read / announcement / on-chain backtest), not a generic calendar
      // claim. The first live push carried 'verified against the public unlock
      // calendar' on a date that had actually replayed ten times on-chain — underselling
      // the strongest evidence in the system.
      const confidence = (Array.isArray(t.events) && t.events.length)
        ? `Date verified — source: ${t.events[0].source}.`
        : t.verified
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
            ? 'Added supply reaches the market on this date. No directional claim — the drift around unlocks has not been measured on this corpus.'
            : 'Emission is imminent. Fact only: what happens next is not something this system has earned an opinion about.',
          confidence,
        ],
        url: `https://cryptorank.io/price/${(t.name || t.sym).toLowerCase().replace(/\s+/g, '-')}/vesting`,
      })) fired++;
    }
  }
  if (config.debug || fired) console.log(`[unlocks] ${sched.tokens.length} tracked${fired ? ` · ${fired} reminders sent · ${estimatedSkipped} estimated-only (silent, pending contract reads)` : ''}`);
}
