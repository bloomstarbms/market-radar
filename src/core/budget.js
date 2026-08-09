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

export const DAILY_BUDGET = Number(process.env.ALERT_DAILY_BUDGET || 12);
const WINDOW_MS = 24 * 3600e3;
const BASE_SCORE = 55;   // floor: below this nothing is ever worth a push
const MAX_SCORE = 100;

// Catalysts bypass the budget: their timing is externally scheduled, they are rare
// (~2/day combined, measured), and a missed listing or unlock is the expensive kind
// of miss. Everything price/flow-derived is budgeted.
const BYPASS_TYPES = new Set([
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
  const tally = {};
  for (const r of rows) {
    const a = r.alpha?.h24;
    if (a === undefined || a === null) continue;
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

// Refreshed hourly from the live outcomes table so the loop stays closed as data grows.
function multipliers() {
  if (Date.now() - precisionCache.at < 3600e3) return precisionCache.mult;
  let mult = precisionCache.mult;
  try {
    const { allOutcomes } = globalThis.__outcomesHook ?? {};
    if (allOutcomes) mult = modulePrecision(allOutcomes());
  } catch { /* keep last known */ }
  precisionCache = { at: Date.now(), mult };
  return mult;
}

export function scoreOf(alert) {
  const base = MODULE_SCORE[alert.type] ?? 50;
  const m = multipliers()[alert.type] ?? 1;
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

// Required score rises with the fraction of budget already spent. Power curve so the
// bar climbs slowly at first, then hard — 6 of 12 spent needs 71, 10 of 12 needs 89.
export function requiredScore() {
  const used = spentIn24h();
  if (used >= DAILY_BUDGET) return Infinity;
  const frac = used / DAILY_BUDGET;
  return BASE_SCORE + (MAX_SCORE - BASE_SCORE) * Math.pow(frac, 1.5);
}

function chargeBudget() {
  const st = getState();
  st.budgetLog ??= [];
  st.budgetLog.push(Date.now());
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

export function openThread(alert, score, messageIds) {
  const st = getState();
  st.threads ??= {};
  st.threads[threadKey(alert)] = {
    id: Math.random().toString(16).slice(2, 8),
    status: 'ACTIVE', firstTs: Date.now(), lastTs: Date.now(),
    modules: [alert.type], score, messageIds: messageIds || [], updates: 0,
  };
  noteFire(alert);
  chargeBudget();
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
  const score = scoreOf(alert);
  const tier = tierOf(score);
  if (alert.source === 'SYS') return { allow: true, mode: 'new', score, tier };

  if (isSuppressed(alert)) {
    logDrop(alert, 'recurrence-suppressed');
    return { allow: false, reason: 'recurrence-suppressed', score, tier };
  }
  if (tier === 'D') {
    logDrop(alert, 'below-floor', `score ${score.toFixed(0)} < ${BASE_SCORE}`);
    return { allow: false, reason: 'below-floor', score, tier };
  }

  const arrival = classifyArrival(alert);
  if (arrival === 'cooldown-module') {
    logDrop(alert, 'cooldown-module', '6h same symbol+module');
    return { allow: false, reason: 'cooldown-module', score, tier };
  }
  if (arrival === 'escalate') {
    // Updates ride the existing thread and cost nothing from the budget.
    return { allow: true, mode: 'escalate', score, tier };
  }

  const bypass = BYPASS_TYPES.has(alert.type);
  if (!bypass) {
    const need = requiredScore();
    if (score < need) {
      logDrop(alert, 'budget', `score ${score.toFixed(0)} < required ${need === Infinity ? '∞ (budget spent)' : need.toFixed(0)}`);
      return { allow: false, reason: 'budget', score, tier };
    }
  }
  return { allow: true, mode: 'new', score, tier, bypass };
}

export function budgetStatus() {
  const used = spentIn24h();
  const need = requiredScore();
  return { used, limit: DAILY_BUDGET, required: need === Infinity ? null : Math.round(need) };
}
