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
    // ratio: where in the band this landed. CONFIRM/DEMOTE alone discards it, and
    // eleven observations AT the mean vs eleven trending +20% are different facts —
    // only one of them says the schedule is changing. Compared like with like: the
    // spec mean is derived from PEAK DAY per month, so the ratio uses peak day, not
    // the window sum (mixing those was a units error waiting to happen).
    if (amt >= spec.meanAmount * 0.5) return { action: 'CONFIRM', date: day, amount: Math.round(amt), ratio: +(amt / spec.meanAmount).toFixed(3) };
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
  return { action: 'CONFIRM', date: per.map((p) => p.day).sort()[0], amount: Math.round(total), familyTotal: Math.round(total), ratio: +(total / familyMean).toFixed(3), perWallet: detail.perWallet };
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

// RETROSPECTIVE OBSERVATION for the T+3 stage. Forward stages claim a predictable
// floor; this reports what actually moved — including irregular emitters that must
// stay OUT of the cadence band (they would false-demote a quiet month) but belong in
// a backward-looking total. Returns null when the fetch did not cover the window:
// "we did not look" must not become a total, same rule as windowObserved().
export async function observedAround(addrs, sym, dateISO, graceDays = 3) {
  const target = new Date(dateISO + 'T00:00:00Z');
  const sKey = new Date(target.getTime() - 86400e3).toISOString().slice(0, 10);
  const eKey = new Date(target.getTime() + graceDays * 86400e3).toISOString().slice(0, 10);
  const per = [];
  for (const a of addrs) {
    const f = await fetchOutflows(a, sym, sKey);
    if (!windowObserved(f)) return null;
    let amt = 0;
    for (const [d, v] of Object.entries(f.byDay)) if (d >= sKey && d <= eKey) amt += v;
    per.push({ addr: a, amt });
  }
  return { total: per.reduce((s, p) => s + p.amt, 0), per, window: `${sKey}..${eKey}` };
}

// PURE: renders the retrospective line from an observedAround() result. Separated so
// the wording is fixture-testable without touching the network.
export function retrospectiveLine(obs, spec) {
  if (!obs) return 'Post-event totals unavailable — the on-chain read did not cover the window, so no total is claimed here.';
  const watched = new Set((spec?.wallets?.map((w) => w.addr) ?? (spec?.wallet ? [spec.wallet] : [])).map((a) => a.toLowerCase()));
  const core = obs.per.filter((p) => watched.has(p.addr.toLowerCase())).reduce((s, p) => s + p.amt, 0);
  const other = obs.total - core;
  const fmt = (n) => Math.round(n).toLocaleString();
  return other > 0
    ? `Observed on-chain: ${fmt(core)} from the tracked schedule + ${fmt(other)} from other holders = ${fmt(obs.total)} total. Retrospective and fully observed — the forward estimate quotes only the predictable component.`
    : `Observed on-chain: ${fmt(obs.total)} total from the tracked schedule; no other watched holder emitted in this window.`;
}

