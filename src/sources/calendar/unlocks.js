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
import { loadWatchState, activeDemotions, observedAround, retrospectiveLine, loadRecheckState, effectiveSourced } from './cadence-watch.js';
import { sourceIsStale, SOURCE_STALE_DAYS, pressureStage } from '../../core/unlock-promote.js';

const FILE = join(ROOT, 'unlocks.json');
// STAGE TIERING (coverage-session Part 3): at 25+ tracked tokens, un-tiered monthly
// unlocks emit up to 3 messages/day on top of everything else. Tier BEFORE bulk
// promotion. Negative lead = days AFTER the event (T+3 post-check). LOGGED rows are
// tracked, heartbeat-visible, never pushed. Stage assignments are PROVISIONAL until
// ADV matures (~Sep 7) — the row's note says so.
// T-7 IS THE MINIMUM every pushing row gets (operator ask: a week's notice). It was
// dropped when the tiers were first cut and restored on 2026-09-05; fixture asserts
// every non-LOGGED stage contains it. Sourced rows are STANDARD regardless of
// pressure — T-14 and T+3 assume observation a sourced row cannot make.
export const STAGES = { FULL: [14, 7, 3, 0, -3], STANDARD: [7, 3, 0], LOGGED: [] };
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
// lead < 0 (T+3) is RETROSPECTIVE: it can report what actually happened, including
// irregular emitters excluded from the forward falsifier. Predict the floor, report
// the total — same row, different claim per stage, both true.
export function claimCoverage(t, lead = 3) {
  if (t?.provenance === 'sourced') return {
    date: 'sourced', amount: 'sourced', scope: 'source',
    line: `Date and amount are ${t.source}'s published figures — not independently verified. Falsifier: the source itself, re-read weekly; silent after ${SOURCE_STALE_DAYS} days unrefreshed.`,
  };
  if (t?.enforcement === 'contract' && t?.clusterSpec) return {
    date: 'observed', amount: 'source-stated', scope: 'contract',
    line: `Date verified on-chain — contract-enforced: post-cliff claim clusters replayed on ${t.clusterSpec.hits}/${t.clusterSpec.n} past cliffs from the vesting contract. Amount is the schedule's stated tranche (claims vary by beneficiary). Falsifier: the next cliff's cluster; upgradeable proxy ${t.upgradeable ? 'YES — re-read scheduled' : 'no'}.`,
  };
  if (lead < 0 && (t?.cadence || t?.alsoObserve)) return {
    date: 'observed', amount: 'observed-actual', scope: 'retrospective',
    line: 'Retrospective: the figures below are on-chain observations of what moved, not a forward estimate.',
  };
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
  const rc = loadRecheckState();
  const sourced = tokens.filter((t) => !t.retired && t.provenance === 'sourced').map((t) => effectiveSourced(t, rc));
  const stale = sourced.filter((t) => !t.sourceDemoted && sourceIsStale(t));
  const sourceDemoted = sourced.filter((t) => t.sourceDemoted).length;
  const stages = {};
  for (const t of [...verified, ...sourced]) stages[t.stage ?? 'STANDARD'] = (stages[t.stage ?? 'STANDARD'] || 0) + 1;
  const c = {
    tracked: tokens.length,
    verified: verified.length,
    sourced: sourced.length,
    staleSourced: stale.length,
    belowFloor: sourced.filter((t) => t.stage !== 'LOGGED' && pressureStage(t) === 'LOGGED').length,
    estimated: tokens.filter((t) => !t.retired && !t.events?.length && t.provenance !== 'sourced').length,
    retired: tokens.filter((t) => t.retired).length,
    cadence: verified.filter((t) => t.cadence).length,
    contractCliff: verified.filter((t) => t.enforcement === 'contract').length,
    reviewBy: verified.filter((t) => t.reviewBy && !t.cadence).length,
    stages,
  };
  c.sourceDemoted = sourceDemoted;
  c.line = `Unlock coverage: ${c.tracked} tracked · ${c.verified} verified (${c.cadence} cadence-watched · ${c.contractCliff} contract-cliff · ${c.reviewBy} review-dated) · ${c.sourced} sourced${c.staleSourced ? ` (${c.staleSourced} STALE, silent)` : ''}${c.belowFloor ? ` (${c.belowFloor} below pressure floor, silent)` : ''}${sourceDemoted ? ` (${sourceDemoted} retracted by source)` : ''} · ${c.estimated} estimated (silent) · ${c.retired} retired · stages ${Object.entries(stages).map(([k, v]) => k + ':' + v).join(' ')} · verified reads are Ethereum/EVM only — sourced rows cite a named calendar and are not independently checked`;
  return c;
}

