// Volume budget + alert state machine.  Spec §5.3, §0 "volume budget".
//
// The problem this solves: measured output was ~100 alerts/day (350 on the peak day)
// against a target of 12. At that rate the channel trains you to swipe it away, and
// then even a correct alert is worthless. So the cap is enforced here, structurally,
// before anything reaches Telegram — not as after-the-fact rate limiting.
//
// Two independent mechanisms:
//   BUDGET  — a rolling 24h allowance. As it fills, the score required to spend from
//             it rises steeply, so a quiet morning can't consume the whole day.
//   STATE   — one live alert per symbol per direction. Follow-ups edit the existing
//             Telegram message instead of posting a new one, which is what turns the
//             MY -42% session (4 separate alerts) into 1 alert that updates.
//
// Honest limitation: a true "top 12 of the day" needs lookahead we don't have in a
// live stream, so this is a pacing approximation. It is strictly better than no cap.
import { getState, save } from './store.js';
import { universeVerdict } from './universe.js';

export const DAILY_BUDGET = Number(process.env.ALERT_DAILY_BUDGET || 12);
const WINDOW_MS = 24 * 3600e3;
const BASE_SCORE = 55;   // floor: below this nothing is ever worth a push
const MAX_SCORE = 100;

// RISK tier: position-threatening or externally-scheduled information is never
// budgeted. Unlocks, macro, cascades, depegs, rugs, listings — a missed one is the
// expensive kind of miss.
// FACT types — verifiable statements about the world. NOT scored, NOT tiered, NOT
// budgeted, NOT subject to multipliers or the ladder. Volume is naturally bounded by
// how many listings/suspensions/prints actually happen; if facts ever exceed ~25/day
// the NOISE CLASSIFIER is leaking (promos, equities, duplicates) and that is what to
// fix — never a cap on facts, which would reintroduce the queue by another name.
export const FACT_TYPES = new Set([
  'LISTING', 'ANNOUNCE', 'PERP', 'UPBIT', 'DELIST_SCHEDULED', 'SUSPENSION',
  'UNLOCK', 'TGE', 'CPI', 'MACRO', 'DEPEG', 'RUG', 'FUNDING', 'CASCADE',
]);
export function isFact(alert) {
  if (alert.kind === 'CALL') return false;      // explicit call wins
  return alert.kind === 'FACT' || FACT_TYPES.has(alert.type);
}

const RISK_TYPES = new Set([
  'UPBIT', 'LISTING', 'PERP', 'ANNOUNCE', 'UNLOCK', 'CPI', 'MACRO', 'TGE', 'RUG', 'CASCADE', 'DEPEG',
]);

// Provisional module scores. Ranked by MEASURED 24h-alpha win rate over 1,984 scored
// rows, not by intuition:
//   PUMP 45% (n=466) · DUMP 43% (n=591) · REVIVAL 42% (n=178) · FUNDING 41% (n=455)
//   VOLUME 40% (n=242) · LISTING 32% (n=47, below the n>=100 bar so not acted on)
// None of these beat a coin flip, which is the whole argument for conjunction scoring
// (build order step 8). Until that lands, single-module price alerts sit below the
// A/B tiers by construction and mostly lose the budget contest to catalysts.
const MODULE_SCORE = {
  UPBIT: 92, CASCADE: 84, UNLOCK: 80, CPI: 78, MACRO: 78, PERP: 72, LISTING: 70, ANNOUNCE: 68,
  TGE: 66, RUG: 88, DEPEG: 86,
  CONFLUENCE: 76, MULTIEX: 64,
  FUNDING: 58, DUMP: 56, PUMP: 56, REVIVAL: 54, VOLUME: 50, WHALE: 52,
  EVENT: 40, HEARTBEAT: 100,
};
const SEV_ADJ = { HIGH: 8, MEDIUM: 0, LOW: -8 };

