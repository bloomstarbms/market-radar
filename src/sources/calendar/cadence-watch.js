// CADENCE WATCH — the automatic falsifier for behavioural verification.
//
// A row verified by `onchain-cadence` rests on a HABIT, not a commitment: custody can
// change its distribution pattern at will. So every such row carries a machine-checkable
// spec (enforced by promoteRow + boot), and this module closes the loop: after each
// expected emission window passes, it reads the custody wallet's actual outflows.
// Window confirmed -> stamped (a watch whose confirmations aren't visible is a lapse
// indistinguishable from success). Window EMPTY -> the row is DEMOTED automatically and
// the operator is told. No human memory in the loop — the prose demote-trigger in a
// row note was the quarantine-lapse shape, fixed four times elsewhere in this project.
//
// Demotions live in data/cadence-watch.json as an OVERLAY, not edits to unlocks.json:
// the schedule file keeps a single writer class (humans via promote-unlock.js), and the
// bot records the observation that contradicts it. A re-promotion with a NEWER event
// date supersedes a standing demotion (the operator saw new evidence).
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, config } from '../../config.js';
import { broadcast } from '../../core/telegram.js';
import { formatAlert } from '../../core/dispatcher.js';

const STATE_FILE = join(ROOT, 'data', 'cadence-watch.json');
const CHECK_EVERY = 6 * 3600e3;
let lastPoll = 0;