// SOURCED MESSAGE — visibly weaker than verified, by design. Different header icon
// (📅 vs 🔓) so the tier reads at a glance in a chat list; the source is NAMED in
// the title line; the amount is the SOURCE'S figure and says so; and the message
// states how long ago the source was last confirmed. Same prose discipline as every
// fact: no direction, no imperative, no frequency claim without n.
const EXPLORER = { ethereum: 'https://etherscan.io/token/', base: 'https://basescan.org/token/', bsc: 'https://bscscan.com/token/', arbitrum: 'https://arbiscan.io/token/', optimism: 'https://optimistic.etherscan.io/token/' };
export function sourcedMessage(t, ev, lead, now = new Date()) {
  const dateKey = new Date(ev.t * 1000).toISOString().slice(0, 10);
  const ageD = Math.max(0, Math.round((now - new Date(t.sourceFetchedAt)) / 86400e3));
  const pctUnlocked = t.maxSupply && t.circSupply != null ? Math.round(100 * t.circSupply / t.maxSupply) : null;
  const pctOfMax = t.maxSupply && ev.n ? (100 * ev.n / t.maxSupply) : null;
  const future = (t.sourceEvents || []).filter((e) => e.t * 1000 > now.getTime());
  const cats = [...new Set(future.flatMap((e) => String(e.cats || '').split('+')))].filter(Boolean);
  const kind = ev.type === 'linear' ? `linear tranche (${Math.round(ev.rd || 0)}d)` : 'cliff';
  const when = lead === 0 ? 'today' : `in ${lead} days`;
  const [chain, addr] = String(t.token || '').split(':');
  const explorer = EXPLORER[chain] && addr ? `${EXPLORER[chain]}${addr}` : null;
  const sourceName = t.source === 'defillama' ? 'DefiLlama' : t.source;
  return {
    title: `📅 UNLOCK LISTED · ${t.sym} — ${kind} ${when} (${dateKey})`,
    lines: [
      `fact · per ${sourceName}'s schedule — NOT independently verified`,
      `Source lists ${future.length} upcoming batch event${future.length === 1 ? '' : 's'}${cats.length ? ` (${cats.join(' / ')})` : ''}`,
      `This tranche: ~${Math.round(ev.n).toLocaleString()} ${t.sym} (source figure${pctOfMax != null ? `, ${pctOfMax.toFixed(2)}% of max supply` : ''})${pctUnlocked != null ? ` · ${pctUnlocked}% of supply unlocked to date` : ''}`,
      t.chain === 'unconfirmed' ? 'Chain: unconfirmed — no on-chain read has been attempted' : `Chain: ${t.chain}`,
      `Source last confirmed ${ageD === 0 ? 'today' : `${ageD} day${ageD === 1 ? '' : 's'} ago`} · goes silent if not re-confirmed within ${SOURCE_STALE_DAYS} days`,
      ...(t.sourceRevision ? [`Schedule ${t.sourceRevision.note} (recheck ${t.sourceRevision.at})`] : []),
    ],
    url: explorer ?? 'https://defillama.com/unlocks',
    dateKey,
  };
}

async function pushSourced(t, now) {
  let fired = 0;
  // Pressure floor applied at RUNTIME as an overlay (the row file keeps its single
  // writer): a sourced row whose tranches are below the derived floor, or are
  // farming/staking-only, is tracked but silent — LOGGED has no leads.
  const leads = leadsFor({ stage: pressureStage(t) });
  for (const ev of t.sourceEvents || []) {
    const target = new Date(ev.t * 1000);
    const daysOut = Math.round((target - now) / 86400e3);
    for (const lead of leads) {
      if (lead < 0 || daysOut !== lead) continue; // sourced rows never look backward
      const msg = sourcedMessage(t, ev, lead, now);
      if (await dispatch({
        source: 'CAL', type: 'UNLOCK',
        severity: 'MEDIUM',               // one band: a sourced notice carries no severity ladder
        key: `${t.sym}:${msg.dateKey}:${lead}:sourced`, cooldownMin: 2 * 24 * 60,
        title: msg.title, lines: msg.lines, url: msg.url,
      })) fired++;
    }
  }
  return fired;
}