// BAND WIDTH IS DERIVED PER ROW, NOT GLOBAL. The first family spec used ±25%, which
// fits EIGEN (natural range ±12%) BY COINCIDENCE — it was the only row that had one.
// ENA's observed range is 0.53–1.66; under a global ±25% it would breach in months
// where it is behaving exactly as it always has. A constant calibrated on the first
// case is wrong for the second row it meets.
//
// Robust by construction: 3 x MEDIAN absolute deviation, so a single outlier month
// (ENA's 1.659) cannot inflate the band the way a mean or max would. Floored so a
// suspiciously quiet history cannot produce a hair-trigger, capped so a chaotic one
// cannot produce a band that could never fail.
// THE BAND IS STATIC AFTER PROMOTION. Re-deriving as windows accrue would inherit
// exactly the failure rejected for the mean: a genuinely drifting schedule produces
// wider deviations, which widen the MAD, which widen the band — the falsifier
// accommodating the drift instead of catching it, one level up. So: derive ONCE at
// promotion, re-derive only on explicit re-attestation, and record the window count
// so a band from n=11 is visibly weaker evidence than one from n=30.
//
// TWO derived terms, no intuited floor. The first floor here was 0.15, which was a
// guess — and EIGEN's band WAS that floor, so the most-watched row was not actually
// derived from anything. Replaced by the row's own WORST OBSERVED SHORTFALL: the
// band must not demote behaviour the row has already exhibited. (3xMAD alone would
// have false-demoted both EIGEN and ENA once each, so the second term is load-bearing,
// not decoration.) The remaining 0.05/0.60 clamps are degenerate-input guards only —
// a fixture asserts neither binds on any real row.
export function deriveTolerance(ratios, { k = 3, margin = 1.1, hardFloor = 0.05, cap = 0.60 } = {}) {
  const rs = ratios || [];
  const devs = rs.map((r) => Math.abs(r - 1)).sort((a, b) => a - b);
  if (devs.length < 4) return { tolerance: 0.25, n: devs.length, basis: `default (only ${devs.length} observed windows — too few to derive)` };
  const mid = Math.floor(devs.length / 2);
  const mad = devs.length % 2 ? devs[mid] : (devs[mid - 1] + devs[mid]) / 2;
  const spread = k * mad;
  const worstShortfall = Math.max(0, ...rs.map((r) => 1 - r));
  const needed = worstShortfall * margin;
  const raw = Math.max(spread, needed);
  const tolerance = +Math.max(hardFloor, Math.min(cap, raw)).toFixed(2);
  const driver = needed > spread ? `worst observed shortfall ${(worstShortfall * 100).toFixed(1)}% x${margin}` : `${k}x MAD (MAD ${(mad * 100).toFixed(1)}%)`;
  return { tolerance, n: devs.length, mad: +mad.toFixed(3), spread: +spread.toFixed(3), worstShortfall: +worstShortfall.toFixed(3),
    basis: `derived from ${devs.length} observed windows: ${driver}${raw < hardFloor ? ', raised to degenerate-input floor' : raw > cap ? ', capped' : ''}` };
}

// DRIFT: the mean stays STATIC deliberately. A rolling mean re-centres on whatever
// the treasury now does, so a real schedule change gets absorbed silently — a
// falsifier that tracks a moving target is not a falsifier. Static detects change but
// would eventually false-demote a legitimate one, so the resolution is to record WHERE
// IN THE BAND each confirmation lands and surface sustained one-sided deviation as
// DRIFT (operator judgement) rather than as a demotion (automatic silence).
// Pure: takes the stamped months for one token.
export function driftStatus(months, { minRun = 3, threshold = 0.10 } = {}) {
  const confirms = Object.entries(months || {})
    .filter(([, r]) => r.action === 'CONFIRM' && typeof r.ratio === 'number')
    .sort(([a], [b]) => a.localeCompare(b));
  if (!confirms.length) return null;
  // longest run of same-side deviations ending at the most recent window
  let run = 0, side = 0;
  for (let i = confirms.length - 1; i >= 0; i--) {
    const dev = confirms[i][1].ratio - 1;
    const s = dev > threshold ? 1 : dev < -threshold ? -1 : 0;
    if (s === 0) break;
    if (side === 0) side = s;
    else if (s !== side) break;
    run++;
  }
  const recent = confirms.slice(-Math.max(run, 1)).map(([, r]) => r.ratio);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  return { run, side, drifting: run >= minRun,
    pct: Math.round((mean - 1) * 100), last: confirms[confirms.length - 1][1].ratio, n: confirms.length };
}