// Precision weighting — spec §7.3's closed loop, implemented now rather than at step 8.
// Each module's base score is scaled by its MEASURED win rate against a coin flip:
//
//     base *= shrunk_precision / 0.50
//
// Shrinkage (Beta(10,10) prior) rather than raw win rate, so a thin sample is pulled
// toward 50% and can't whipsaw the feed. A module at n=500 barely shrinks; one at n=20
// stays near neutral until it has earned an opinion.
//
// This replaces per-module hand-tuning with one rule. It is why FUNDING — which was
// half the feed at a 41% win rate purely because its base score sat above the floor —
// now falls below it, while REVIVAL and VOLUME land where they already were.
const PRIOR_A = 10, PRIOR_B = 10;
const MIN_SAMPLE = 100;              // §7.3: don't act on a module statistic below this
let precisionCache = { at: 0, mult: {} };

export function modulePrecision(rows) {
  // One sample per (module, symbol, UTC day). The Aug-9 recording flood left ~673
  // near-duplicate rows of the same few tokens; counted independently they dragged
  // REVIVAL's measured precision from 42% to 58% and its multiplier above 1.0 —
  // duplicated samples masquerading as evidence. Dedup kills that class permanently.
  const tally = {};
  const seen = new Set();
  for (const r of rows) {
    const a = r.alpha?.h24;
    if (a === undefined || a === null) continue;
    const key = r.type + ':' + (r.symbol || r.address || '?') + ':' + new Date(r.ts).toISOString().slice(0, 10);
    if (seen.has(key)) continue;
    seen.add(key);
    (tally[r.type] ??= { n: 0, w: 0 }).n++;
    if (a > 0) tally[r.type].w++;
  }
  const mult = {};
  for (const [type, { n, w }] of Object.entries(tally)) {
    if (n < MIN_SAMPLE) continue;    // insufficient evidence — leave the base alone
    mult[type] = ((w + PRIOR_A) / (n + PRIOR_A + PRIOR_B)) / 0.50;
  }
  return mult;
}

// EXPECTANCY basis (v0.18.0) — replaces win-rate as the multiplier's foundation.
// Win rate is the wrong basis: a 37% hit rate with +9%/-3% payoffs is strongly
// profitable, and momentum/catalyst strategies characteristically live there.
// Measured on this corpus the bases DISAGREE on ordering: REVIVAL is worst-but-one
// on hit rate yet BEST on expectancy (-0.13%/alert, +1.8/-1.4 asymmetry) while
// DUMP is best on hit rate and fourth on expectancy (worst loss tail, -2.3).
//   expectancy = p_shrunk x medianWin - (1 - p_shrunk) x |medianLoss|
// p shrunk with the same Beta(10,10); normalized against ZERO, not 50%.
// All five are currently negative (-0.13..-0.54) — nothing has an edge yet, which
// is the empirical case for conjunction scoring stated by the data itself.
const E_SCALE = Number(process.env.EXPECTANCY_SCALE_PCT || 2); // +2%/alert -> x2 cap region