export function loadWatchState() {
  try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { months: {}, demotions: {} }; }
  catch { return { months: {}, demotions: {} }; }
}
function saveWatchState(st) {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`; // per-PID: fixed tmp names raced once already
  writeFileSync(tmp, JSON.stringify(st, null, 1));
  renameSync(tmp, STATE_FILE);
}

// Expected emission date for a given month. Handles the two observed treasury shapes:
// monthEnd (EIGEN: day 30 clamping to short months) and fixed day with weekend
// roll-forward (ENA: the 6th, or Monday when the 6th is Sat/Sun — observed 3/3 times).
export function expectedEmissionDate(spec, year, month /* 1-based */) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let day = spec.monthEnd ? Math.min(spec.expectDay ?? last, last) : Math.min(spec.expectDay, last);
  let d = new Date(Date.UTC(year, month - 1, day));
  if (spec.roll === 'nextBusinessDay') {
    const wd = d.getUTCDay();
    if (wd === 6) d = new Date(d.getTime() + 2 * 86400e3);
    else if (wd === 0) d = new Date(d.getTime() + 86400e3);
  }
  return d;
}

// PURE decision for one row-month. Window = expected-1d .. expected+graceDays (3).
//
// VERIFY WHAT THE MESSAGE CLAIMS. The first spec watched ONE wallet while the alert
// asserted the FAMILY figure (~9.6M/mo for EIGEN, of which the watched metronome is
// 7.8M). If the second wallet stopped entirely, the primary would still clear its
// 50%-of-mean bar and the row would stay verified while actual distribution fell
// ~15% — an alert claiming a number nothing checks. So a family claim requires
// family verification: EVERY listed wallet must participate, and the family total
// must land inside a tolerance band. Per-wallet 50% catches a stopped wallet;
// the band catches a family-wide shortfall no single wallet reveals.
//
// spec.wallets: [{addr, meanAmount}] (family) — or legacy spec.wallet + meanAmount.
// outflows: {'YYYY-MM-DD': n} for a single-wallet spec, or {addr: {day: n}} for a
// family. Injected entirely — hermetic.
export function cadenceDecision(spec, year, month, now, outflows) {
  const expected = expectedEmissionDate(spec, year, month);
  const grace = spec.graceDays ?? 3;
  const start = new Date(expected.getTime() - 86400e3);
  const end = new Date(expected.getTime() + grace * 86400e3);
  if (now.getTime() <= end.getTime()) return { action: 'PENDING', windowEnd: end.toISOString().slice(0, 10) };
  const sKey = start.toISOString().slice(0, 10), eKey = end.toISOString().slice(0, 10);
  const window = `${sKey}..${eKey}`;
  const peakIn = (byDay) => {
    let day = null, amt = 0;
    for (const [d, v] of Object.entries(byDay || {})) if (d >= sKey && d <= eKey && v > amt) { day = d; amt = v; }
    return { day, amt };
  };

  const fam = Array.isArray(spec.wallets) && spec.wallets.length;
  if (!fam) {
    const { day, amt } = peakIn(outflows);
    if (amt >= spec.meanAmount * 0.5) return { action: 'CONFIRM', date: day, amount: Math.round(amt) };
    return { action: 'DEMOTE', window, largestSeen: Math.round(amt) };
  }

  const per = spec.wallets.map((w) => {
    const { day, amt } = peakIn((outflows || {})[w.addr]);
    return { addr: w.addr, day, amt, expected: w.meanAmount, ok: amt >= w.meanAmount * 0.5 };
  });
  const total = per.reduce((s, p) => s + p.amt, 0);
  const familyMean = spec.familyMean ?? spec.wallets.reduce((s, w) => s + w.meanAmount, 0);
  const band = spec.tolerance ?? 0.25;          // family total must be within ±25%
  const silent = per.filter((p) => !p.ok).map((p) => p.addr.slice(0, 10));
  const shortfall = total < familyMean * (1 - band);
  const detail = { window, familyTotal: Math.round(total), familyMean: Math.round(familyMean),
    perWallet: per.map((p) => ({ addr: p.addr.slice(0, 10), amt: Math.round(p.amt), ok: p.ok })) };
  if (silent.length === per.length) return { action: 'DEMOTE', ...detail, reason: 'no wallet in the family emitted' };
  // PARTIAL: the schedule did not stop, but the FAMILY FIGURE THE MESSAGE CLAIMS is
  // no longer supported. Treated as a demotion (the claim fails) with its own reason,
  // because staying verified would keep asserting a number that just went unverified.
  if (silent.length) return { action: 'PARTIAL', ...detail, silent, reason: `wallet(s) ${silent.join(', ')} did not emit` };
  if (shortfall) return { action: 'PARTIAL', ...detail, reason: `family total ${Math.round(total).toLocaleString()} is below the ${Math.round(familyMean * (1 - band)).toLocaleString()} floor` };
  return { action: 'CONFIRM', date: per.map((p) => p.day).sort()[0], amount: Math.round(total), familyTotal: Math.round(total), perWallet: detail.perWallet };
}

// Evidence gate: a demotion may only be decided on a fetch that actually REACHED the
// window (covered) — network failure or a truncated fetch is "we did not look", which
// the first bootstrap run proved will otherwise manufacture a false demotion.
export function windowObserved(fetched) {
  return fetched !== null && fetched !== undefined && fetched.covered === true;
}

// A demotion stands unless the row's newest event POST-DATES it (operator re-promoted
// on new evidence). Pure; unlocks.js consults this before alerting.
export function activeDemotions(tokens, state) {
  const out = {};
  for (const [sym, dem] of Object.entries(state?.demotions || {})) {
    const row = (tokens || []).find((t) => t.sym === sym);
    const newest = row?.events?.map((e) => e.date).sort().pop() ?? null;
    if (newest && newest > dem.at.slice(0, 10)) continue; // superseded
    out[sym] = dem;
  }
  return out;
}

// Pagination is DATE-SPAN-DRIVEN (fetch until the window start is covered), because a
// page cap on a busy ops wallet truncates silently: the first bootstrap run fetched 3
// pages of the ENA treasury, saw 22 days of noise, and DEMOTED a row whose qualifying
// emission sat one week deeper — a false demotion manufactured by a fetch limit. Same
// lesson detect-cadence.js learned the same day. `covered` reports whether the fetch
// actually reached past `untilDate`; the caller treats uncovered as NO EVIDENCE.
async function fetchOutflows(wallet, sym, untilDate, maxPages = 20) {
  const byDay = {};
  let next = '', oldest = null;
  for (let p = 0; p < maxPages; p++) {
    let j = null;
    try { const r = await fetch(`https://eth.blockscout.com/api/v2/addresses/${wallet}/token-transfers?filter=from${next}`); j = await r.json(); } catch { return null; }
    for (const t of (j?.items || [])) {
      const d = (t.timestamp || '').slice(0, 10);
      if (d && (!oldest || d < oldest)) oldest = d;
      if ((t.token?.symbol || '') !== sym) continue;
      if (d) byDay[d] = (byDay[d] || 0) + Number(t.total?.value || 0) / 10 ** Number(t.total?.decimals ?? 18);
    }
    if (!j?.next_page_params) return { byDay, covered: true }; // full history exhausted
    if (oldest && oldest < untilDate) return { byDay, covered: true };
    next = '&' + Object.entries(j.next_page_params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    await new Promise((r) => setTimeout(r, 250));
  }
  return { byDay, covered: false }; // page cap hit before reaching the window
}