// SOURCE RECHECK — the sourced tier's falsifier. A sourced row's claim is "DefiLlama
// says X"; its falsifier is re-asking DefiLlama. PURE decision per row against a
// freshly fetched index (or null when the fetch failed):
//   fetch failed                        → NOTHING changes ("we did not look" — feedWasLooking)
//   token absent from index / no events → DEMOTE (source retracted)
//   every event still present, same day → REFRESH (sourceFetchedAt advances)
//   some event dates moved              → REVISE (row events replaced; message notes it)
export function sourceRecheckDecision(row, index) {
  if (!index) return { action: 'NO-LOOK', reason: 'index fetch failed — not evidence' };
  const p = (index.protocols || []).find((x) => x.symbol === row.sym);
  if (!p) return { action: 'DEMOTE', reason: 'token no longer in the source index' };
  const now = Math.floor(Date.now() / 1000);
  const fresh = (p.events || []).filter((e) => e.t > now);
  if (!fresh.length) return { action: 'DEMOTE', reason: 'source lists no upcoming batch events' };
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const oldFuture = (row.sourceEvents || []).filter((e) => e.t > now).map((e) => day(e.t)).sort();
  const newFuture = fresh.map((e) => day(e.t)).sort();
  const same = oldFuture.length === newFuture.length && oldFuture.every((d, i) => d === newFuture[i]);
  if (same) return { action: 'REFRESH', fetchedAt: index.fetchedAt };
  const moved = oldFuture.filter((d) => !newFuture.includes(d));
  const added = newFuture.filter((d) => !oldFuture.includes(d));
  return { action: 'REVISE', fetchedAt: index.fetchedAt, events: p.events, moved, added,
    reason: `date${moved.length === 1 ? '' : 's'} revised by source${moved.length ? ` from ${moved.join(', ')}` : ''}${added.length ? ` to ${added.join(', ')}` : ''}` };
}

// Overlay for sourced rows (data/source-recheck.json) — the bot never edits
// unlocks.json. effectiveSourced() merges: a refreshed fetch time, revised events,
// or a demotion. Pure.
const RECHECK_FILE = join(ROOT, 'data', 'source-recheck.json');
export function loadRecheckState() {
  try { return existsSync(RECHECK_FILE) ? JSON.parse(readFileSync(RECHECK_FILE, 'utf8')) : { lastRun: null, rows: {} }; } catch { return { lastRun: null, rows: {} }; }
}
export function effectiveSourced(row, state) {
  const o = state?.rows?.[row.sym];
  if (!o) return row;
  const out = { ...row };
  if (o.fetchedAt && o.fetchedAt > (row.sourceFetchedAt || '')) out.sourceFetchedAt = o.fetchedAt;
  if (o.events) out.sourceEvents = o.events;
  if (o.revision) out.sourceRevision = o.revision;
  if (o.demoted && !(row.sourceFetchedAt > o.demoted.at)) out.sourceDemoted = o.demoted; // re-ingest after demotion supersedes it
  return out;
}

const RECHECK_EVERY = 7 * 86400e3;
export async function pollSourceRecheck(loadTokens) {
  const st = loadRecheckState();
  if (st.lastRun && Date.now() - new Date(st.lastRun).getTime() < RECHECK_EVERY) return;
  let tokens = null;
  try { tokens = loadTokens ? loadTokens() : JSON.parse(readFileSync(join(ROOT, 'unlocks.json'), 'utf8')).tokens; } catch { return; }
  const sourced = (tokens || []).filter((t) => t?.provenance === 'sourced' && !t.retired);
  if (!sourced.length) return;
  // The bot's OWN fetch. If it fails (403 from this network, embed moved, etc.),
  // nothing changes: rows age toward the 21-day stale rule, and staleness — not a
  // false demotion — is what surfaces in the heartbeat.
  let index = null;
  try {
    const mod = await import('../../../fetch-unlock-index.js');
    const { data, generatedAtSec } = await mod.fetchIndex();
    index = mod.trim(data, generatedAtSec, new Set(sourced.map((t) => t.sym)));
  } catch (e) {
    console.error('[unlocks][OPERATOR] source recheck: index fetch failed — nothing changed:', e.message);
    st.lastRun = new Date().toISOString(); st.lastResult = 'NO-LOOK: ' + e.message;
    writeFileSync(RECHECK_FILE + '.tmp', JSON.stringify(st, null, 1)); renameSync(RECHECK_FILE + '.tmp', RECHECK_FILE);
    return;
  }
  const counts = {};
  for (const t of sourced) {
    const eff = effectiveSourced(t, st);
    const d = sourceRecheckDecision(eff, index);
    counts[d.action] = (counts[d.action] || 0) + 1;
    const cur = st.rows[t.sym] || {};
    if (d.action === 'REFRESH') st.rows[t.sym] = { ...cur, fetchedAt: d.fetchedAt, demoted: undefined };
    else if (d.action === 'REVISE') {
      st.rows[t.sym] = { ...cur, fetchedAt: d.fetchedAt, events: d.events, revision: { at: d.fetchedAt, note: d.reason }, demoted: undefined };
      await broadcast(formatAlert({ source: 'SYS', type: 'CADENCE', severity: 'LOW', title: `${t.sym} sourced schedule revised by ${t.source}`, lines: [`Coverage note, not a market event: ${d.reason}. The row keeps pushing on the revised dates and says so.`] }), { toChannel: false }).catch(() => []);
    } else if (d.action === 'DEMOTE') {
      if (!cur.demoted) {
        st.rows[t.sym] = { ...cur, demoted: { at: index.fetchedAt, reason: d.reason } };
        await broadcast(formatAlert({ source: 'SYS', type: 'CADENCE', severity: 'MEDIUM', title: `${t.sym} sourced row demoted — source retracted`, lines: [`Coverage change, not a market event: ${d.reason}. The row is silent until the source lists it again or it is re-ingested.`] }), { toChannel: false }).catch(() => []);
      }
    }
  }
  st.lastRun = new Date().toISOString(); st.lastResult = JSON.stringify(counts);
  writeFileSync(RECHECK_FILE + '.tmp', JSON.stringify(st, null, 1)); renameSync(RECHECK_FILE + '.tmp', RECHECK_FILE);
  console.log('[unlocks] source recheck:', JSON.stringify(counts));
}