export async function pollUnlocks() {
  if (Date.now() - lastPoll < CHECK_EVERY) return;
  lastPoll = Date.now();
  const sched = loadSchedule();
  if (!sched?.tokens?.length) return;

  const now = new Date();
  let fired = 0, staleSourced = 0;
  // Cadence overlay: a behavioural row whose watch window passed empty is demoted by
  // OBSERVATION, recorded in bot-owned data/ — unlocks.json keeps its single human
  // writer. A demotion is superseded only by a re-promotion with newer evidence.
  const demoted = activeDemotions(sched.tokens, loadWatchState());
  const recheck = loadRecheckState();
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
    // SOURCED tier: a named third party's schedule, pushed as a fact ABOUT THE
    // SOURCE, labelled, at STANDARD. Stops when the source has not been re-read in
    // 21 days — a stale source is a memory, not a source.
    if (t.provenance === 'sourced') {
      const eff = effectiveSourced(t, recheck);      // overlay: refreshed/revised/demoted
      if (eff.sourceDemoted) { estimatedSkipped++; continue; } // source retracted — silent
      if (sourceIsStale(eff, now.getTime())) { staleSourced++; continue; }
      fired += await pushSourced(eff, now);
      continue;
    }
    if (!Array.isArray(t.events) || !t.events.length) { estimatedSkipped++; continue; }
    // CONTRACT-CLIFF rows (route 2) carry a LIST of cliff dates, like sourced rows but
    // verified: each future cliff alerts on its own stages in the verified format.
    if (t.enforcement === 'contract' && Array.isArray(t.cliffDates)) {
      for (const c of t.cliffDates.filter((x) => x.cluster === null)) {
        const target = new Date(c.date + 'T00:00:00Z');
        const daysOut = Math.round((target - now) / 86400e3);
        for (const lead of leadsFor(t)) {
          if (lead < 0 || daysOut !== lead) continue;
          if (await dispatch({
            source: 'CAL', type: 'UNLOCK', severity: lead === 3 || lead === 0 ? 'HIGH' : 'MEDIUM',
            key: `${t.sym}:${c.date}:${lead}:cliff`, cooldownMin: 2 * 24 * 60,
            title: lead === 0 ? `${t.sym} contract cliff today — ${c.date}` : `${t.sym} contract cliff in ${lead} days — ${c.date}`,
            lines: [`${t.name || t.sym}: scheduled cliff on a vesting contract`, t.note ? `Context: ${t.note}` : 'Claims open on this date; beneficiaries pull individually over the following days.',
              'Fact only — no read on what claimants do with it.', `Verified — source: contract-cliff. ${claimCoverage(t, lead).line}`],
            url: t.contract ? `https://etherscan.io/address/${t.contract}` : undefined,
          })) fired++;
        }
      }
      continue;
    }
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
      // T+3 reports observed totals; if the read fails, it says so rather than
      // silently falling back to the forward floor (absence-of-observation rule).
      let retro = null;
      if (lead < 0 && (t.cadence || t.alsoObserve)) {
        const addrs = [...(t.cadence?.wallets?.map((w) => w.addr) ?? (t.cadence?.wallet ? [t.cadence.wallet] : [])), ...(t.alsoObserve ?? [])];
        const obs = addrs.length ? await observedAround(addrs, t.sym, dateKey, t.cadence?.graceDays ?? 3).catch(() => null) : null;
        retro = retrospectiveLine(obs, t.cadence);
      }
      const confidence = (Array.isArray(t.events) && t.events.length)
        ? `Verified — source: ${t.events[0].source}. ${claimCoverage(t, lead).line}${retro ? ' ' + retro : ''}`
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
  if (config.debug || fired) console.log(`[unlocks] ${sched.tokens.length} tracked${fired ? ` · ${fired} reminders sent · ${estimatedSkipped} estimated-only (silent, pending contract reads)` : ''}${cadenceDemoted ? ` · ${cadenceDemoted} cadence-demoted (silent until re-verified)` : ''}${staleSourced ? ` · ${staleSourced} sourced rows STALE (>${SOURCE_STALE_DAYS}d, silent until refreshed)` : ''}`);
}
