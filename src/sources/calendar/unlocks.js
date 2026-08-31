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
import { loadWatchState, activeDemotions } from './cadence-watch.js';

const FILE = join(ROOT, 'unlocks.json');
// STAGE TIERING (coverage-session Part 3): at 25+ tracked tokens, un-tiered monthly
// unlocks emit up to 3 messages/day on top of everything else. Tier BEFORE bulk
// promotion. Negative lead = days AFTER the event (T+3 post-check). LOGGED rows are
// tracked, heartbeat-visible, never pushed. Stage assignments are PROVISIONAL until
// ADV matures (~Sep 7) — the row's note says so.
export const STAGES = { FULL: [14, 3, 0, -3], STANDARD: [3, 0], LOGGED: [] };
export const leadsFor = (row) => STAGES[row?.stage ?? 'STANDARD'] ?? STAGES.STANDARD;
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

// Most recent PAST occurrence — negative leads (T+3) look backward, and the
// forward-only helper would otherwise make post-event stages structurally dead code.
export function lastMonthlyDate(day, from = new Date()) {
  const today = new Date(from).setUTCHours(0, 0, 0, 0);
  for (let i = 0; i >= -2; i--) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(day, lastDay)));
    if (target.getTime() <= today) return target;
  }
  return null;
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

// CLAIM COVERAGE — every claim in a message needs a falsifier that covers it, or an
// explicit note that it does not. DATE, AMOUNT, CADENCE and SCOPE are four separate
// claims and a falsifier usually covers one. EIGEN's gap (message claimed the family
// figure, spec watched one wallet) was found by accident because both numbers
// happened to sit in one report; this makes the mapping explicit for every row so the
// next mismatch is visible rather than lucky.
//
// Derived from row SHAPE, never stored — a stored coverage field would drift from the
// spec it describes, which is the same class of defect one level up.
export function claimCoverage(t) {
  const fam = Array.isArray(t?.cadence?.wallets) ? t.cadence.wallets.length : 0;
  if (fam) return {
    date: 'observed', amount: 'observed', scope: 'family',
    line: `Date and amount both observed on-chain — ${fam} custody wallets, each required to emit and the family total to land within ±${Math.round((t.cadence.tolerance ?? 0.25) * 100)}%, over ${t.cadence.monthsObserved} months. Auto-demotes if the pattern breaks.`,
  };
  if (t?.cadence) return {
    date: 'observed', amount: 'observed-partial', scope: 'tranche',
    line: `Date and amount observed on-chain for ONE custody wallet (${t.cadence.monthsObserved} months). Other holders may emit on the same date and are NOT covered by this figure — treat it as a floor, not a total. Auto-demotes if that wallet's pattern breaks.`,
  };
  if (t?.reviewBy) return {
    date: 'announced', amount: 'unchecked', scope: 'announcement',
    line: `Date is project-announced and re-attested by ${t.reviewBy} (the row demotes itself if that passes). The AMOUNT is announcement-stated — nothing observes it on-chain.`,
  };
  return { date: 'unknown', amount: 'unchecked', scope: 'unknown', line: 'Coverage unstated — this row should not be alerting.' };
}

// COVERAGE LINE — what the module knows and, crucially, what it CANNOT know. The
// bulk scan (29 Aug) established that unlock coverage is an Ethereum/EVM feature:
// 55 of 156 scanned symbols vest on their own chains, invisible from here. Absence
// of an unlock row must never read as "this token has no unlocks".
export function unlockCoverage(tokens = null) {
  if (!tokens) { const s = loadSchedule(); tokens = s?.tokens ?? []; }
  const verified = tokens.filter((t) => !t.retired && t.events?.length);
  const stages = {};
  for (const t of verified) stages[t.stage ?? 'STANDARD'] = (stages[t.stage ?? 'STANDARD'] || 0) + 1;
  const c = {
    tracked: tokens.length,
    verified: verified.length,
    estimated: tokens.filter((t) => !t.retired && !t.events?.length).length,
    retired: tokens.filter((t) => t.retired).length,
    cadence: verified.filter((t) => t.cadence).length,
    reviewBy: verified.filter((t) => t.reviewBy && !t.cadence).length,
    stages,
  };
  c.line = `Unlock coverage: ${c.tracked} tracked · ${c.verified} verified (${c.cadence} cadence-watched · ${c.reviewBy} review-dated) · ${c.estimated} estimated (silent) · ${c.retired} retired · stages ${Object.entries(stages).map(([k, v]) => k + ':' + v).join(' ')} · Ethereum/EVM only — tokens vesting on their own chains are out of scope, not unlocked`;
  return c;
}