// COST MODEL (v0.18.2) — every expectancy from here is NET. Stored alphas stay GROSS
// (raw data is never mutated); costs are applied at analysis time. Round trip =
// 2x taker + 2x half-spread slippage estimate. Venue taker fees, bps, spot standard
// tiers; slippage default is conservative for the microcap-heavy corpus.
// EXCLUDED: perp funding payments and borrow costs — this models a SPOT round
// trip only. Short-side evaluations must add funding before being believed;
// on a pumping microcap funding can invert violently (the squeeze scenario).
const TAKER_BPS = { binance: 10, bybit: 10, kucoin: 10, gate: 20, bitget: 10, mexc: 5 };
const SLIP_HALF_SPREAD_BPS = Number(process.env.COST_SLIP_BPS || 10);
export function roundTripCostPct(exchange) {
  const taker = TAKER_BPS[exchange] ?? 15;
  return (2 * taker + 2 * SLIP_HALF_SPREAD_BPS) / 100; // in percent
}
const MULT_MIN = 0.6, MULT_MAX = 1.4;
export function moduleExpectancy(rows) {
  const seen = new Set(), S = {};
  for (const r of rows) {
    const a = r.alpha?.h24;
    if (a === undefined || a === null) continue;
    const k = r.type + ':' + (r.symbol || r.address || '?') + ':' + new Date(r.ts).toISOString().slice(0, 10);
    if (seen.has(k)) continue; seen.add(k);
    const net = a - roundTripCostPct(r.exchange);   // GROSS stored, NET analyzed
    (S[r.type] ??= { wins: [], losses: [] })[net > 0 ? 'wins' : 'losses'].push(Math.abs(net));
  }
  const med = (x) => { if (!x.length) return 0; const s2 = [...x].sort((a, b) => a - b); const m = s2.length >> 1; return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2; };
  const mult = {}, multRaw = {}, expectancy = {};
  for (const [t, { wins, losses }] of Object.entries(S)) {
    const n = wins.length + losses.length;
    if (n < MIN_SAMPLE) continue;
    const pWin = (wins.length + PRIOR_A) / (n + PRIOR_A + PRIOR_B);
    const E = pWin * med(wins) - (1 - pWin) * med(losses);
    expectancy[t] = { E: Number(E.toFixed(3)), n, floor: floorFor(n) };
    // UNCLAMPED — for composite weighting (step 8). "How much should this contribute
    // to a composite" and "can this alone clear the push floor" are different
    // questions, and one clamped value cannot answer both. Conjunction weights must
    // inherit live values, not three constants pinned at the floor.
    // Clamped BELOW AT ZERO, not unbounded: E=-4.79 gives 1+E/E_SCALE = -1.40, and a
    // NEGATIVE weight would invert a module's contribution to a composite — a claim
    // ("this module predicts the opposite") that has not been earned and that the
    // magnitude-not-direction finding argues against. Zero means "contributes
    // nothing", which is the honest floor for a weight.
    multRaw[t] = Math.max(0, Math.min(MULT_MAX, 1 + E / E_SCALE));
    mult[t] = Math.max(floorFor(n), multRaw[t]);
  }
  return { mult, multRaw, expectancy };
}

// A noise floor exists so a THIN, UNCERTAIN estimate cannot zero out a module
// prematurely. A FIXED 0.6 floor did the opposite: at n=394 PUMP's unclamped
// multiplier is ~0.08 (E=-4.59) and the floor lifted it 7x, overriding a confident,
// strongly negative measurement — rescuing, not protecting. Uncertainty is a function
// of n, so the floor is too: 0.6 while thin (n<100), relaxing toward 0.1 once the
// estimate has earned confidence (n>=300). Shrinkage already does this continuously;
// the hard clamp was overriding it, and this restores the intent.
// DISABLING is the ladder's job (§7.3), not the clamp's — two mechanisms, two
// distinct jobs, neither pretending to be the other.
const FLOOR_THIN = Number(process.env.MULT_FLOOR_THIN || 0.6);
const FLOOR_CONFIDENT = Number(process.env.MULT_FLOOR_CONFIDENT || 0.1);
const FLOOR_N_LO = 100, FLOOR_N_HI = 300;
export function floorFor(n) {
  if (n < FLOOR_N_LO) return FLOOR_THIN;
  if (n >= FLOOR_N_HI) return FLOOR_CONFIDENT;
  const w = (n - FLOOR_N_LO) / (FLOOR_N_HI - FLOOR_N_LO);
  return Number((FLOOR_THIN + (FLOOR_CONFIDENT - FLOOR_THIN) * w).toFixed(4));
}