// Impure poll. Checks each cadence-verified row once per closed window; network only
// when a window has NEWLY closed. Demotion is recorded FIRST (the observation stands
// whether or not the message sends), then the operator DM retries until delivered.
export async function pollCadence(loadTokens) {
  if (Date.now() - lastPoll < CHECK_EVERY) return;
  lastPoll = Date.now();
  let tokens = null;
  try { tokens = loadTokens ? loadTokens() : JSON.parse(readFileSync(join(ROOT, 'unlocks.json'), 'utf8')).tokens; } catch { return; }
  if (!Array.isArray(tokens)) return;
  const st = loadWatchState();
  const now = new Date();
  let dirty = false;

  // Check the previous month too: a restart that straddles a window close would
  // otherwise skip that window FOREVER once the month key rolls — a missed check
  // indistinguishable from a passed one.
  const monthsToCheck = [-1, 0].map((off) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + off, 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, mKey: d.toISOString().slice(0, 7) };
  });
  const today = now.toISOString().slice(0, 10);
  for (const t of tokens) {
    if (!t || t.retired || !Array.isArray(t.events) || !t.events.length) continue;
    // Dead-man's switch: a behavioural row WITHOUT observable emissions carries
    // reviewBy instead of a cadence spec. Past the date with no re-promotion, the row
    // demotes itself — the ZRO Sep 20 trigger, structural instead of prose. No
    // network needed: the calendar is the evidence.
    if (t.reviewBy && !t.cadence && t.reviewBy < today && !st.demotions[t.sym]) {
      st.demotions[t.sym] = { at: now.toISOString().slice(0, 16), type: 'review-expired', reviewBy: t.reviewBy };
      dirty = true;
    }
    const dem = st.demotions[t.sym];
    if (dem?.type === 'review-expired' && !dem.notified && activeDemotions([t], st)[t.sym]) {
      const ids = await broadcast(formatAlert({
        source: 'SYS', type: 'CADENCE', severity: 'MEDIUM',
        title: `${t.sym} unlock row auto-demoted — review date passed`,
        lines: [
          `Coverage change, not a market event: this schedule is not contract-enforced and has no observable emission cadence, so its verification carried a review deadline (${t.reviewBy}). The deadline passed without re-promotion.`,
          `Operator: re-verify the schedule and re-promote with fresh evidence, or let it stand estimated.`,
        ],
      }), { toChannel: false });
      if (ids.length) { dem.notified = true; dirty = true; }
    }
    if (!t.cadence) continue;
    st.months[t.sym] = st.months[t.sym] || {};
    // Windows predating the promotion itself are not evidence about the promotion.
    const cadEvents = t.events.filter((e) => e.source === 'onchain-cadence').map((e) => e.date).sort();
    const promotedAt = cadEvents[0] ?? t.events.map((e) => e.date).sort().pop();
    for (const { y, m, mKey } of monthsToCheck) {
    const rec = st.months[t.sym][mKey];
    if (rec && (rec.action !== 'DEMOTE' || rec.notified)) continue; // month settled
    if (!rec) {
      const pending = cadenceDecision(t.cadence, y, m, now, {});
      if (pending.action === 'PENDING') continue; // window still open — no fetch, no record
      if (promotedAt && mKey < promotedAt.slice(0, 7)) continue; // window pre-dates the promotion
      const windowStart = new Date(expectedEmissionDate(t.cadence, y, m).getTime() - 86400e3).toISOString().slice(0, 10);
      // Family specs need every wallet fetched; ANY uncovered fetch aborts the whole
      // decision — a partial view of a family would read as a silent wallet.
      const addrs = Array.isArray(t.cadence.wallets) ? t.cadence.wallets.map((w) => w.addr) : [t.cadence.wallet];
      const byAddr = {};
      let allCovered = true;
      for (const a of addrs) {
        const f = await fetchOutflows(a, t.sym, windowStart);
        if (!windowObserved(f)) { allCovered = false; break; }
        byAddr[a] = f.byDay;
      }
      if (!allCovered) continue; // "we did not look" must never demote — retry next poll
      const dec = cadenceDecision(t.cadence, y, m, now, Array.isArray(t.cadence.wallets) ? byAddr : byAddr[addrs[0]]);
      st.months[t.sym][mKey] = { ...dec, at: now.toISOString().slice(0, 16) };
      // PARTIAL demotes too: the family figure the message claims went unverified,
      // and a row that keeps asserting an unverified number is the defect.
      if (dec.action === 'DEMOTE' || dec.action === 'PARTIAL') {
        st.demotions[t.sym] = { at: now.toISOString().slice(0, 16), month: mKey, window: dec.window, kind: dec.action };
      }
      dirty = true;
    }
    const cur = st.months[t.sym][mKey];
    if ((cur.action === 'DEMOTE' || cur.action === 'PARTIAL') && !cur.notified) {
      const evidence = cur.action === 'PARTIAL'
        ? `${cur.reason}. Family total ${cur.familyTotal.toLocaleString()} vs ${cur.familyMean.toLocaleString()} expected (${cur.perWallet.map((p) => `${p.addr} ${p.amt.toLocaleString()}${p.ok ? '' : ' ✗'}`).join(' · ')}).`
        : `The ${cur.window} window showed no qualifying outflow${cur.largestSeen !== undefined ? ` (largest seen: ${cur.largestSeen.toLocaleString()})` : ` (${cur.reason})`}.`;
      const ids = await broadcast(formatAlert({
        source: 'SYS', type: 'CADENCE', severity: 'MEDIUM',
        title: `${t.sym} unlock row auto-demoted — ${cur.action === 'PARTIAL' ? 'family emission no longer matches the claim' : 'cadence window passed empty'}`,
        lines: [
          `Coverage change, not a market event: the ${t.sym} schedule was inferred from observed custody emissions. ${evidence}`,
          `Behavioural verification is a habit, not a commitment — the row no longer alerts as verified.`,
          `Operator: rerun node detect-cadence.js ${t.sym}; re-promote only on fresh evidence.`,
        ],
      }), { toChannel: false });
      if (ids.length) { st.months[t.sym][mKey].notified = true; dirty = true; }
    }
    } // monthsToCheck
  }
  if (dirty) saveWatchState(st);
}

