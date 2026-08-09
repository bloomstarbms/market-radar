// Acceptance test 1 (spec §9): replay real alert history through the budget/state
// layer and assert the volume collapses to the target. Deterministic — mocks the clock
// and uses an in-memory state so it never touches live data.
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync('data/outcomes.json', 'utf8'));

// --- in-memory stand-ins for store.js, with a mockable clock
let NOW = 0;
const state = { threads: {}, budgetLog: [], recur: {}, suppressed: {}, dropLog: [] };
globalThis.__replay = { state, now: () => NOW };

const DAILY_BUDGET = 12, WINDOW = 24 * 3600e3, BASE = 55, MAX = 100;
const BYPASS = new Set(['UPBIT', 'LISTING', 'PERP', 'ANNOUNCE', 'UNLOCK', 'CPI', 'TGE', 'RUG', 'CASCADE', 'DEPEG']);
const MODULE_SCORE = {
  UPBIT: 92, CASCADE: 84, UNLOCK: 80, CPI: 78, PERP: 72, LISTING: 70, ANNOUNCE: 68,
  TGE: 66, RUG: 88, DEPEG: 86, CONFLUENCE: 76, MULTIEX: 64,
  FUNDING: 58, DUMP: 56, PUMP: 56, REVIVAL: 54, VOLUME: 50, WHALE: 52, EVENT: 40,
};
const SEV_ADJ = { HIGH: 8, MEDIUM: 0, LOW: -8 };
// precision multipliers, Beta(10,10) shrinkage, only for modules with n>=100
const tally = {};
for (const r of rows) { const a=r.alpha?.h24; if(a==null) continue; (tally[r.type] ??= {n:0,w:0}).n++; if(a>0) tally[r.type].w++; }
const MULT = {};
for (const [t,{n,w}] of Object.entries(tally)) if (n>=100) MULT[t] = ((w+10)/(n+20))/0.50;
const score = (r) => Math.max(0, Math.min(100, (MODULE_SCORE[r.type] ?? 50) * (MULT[r.type] ?? 1) + (SEV_ADJ[r.severity] ?? 0)));

const spent = () => { state.budgetLog = state.budgetLog.filter((t) => t >= NOW - WINDOW); return state.budgetLog.length; };
const required = () => { const u = spent(); return u >= DAILY_BUDGET ? Infinity : BASE + (MAX - BASE) * Math.pow(u / DAILY_BUDGET, 1.5); };
const symOf = (r) => r.symbol || r.address || r.title;
const dirOf = (r) => (['DUMP', 'RUG'].includes(r.type) ? 'DOWN' : 'UP');
const rkey = (r) => `${r.type}:${symOf(r)}`;

const out = { sent: 0, updated: 0, drops: {} };
const drop = (why) => { out.drops[why] = (out.drops[why] || 0) + 1; };

for (const r of rows.sort((a, b) => a.ts - b.ts)) {
  NOW = r.ts;
  const s = score(r);
  const tk = `${symOf(r)}:${dirOf(r)}`;

  if (state.suppressed[rkey(r)] > NOW) { drop('recurrence-suppressed'); continue; }
  if (s < BASE) { drop('below-floor'); continue; }

  const th = state.threads[tk];
  const isEsc = th && NOW - th.lastTs < 2 * 3600e3;
  if (isEsc) {
    if (th.modules.includes(r.type) && NOW - th.lastTs < 6 * 3600e3) { drop('cooldown-module'); continue; }
    th.lastTs = NOW; th.updates++; if (!th.modules.includes(r.type)) th.modules.push(r.type);
    out.updated++; continue;
  }
  if (!BYPASS.has(r.type) && s < required()) { drop('budget'); continue; }

  state.threads[tk] = { lastTs: NOW, modules: [r.type], updates: 0 };
  const hits = (state.recur[rkey(r)] || []).filter((t) => t >= NOW - 7 * 24 * 3600e3);
  hits.push(NOW); state.recur[rkey(r)] = hits;
  if (hits.length > 3) state.suppressed[rkey(r)] = NOW + 30 * 24 * 3600e3;
  state.budgetLog.push(NOW);
  out.sent++;
}

const days = (rows[rows.length - 1].ts - rows[0].ts) / 86400e3;
console.log(`replayed ${rows.length} historical alerts over ${days.toFixed(1)} days\n`);
console.log(`BEFORE : ${rows.length} pushes  (${(rows.length / days).toFixed(1)}/day)`);
console.log(`AFTER  : ${out.sent} pushes  (${(out.sent / days).toFixed(1)}/day)  + ${out.updated} silent in-thread updates`);
console.log(`reduction: ${(rows.length / Math.max(1, out.sent)).toFixed(1)}x\n`);
console.log('suppressed by reason:');
for (const [k, v] of Object.entries(out.drops).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${String(v).padStart(5)}  ${(100 * v / rows.length).toFixed(1)}%`);
}
const perDay = out.sent / days;
console.log(`\nbudget target <= ${DAILY_BUDGET}/day  ->  ${perDay <= DAILY_BUDGET ? 'PASS' : 'FAIL'} (${perDay.toFixed(1)}/day)`);
console.log(`auto-suppressed symbol+module pairs: ${Object.keys(state.suppressed).length}`);
const top = Object.keys(state.suppressed).slice(0, 6);
if (top.length) console.log('  e.g. ' + top.join(', '));