// ---- §7.3 ladder: the multiplier scales a module down; the ladder REMOVES it.
// Negative expectancy for 3 consecutive COMPLETE weeks (each week n>=25 deduped
// samples) -> TIGHTENED (extra x0.85). Four weeks -> DISABLED: never pushes,
// still recorded, operator notified. Distinct mechanism from the multiplier.
const LADDER_WEEK_N = Number(process.env.LADDER_WEEK_MIN_N || 25);
// `injectedState` makes this testable WITHOUT touching live state: passing one both
// isolates the ladder map and suppresses the save. Without it the ladder fixture
// wrote synthetic modules into the running bot's state.json — the same read-only
// discipline breach that tore outcomes.json in v0.17.
export function evaluateLadder(rows, injectedState = null) {
  const weekOf = (ts) => { const d = new Date(ts); const on = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return d.getUTCFullYear() + '-' + String(Math.floor((ts - on.getTime()) / (7 * 864e5))).padStart(2, '0'); };
  const thisWeek = weekOf(Date.now());
  const seen = new Set(), W = {};
  for (const r of rows) {
    const a = r.alpha?.h24; if (a == null) continue;
    const k = r.type + ':' + (r.symbol || r.address || '?') + ':' + new Date(r.ts).toISOString().slice(0, 10);
    if (seen.has(k)) continue; seen.add(k);
    const wk = weekOf(r.ts); if (wk === thisWeek) continue; // complete weeks only
    ((W[r.type] ??= {})[wk] ??= { wins: [], losses: [] })[a > 0 ? 'wins' : 'losses'].push(Math.abs(a));
  }
  const med = (x) => { if (!x.length) return 0; const s2 = [...x].sort((a, b) => a - b); const m = s2.length >> 1; return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2; };
  const st = injectedState ?? getState(); st.ladder ??= {};
  for (const [t, weeks] of Object.entries(W)) {
    // WINDOW OVER QUALIFYING WEEKS, NOT CALENDAR WEEKS (fixed 16 Aug).
    // Previously: last 4 calendar weeks, with n<25 weeks neither counted as bad nor
    // excluded — they simply occupied a slot. Measured effect on PUMP: weeks 28/29/31
    // all negative (E -0.81, -3.13, -11.47) but week 30 had n=17, so bad.length stuck
    // at 3 and DISABLED was UNREACHABLE. Worse, as weeks advance a thin week dilutes
    // the window and can silently REVERT TIGHTENED -> OK with no improvement in
    // performance. A quiet market or a day of downtime therefore acted as a permanent
    // shield against the ladder — which is why the expectancy clamp had become
    // load-bearing. "Complete week" must mean "enough samples to judge", so thin weeks
    // are dropped from the window entirely rather than filling it.
    const qualifying = Object.keys(weeks).sort().filter((wk) => {
      const { wins, losses } = weeks[wk];
      return wins.length + losses.length >= LADDER_WEEK_N;
    }).slice(-4);
    const bad = qualifying.filter((wk) => {
      const { wins, losses } = weeks[wk]; const n = wins.length + losses.length;
      const p = (wins.length + PRIOR_A) / (n + PRIOR_A + PRIOR_B);
      return (p * med(wins) - (1 - p) * med(losses)) < 0;
    });
    const prev = st.ladder[t]?.status || 'OK';
    const next = bad.length >= 4 ? 'DISABLED' : bad.length >= 3 ? 'TIGHTENED' : 'OK';
    if (next !== prev) {
      st.ladder[t] = { status: next, since: Date.now(), badWeeks: bad.length };
      console.error('[ladder][OPERATOR] ' + t + ': ' + prev + ' -> ' + next + ' (' + bad.length + ' consecutive negative-expectancy weeks)');
      if (!injectedState) save();   // never persist a test's synthetic ladder
    }
  }
  return st.ladder;
}
// Test-only ladder injection, same shape as withMultipliers and for the same reason:
// the boot self-test was hermetic against multipliers but still read the LIVE ladder,
// so when the windowing fix let PUMP/DUMP reach DISABLED for real (21 Aug — the
// ladder doing its job), the self-test's PUMP cases dropped as ladder-disabled and
// the gate crash-looped the bot on a DATA state, not a code defect. Any live state a
// gate reads is a clock that will eventually strike; inject all of it.
let ladderOverride = null;
export function withLadder(map, fn) {
  ladderOverride = map;
  try { return fn(); } finally { ladderOverride = null; }
}
export function ladderStatus(type) {
  if (ladderOverride) return ladderOverride[type] || 'OK';
  return (getState().ladder || {})[type]?.status || 'OK';
}

// Refreshed hourly from the live outcomes table so the loop stays closed as data grows.
export function multipliers() {
  if (Date.now() - precisionCache.at < 3600e3) return precisionCache.mult;
  let mult = precisionCache.mult;
  try {
    const { allOutcomes } = globalThis.__outcomesHook ?? {};
    if (allOutcomes) {
      const rows = allOutcomes();
      mult = moduleExpectancy(rows).mult;
      const ladder = evaluateLadder(rows);
      for (const [t, l] of Object.entries(ladder)) if (l.status === 'TIGHTENED' && mult[t]) mult[t] *= 0.85;
    }
  } catch { /* keep last known */ }
  precisionCache = { at: Date.now(), mult };
  return mult;
}