export async function pollUnlocks() {
  if (Date.now() - lastPoll < CHECK_EVERY) return;
  lastPoll = Date.now();
  const sched = loadSchedule();
  if (!sched?.tokens?.length) return;

  const now = new Date();
  let fired = 0;
  // Cadence overlay: a behavioural row whose watch window passed empty is demoted by
  // OBSERVATION, recorded in bot-owned data/ — unlocks.json keeps its single human
  // writer. A demotion is superseded only by a re-promotion with newer evidence.
  const demoted = activeDemotions(sched.tokens, loadWatchState());
  let cadenceDemoted = 0;
  for (const t of sched.tokens) {
    if (demoted[t.sym]) { cadenceDemoted++; estimatedSkipped++; continue; } // alerts as nothing until re-verified
    // THREE-STATE DISCIPLINE (spec §4.2): only a VERIFIED DATE may alert — a date
    // read from the vesting contract or a project announcement, stored in
    // t.events[]. `monthlyDay` recurrences and pct-only rows are ESTIMATED:
    // logged, ranked for integration priority, never alerted. The module degrades
    // to silence, not to guessing — a 🔴 directive on an admitted guess was the
    // original defect here.
    if (t.retired) continue; // positive state, asserted at boot — never alert
    if (!Array.isArray(t.events) || !t.events.length) { estimatedSkipped++; continue; }
    const when = t.date ? new Date(t.date + 'T00:00:00Z') : (t.monthlyDay ? nextMonthlyDate(t.monthlyDay, new Date()) : null);
    const prev = t.date ? new Date(t.date + 'T00:00:00Z') : (t.monthlyDay ? lastMonthlyDate(t.monthlyDay, new Date()) : null);

    for (const lead of leadsFor(t)) {
      const target = lead >= 0 ? when : prev; // negative leads look BACKWARD
      if (!target) continue;
      const daysOut = Math.round((target - now) / 86400e3);
      if (daysOut !== lead) continue;
      const dateKey = target.toISOString().slice(0, 10);
      const pct = t.pctOfMcap ? ` (~${t.pctOfMcap}% of market cap)` : '';
      // Provenance stated precisely: an events[]-backed date says HOW it was verified
      // (contract read / announcement / on-chain backtest), not a generic calendar
      // claim. The first live push carried 'verified against the public unlock
      // calendar' on a date that had actually replayed ten times on-chain — underselling
      // the strongest evidence in the system.
      // Provenance CLASS matters, not just source: a contract read is a commitment
      // (enforced on-chain); a cadence read is a habit (custody can change it at
      // will). Both verify, but they fail differently — the message says which one
      // it is resting on instead of letting "verified" imply the stronger class.
      const confidence = (Array.isArray(t.events) && t.events.length)
        ? `Verified — source: ${t.events[0].source}. ${claimCoverage(t).line}`
        : t.verified
        ? 'Date verified against the public unlock calendar.'
        : '⚠️ Recurring-schedule estimate — confirm the exact date on cryptorank.io/token-unlock.';
      const stageLine = lead === 0 ? `${t.sym} unlock today — ${dateKey}`
        : lead < 0 ? `${t.sym} unlock T+${-lead} — event was ${dateKey}`
        : `${t.sym} unlock in ${lead} days — ${dateKey}`;
      if (await dispatch({
        source: 'CAL', type: 'UNLOCK',
        severity: lead === 3 || lead === 0 ? 'HIGH' : lead < 0 ? 'LOW' : 'MEDIUM',
        key: `${t.sym}:${dateKey}:${lead}`, cooldownMin: 2 * 24 * 60,
        title: stageLine,
        lines: [
          `${t.name || t.sym}: scheduled token unlock${pct}`,
          t.note ? `Context: ${t.note}` : 'Unlocks add sell-side supply; thin-liquidity tokens absorb it worst.',
          lead >= 7
            ? 'Added supply reaches the market on this date. No directional claim — the drift around unlocks has not been measured on this corpus.'
            : lead < 0
            ? 'Post-event check: emission was scheduled on the stated date. Fact only — no read on what it did.'
            : 'Emission is imminent. Fact only: what happens next is not something this system has earned an opinion about.',
          confidence,
        ],
        url: `https://cryptorank.io/price/${(t.name || t.sym).toLowerCase().replace(/\s+/g, '-')}/vesting`,
      })) fired++;
    }
  }
  if (config.debug || fired) console.log(`[unlocks] ${sched.tokens.length} tracked${fired ? ` · ${fired} reminders sent · ${estimatedSkipped} estimated-only (silent, pending contract reads)` : ''}${cadenceDemoted ? ` · ${cadenceDemoted} cadence-demoted (silent until re-verified)` : ''}`);
}