// Heartbeat line. A watch that silently stops watching is the failure mode this module
// exists to prevent — so its own liveness is on the operator channel.
export function cadenceStatus(tokens = null, state = loadWatchState(), now = new Date()) {
  if (tokens === null) {
    try { tokens = JSON.parse(readFileSync(join(ROOT, 'unlocks.json'), 'utf8')).tokens; } catch { tokens = []; }
  }
  const watched = (tokens || []).filter((t) => (t?.cadence || t?.reviewBy) && !t.retired);
  if (!watched.length) return { line: 'Cadence watch: no behavioural rows', demoted: [] };
  const demoted = Object.keys(activeDemotions(tokens, state));
  const parts = watched.map((t) => {
    if (demoted.includes(t.sym)) return `${t.sym} 🚨 demoted`;
    if (!t.cadence) {
      // A switch that fires without warning turns demotion into a discovery instead
      // of a decision (restore-drill lesson): escalate T-14 ⚠️, T-3 🚨.
      const daysLeft = Math.ceil((new Date(t.reviewBy + 'T00:00:00Z') - now) / 86400e3);
      const mark = daysLeft <= 3 ? ' 🚨 re-attest now or the row demotes itself' : daysLeft <= 14 ? ' ⚠️ review approaching' : '';
      return `${t.sym} review by ${t.reviewBy} (${daysLeft}d)${mark}`;
    }
    const months = state.months?.[t.sym] || {};
    const confirmed = Object.entries(months).filter(([, r]) => r.action === 'CONFIRM').map(([m]) => m).sort();
    const lastOk = confirmed.pop();
    const ageD = lastOk ? Math.round((now - new Date(lastOk + '-01')) / 86400e3) : null;
    return `${t.sym} ${lastOk ? `ok ${lastOk}` : 'no window closed yet'}${ageD !== null && ageD > 65 ? ' ⚠️ stale confirm' : ''}`;
  });
  return { line: `Cadence watch: ${parts.join(' · ')}`, demoted };
}