// ROUTE 2 FORWARD FALSIFIER — the next cliff's post-cliff claim cluster. PURE decision:
// PENDING until [cliff, cliff+window] has closed; then CONFIRM if the window's claims
// exceed minRatio x baseline with >= minRecipients distinct claimants, else DEMOTE.
// PRESENCE of a cluster, not amount-in-band: claim amounts depend on beneficiary
// behaviour and legitimately vary. Uncovered fetch -> the caller never calls this.
export function cliffClusterDecision(spec, cliffDate, now, byDay) {
  const start = new Date(cliffDate + 'T00:00:00Z').getTime();
  const end = start + spec.windowDays * 86400e3;
  if (now.getTime() <= end) return { action: 'PENDING', windowEnd: new Date(end).toISOString().slice(0, 10) };
  let amt = 0; const to = new Set();
  for (const [d, r] of Object.entries(byDay || {})) {
    const t = new Date(d + 'T00:00:00Z').getTime();
    if (t >= start && t < end) { amt += r.amt; (r.to || []).forEach((a) => to.add(a)); }
  }
  const ratio = amt / Math.max(spec.baselineDaily * spec.windowDays, 1e-9);
  const ok = ratio >= spec.minRatio && to.size >= spec.minRecipients;
  return { action: ok ? 'CONFIRM' : 'DEMOTE', cliff: cliffDate, ratio: +ratio.toFixed(2), recipients: to.size, inWindow: Math.round(amt) };
}