// Test-only multiplier injection, so the BOOT SELF-TEST is hermetic. Without it the
// gate's verdict depended on live multipliers: a fresh/restored data dir (multiplier
// 1.0) scored FUNDING-MEDIUM above the floor and FAILED BOOT — blocking startup
// precisely in the restore-from-backup scenario the backups exist for — and a
// multiplier drifting across the 55 boundary could fail a Tuesday boot with no code
// change. A guard that fails for non-code reasons eventually gets commented out.
// The gate asserts LOGIC with injected multipliers; live-data conditions are a
// separate NON-FATAL diagnostic in index.js.
let multOverride = null;
export function withMultipliers(map, fn) {
  multOverride = map;
  try { return fn(); } finally { multOverride = null; }
}

export function scoreOf(alert) {
  const base = MODULE_SCORE[alert.type] ?? 50;
  const m = (multOverride ?? multipliers())[alert.type] ?? 1;
  const weighted = base * m;
  return Math.max(0, Math.min(100, weighted + (SEV_ADJ[alert.severity] ?? 0) + (alert.scoreBonus ?? 0)));
}

export function tierOf(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= BASE_SCORE) return 'C';
  return 'D';
}

// ---------------------------------------------------------------- drop log
// Every suppressed candidate is recorded with a reason. Per spec §10 this is the most
// useful debugging artifact in the system — it's where false negatives show up.
function logDrop(alert, reason, detail = '') {
  const st = getState();
  st.dropLog ??= [];
  st.dropLog.push({
    ts: Date.now(), type: alert.type, key: alert.key ?? '', reason, detail,
    symbol: alert.track?.symbol ?? alert.dedupeKey ?? '',
  });
  if (st.dropLog.length > 3000) st.dropLog = st.dropLog.slice(-3000);
  console.log(`  [drop] ${alert.type} ${alert.track?.symbol ?? alert.key ?? ''} — ${reason}${detail ? ' ' + detail : ''}`);
}

export function dropStats(hours = 24) {
  const cut = Date.now() - hours * 3600e3;
  const rows = (getState().dropLog || []).filter((d) => d.ts >= cut);
  const by = {};
  for (const d of rows) by[d.reason] = (by[d.reason] || 0) + 1;
  return { total: rows.length, byReason: by };
}

// ---------------------------------------------------------------- budget
function spentIn24h() {
  const st = getState();
  const cut = Date.now() - WINDOW_MS;
  st.budgetLog = (st.budgetLog || []).filter((t) => t >= cut);
  return st.budgetLog.length;
}

// CIRCUIT-BREAKER SEMANTICS (replaces the escalating counter).
//
// "Top 12 of the day" is unimplementable online: irreversible push decisions are made
// one at a time, so a better 18:00 alert has nowhere to go once noon spent the cap.
// And NOTHING IS EVER DEFERRED — a late alert is worse than a silent one (same rule
// as macro's `missed` stages). So the budget is not the quality gate; the conviction
// floor is. The budget only exists for the day the floor FAILS:
//
//   RISK types  — never budgeted (position-threatening / externally scheduled)
//   A-tier      — never budgeted; rare by construction. If A floods, the scorer is
//                 broken and the fix is upstream, not a cap.
//   B-tier      — hard cap on a ROLLING 24h window (no midnight cliff)
//   C-tier      — digest-only, never a push, so outside the question entirely
//
// A breaker that trips regularly is not protecting anything — it is diagnosing
// miscalibration upstream. Hence the operator log on consecutive bound days.
function chargeBudget() {
  const st = getState();
  st.budgetLog ??= [];
  st.budgetLog.push(Date.now());
}

function noteBudgetBound() {
  const st = getState();
  const today = new Date().toISOString().slice(0, 10);
  st.budgetBound ??= [];
  if (!st.budgetBound.includes(today)) st.budgetBound.push(today);
  st.budgetBound = st.budgetBound.slice(-10);
  // consecutive-day check
  let run = 0;
  for (let i = 0; ; i++) {
    const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
    if (st.budgetBound.includes(d)) run++; else break;
  }
  if (run >= 3) console.error(`[budget][OPERATOR] B-tier budget bound ${run} days running — the conviction floor is too low; recalibrate upstream, do not raise the cap.`);
}

// ---------------------------------------------------------------- recurrence
// If a symbol+module pair keeps firing and never resolves into a win, stop trusting it.
// This is the rule that would have silenced the 9 EIGEN whale alerts after the third.
// 14d, not 7d. The 72h thread cap spaces a persistent repeater's pushes ~3 days apart,
// which slips under a "3 fires in 7 days" rule — the cap was quietly defeating the
// suppression it sits next to. Measured on the raw log at cap=72h:
//   7d window  -> ZRO 399→5, 95 pairs suppressed
//  14d window  -> ZRO 399→4, 108 pairs suppressed   <- chosen
//  21d window  -> identical to 14d, so no reason to reach further back.
const RECUR_WINDOW = Number(process.env.RECUR_WINDOW_D || 14) * 24 * 3600e3;
const RECUR_LIMIT = 3;
const SUPPRESS_MS = 30 * 24 * 3600e3;

function recurrenceKey(alert) {
  const sym = alert.track?.symbol || alert.dedupeKey || alert.key || '';
  return `${alert.type}:${sym}`;
}

export function isSuppressed(alert) {
  const st = getState();
  const until = (st.suppressed || {})[recurrenceKey(alert)];
  return until && Date.now() < until;
}

function noteFire(alert) {
  const st = getState();
  const k = recurrenceKey(alert);
  st.recur ??= {};
  const cut = Date.now() - RECUR_WINDOW;
  const hits = (st.recur[k] || []).filter((t) => t >= cut);
  hits.push(Date.now());
  st.recur[k] = hits;
  if (hits.length > RECUR_LIMIT) {
    st.suppressed ??= {};
    st.suppressed[k] = Date.now() + SUPPRESS_MS;
    console.log(`  [suppress] ${k} fired ${hits.length}x in 7d with no resolved win — muted 30d`);
  }
}

// ---------------------------------------------------------------- state machine
// NEW -> ACTIVE -> ESCALATED -> RESOLVED. One record per symbol+direction.
// A thread stays ACTIVE for 12h ROLLING from its last activity, not from its first
// alert. This is what makes a multi-hour drawdown one event instead of several: the
// MY -42% session spanned hours, so a 2h window let it re-open a new thread each time
// and still produced 4 pushes. Measured on the raw log (replay-dedup.js):
//   TTL  2h -> MY 6→4   EIGEN 240→4   total 3038 pushes
//   TTL  6h -> MY 6→3   EIGEN 240→4   total 2770
//   TTL 12h -> MY 6→2   EIGEN 240→2   total 2351   <- chosen
//   TTL 24h -> MY 6→2   EIGEN 240→1   total 1955
// 12h spans a trading session without spanning a day; 24h starts folding genuinely
// separate moves together. The residual 2 for MY is a LISTING (UP) and the sell-off
// (DOWN) — different directions, which the spec keeps as separate threads by design.
const THREAD_TTL_MS = Number(process.env.THREAD_TTL_H || 12) * 3600e3;
// Absolute lifetime cap. Rolling TTL alone means a token that alerts every few hours
// never closes its thread — EIGEN's 240→2 came from auto-suppression, not from the TTL,
// and implied threads spanning ~5 days. Past 72h a "new development" is a new event,
// not an update to a stale one, so the thread hard-closes regardless of activity.
const THREAD_MAX_MS = Number(process.env.THREAD_MAX_H || 72) * 3600e3;
const MODULE_SYMBOL_COOLDOWN_MS = 6 * 3600e3;

function threadKey(alert) {
  const sym = alert.track?.symbol || alert.dedupeKey || alert.key || '';
  const dir = alert.direction || (['DUMP', 'RUG'].includes(alert.type) ? 'DOWN' : 'UP');
  return `${sym}:${dir}`;
}