// Impure: for each contract-cliff row, evaluate any cliff whose window has closed and
// is not yet stamped. Uses detect-cliff-cluster's fetch (resumable cache) so a busy
// vesting proxy does not livelock a slice. Demotion is the overlay, as for cadence.
export async function pollCliffWatch(loadTokens) {
  let tokens = null;
  try { tokens = loadTokens ? loadTokens() : JSON.parse(readFileSync(join(ROOT, 'unlocks.json'), 'utf8')).tokens; } catch { return; }
  const rows = (tokens || []).filter((t) => t?.enforcement === 'contract' && t.clusterSpec && Array.isArray(t.cliffDates) && !t.retired);
  if (!rows.length) return;
  const st = loadWatchState();
  st.cliffs = st.cliffs || {};
  const now = new Date();
  let dirty = false;
  let fetcher = null;
  for (const t of rows) {
    const due = t.cliffDates.filter((c) => c.cluster === null && !st.cliffs[`${t.sym}:${c.date}`]
      && now.getTime() > new Date(c.date + 'T00:00:00Z').getTime() + t.clusterSpec.windowDays * 86400e3);
    if (!due.length) continue;
    try { fetcher = fetcher || (await import('../../../detect-cliff-cluster.js')).outflowsWithRecipients; } catch (e) { console.error('[cliff-watch] tool import failed:', e.message); return; }
    const tokenAddr = t.token?.startsWith('ethereum:') ? t.token.slice(9) : null;
    const earliest = due.map((c) => c.date).sort()[0];
    const f = await fetcher(t.contract, t.sym, new Date(new Date(earliest + 'T00:00:00Z').getTime() - 2 * 86400e3).toISOString().slice(0, 10), { deadlineTs: Date.now() + 60_000, tokenAddr, maxPages: 400 });
    if (!f.covered) continue; // "we did not look" — retry next poll
    const byDay = Object.fromEntries(Object.entries(f.byDay).map(([d, r]) => [d, { amt: r.amt, to: [...r.to] }]));
    for (const c of due) {
      const dec = cliffClusterDecision(t.clusterSpec, c.date, now, byDay);
      if (dec.action === 'PENDING') continue;
      st.cliffs[`${t.sym}:${c.date}`] = { ...dec, at: now.toISOString().slice(0, 16) };
      dirty = true;
      if (dec.action === 'DEMOTE') {
        st.demotions[t.sym] = { at: now.toISOString().slice(0, 16), type: 'cliff-cluster-absent', cliff: c.date, ratio: dec.ratio, recipients: dec.recipients };
        await broadcast(formatAlert({ source: 'SYS', type: 'CADENCE', severity: 'MEDIUM',
          title: `${t.sym} contract-cliff row demoted — no claim cluster after ${c.date}`,
          lines: [`Coverage change, not a market event: the vesting contract showed ${dec.recipients} claimants and ${dec.ratio}x baseline in the ${t.clusterSpec.windowDays}-day window after the scheduled cliff (needs >=${t.clusterSpec.minRatio}x and >=${t.clusterSpec.minRecipients}).`,
            'Possible causes, all worth knowing: the contract was upgraded, the index date is wrong, or beneficiaries stopped claiming. Re-run detect-cliff-cluster.js before re-promoting.'] }), { toChannel: false }).catch(() => []);
      }
    }
  }
  if (dirty) saveWatchState(st);
}

// Heartbeat line. A watch that silently stops watching is the failure mode this module
// exists to prevent — so its own liveness is on the operator channel.
export function cadenceStatus(tokens = null, state = loadWatchState(), now = new Date()) {
  if (tokens === null) {
    try { tokens = JSON.parse(readFileSync(join(ROOT, 'unlocks.json'), 'utf8')).tokens; } catch { tokens = []; }
  }
  const watched = (tokens || []).filter((t) => (t?.cadence || t?.reviewBy || t?.clusterSpec) && !t.retired);
  if (!watched.length) return { line: 'Cadence watch: no behavioural rows', demoted: [] };
  const demoted = Object.keys(activeDemotions(tokens, state));
  const parts = watched.map((t) => {
    if (demoted.includes(t.sym)) return `${t.sym} 🚨 demoted`;
    if (t.clusterSpec) {
      const stamps = Object.entries(state.cliffs || {}).filter(([k]) => k.startsWith(t.sym + ':')).map(([, v]) => v);
      const ok = stamps.filter((v) => v.action === 'CONFIRM').length;
      const nextCliff = (t.cliffDates || []).filter((c) => c.cluster === null).map((c) => c.date).sort()[0];
      return `${t.sym} cliff ${ok}/${stamps.length} confirmed${nextCliff ? ` · next ${nextCliff}` : ''}`;
    }
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
    const d = driftStatus(months);
    // Drift is reported, never acted on: a sustained one-sided deviation is a
    // question for the operator ("did the schedule change?"), not grounds for
    // automatic silence.
    const driftMark = d?.drifting ? ` ⚠️ DRIFT ${d.pct > 0 ? '+' : ''}${d.pct}% x${d.run} windows`
      : d?.last ? ` (${d.last > 1 ? '+' : ''}${Math.round((d.last - 1) * 100)}% vs mean)` : '';
    return `${t.sym} ${lastOk ? `ok ${lastOk}` : 'no window closed yet'}${driftMark}${ageD !== null && ageD > 65 ? ' ⚠️ stale confirm' : ''}`;
  });
  return { line: `Cadence watch: ${parts.join(' · ')}`, demoted };
}