export function getThread(alert) {
  return (getState().threads || {})[threadKey(alert)];
}

// Returns 'new' | 'escalate' | 'cooldown-symbol' | 'cooldown-module'
export function classifyArrival(alert) {
  const st = getState();
  st.threads ??= {};
  const tk = threadKey(alert);
  const th = st.threads[tk];
  const now = Date.now();
  // Hard close on absolute age before anything else, so a long-running thread can't
  // absorb an unrelated event days later.
  const expired = th && (now - th.firstTs > THREAD_MAX_MS || now - th.lastTs >= THREAD_TTL_MS);
  if (!th || th.status === 'RESOLVED' || expired) return 'new';
  if (th.modules?.includes(alert.type) && now - th.lastTs < MODULE_SYMBOL_COOLDOWN_MS) {
    // Suppressing an update must NOT starve the thread's keep-alive. Otherwise a longer
    // module cooldown swallows the very alerts holding the thread open, the thread times
    // out, and the next one opens a fresh thread — so tightening the cooldown produced
    // MORE pushes (2348 -> 2518 at 6h -> 12h). Found by property-test.js P1, same class
    // as the 72h/7d interaction. The event is still evidence the situation is live.
    th.lastTs = now;
    save();
    return 'cooldown-module';
  }
  return 'escalate';
}

export function openThread(alert, score, messageIds, charge = false) {
  const st = getState();
  st.threads ??= {};
  st.threads[threadKey(alert)] = {
    id: Math.random().toString(16).slice(2, 8),
    status: 'ACTIVE', firstTs: Date.now(), lastTs: Date.now(),
    modules: [alert.type], score, messageIds: messageIds || [], updates: 0,
  };
  noteFire(alert);
  if (charge) chargeBudget();
  save();
}

export function escalateThread(alert, score) {
  const st = getState();
  const th = st.threads?.[threadKey(alert)];
  if (!th) return null;
  th.status = 'ESCALATED';
  th.lastTs = Date.now();
  th.updates = (th.updates || 0) + 1;
  if (!th.modules.includes(alert.type)) th.modules.push(alert.type);
  th.score = Math.max(th.score || 0, score);
  noteFire(alert);
  save();
  return th;
}

// Called by the outcome tracker so recurrence suppression can tell a repeat
// offender from a repeat winner.
export function resolveThread(symbol, direction, verdict) {
  const st = getState();
  const th = st.threads?.[`${symbol}:${direction}`];
  if (!th) return;
  th.status = 'RESOLVED';
  th.verdict = verdict;
  if (verdict === 'win') {
    for (const m of th.modules) delete (st.recur || {})[`${m}:${symbol}`];
  }
  save();
}

// ---------------------------------------------------------------- entry point
// Returns { allow, mode, score, tier, reason }
export function admit(alert) {
  // CANONICAL v0.19.0 admit — rewritten wholesale after discovering the v0.17.1
  // tier-semantics tail was never installed: a patch ordering bug deleted the line
  // its match text began with, the replace silently no-opped, and the tail kept
  // referencing an undefined `bypass` and a deleted requiredScore(). Runtime
  // ReferenceError for any candidate reaching it; RISK pushes survived only by
  // returning earlier. Lesson: string-replace patches fail SILENTLY — verify the
  // installed function, not the patch exit code.
  // ---------------------------------------------------------------- FACTS (v0.23.0)
  // A FACT is a verifiable statement about the world: a pair listed, deposits
  // suspended, funding is at X%, CPI printed Y. A CALL asserts direction.
  //
  // Every expectancy number this project measured answers "is this TRADEABLE".
  // "Shorts are paying longs 1.02%/8h" is true regardless of whether trading it
  // makes money — the measurement never argued against being TOLD. Scoring a fact
  // was a category error: conviction is a property of a prediction, and printing
  // "conviction 78" on "MEXC listed PLUMBER" asserted something we never meant.
  //
  // So facts skip the entire apparatus built to judge calls — score, tier,
  // multipliers, ladder, budget — while KEEPING the mechanisms that stop repetition
  // (recurrence suppression, module cooldown, thread escalation). Those are about
  // saying the same thing twice, which applies to facts as much as calls.
  if (isFact(alert)) {
    if (isSuppressed(alert)) {
      logDrop(alert, 'recurrence-suppressed');
      return { allow: false, reason: 'recurrence-suppressed', kind: 'FACT' };
    }
    const fArrival = classifyArrival(alert);
    if (fArrival === 'cooldown-module') {
      logDrop(alert, 'cooldown-module', '6h same symbol+module');
      return { allow: false, reason: 'cooldown-module', kind: 'FACT' };
    }
    if (fArrival === 'escalate') return { allow: true, mode: 'escalate', kind: 'FACT' };
    return { allow: true, mode: 'new', kind: 'FACT', charge: false };
  }

  const score = scoreOf(alert);
  const tier = tierOf(score);
  if (alert.source === 'SYS') return { allow: true, mode: 'new', score, tier };

  if (ladderStatus(alert.type) === 'DISABLED' && !RISK_TYPES.has(alert.type)) {
    logDrop(alert, 'ladder-disabled');
    return { allow: false, reason: 'ladder-disabled', score, tier: 'D' };
  }
  if (isSuppressed(alert)) {
    logDrop(alert, 'recurrence-suppressed');
    return { allow: false, reason: 'recurrence-suppressed', score, tier };
  }

  const arrival = classifyArrival(alert);
  if (arrival === 'cooldown-module') {
    logDrop(alert, 'cooldown-module', '6h same symbol+module');
    return { allow: false, reason: 'cooldown-module', score, tier };
  }
  if (arrival === 'escalate') return { allow: true, mode: 'escalate', score, tier };

  // RISK types and A-tier bypass the budget entirely (circuit-breaker semantics).
  if (RISK_TYPES.has(alert.type) || tier === 'A') {
    return { allow: true, mode: 'new', score, tier, bypass: true, charge: false };
  }

  // PROVISIONAL GATED-POPULATION PATH — sits ABOVE the floor deliberately: post-cost
  // multipliers score every single-factor HIGH as tier D, so a check below the floor
  // is dead code (exactly how the digest went structurally empty). Gate-passing HIGH
  // singles push at B (budget-capped), tagged provisional, because the evidence that
  // silenced them was measured on a sub-gate population and gated n can never reach
  // 100 if they never push. EXIT: gated expectancy decides at n>=100 per module.
  const PROVISIONAL_TYPES = new Set(['PUMP', 'DUMP', 'FUNDING', 'VOLUME', 'REVIVAL', 'WHALE', 'MULTIEX']);
  if (alert.severity === 'HIGH' && PROVISIONAL_TYPES.has(alert.type)
      && alert.track?.exchange && alert.track?.symbol
      && universeVerdict(alert.track.exchange, alert.track.symbol) === 'PASS') {
    if (spentIn24h() >= DAILY_BUDGET) {
      noteBudgetBound();
      logDrop(alert, 'budget', `provisional B cap ${DAILY_BUDGET}/24h`);
      return { allow: false, reason: 'budget', score, tier };
    }
    return { allow: true, mode: 'new', score, tier: 'B', charge: true, provisional: true };
  }

  if (tier === 'D') {
    logDrop(alert, 'below-floor', `score ${score.toFixed(0)} < ${BASE_SCORE}`);
    return { allow: false, reason: 'below-floor', score, tier };
  }
  if (tier === 'C') {
    logDrop(alert, 'digest-only', `C-tier score ${score.toFixed(0)}`);
    return { allow: false, reason: 'digest-only', score, tier };
  }
  // B-tier: hard cap, rolling 24h.
  if (spentIn24h() >= DAILY_BUDGET) {
    noteBudgetBound();
    logDrop(alert, 'budget', `B-tier cap ${DAILY_BUDGET}/24h reached`);
    return { allow: false, reason: 'budget', score, tier };
  }
  return { allow: true, mode: 'new', score, tier, charge: true };
}

export function budgetStatus() {
  return { used: spentIn24h(), limit: DAILY_BUDGET, scope: 'B-tier only' };
}
