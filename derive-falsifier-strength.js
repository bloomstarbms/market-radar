// FALSIFIER STRENGTH — derived for EVERY verified row, not just the one that looked
// suspicious. ORDER was flagged weak because its emission pattern made the weakness
// obvious; EIGEN/ENA/MOVE were "implicitly strong" because nobody computed the
// number. Same move as tolerance bands: a derived field on the row, with basis.
//
//   chanceRate = qualifyingDays x windowDays / spanDays
//     qualifyingDays: days on which the falsifier's own CONFIRM bar would have been
//     met regardless of date (cadence: outflow >= 50% of the wallet's mean; family:
//     any wallet clears its bar; contract: a cluster — from clusterSpec).
//     windowDays: the width the watch actually accepts (cadence: expected-1 ..
//     expected+grace = grace+2 days).
//   replayRate  = confirmed windows / windows observed (the falsifier's own record).
//   WEAK when chanceRate >= 0.5; NONE for a dead-man switch (reviewBy tests
//   freshness, not the claim); otherwise STRONG — with both numbers shown.
//
// Writes data/falsifier-strength.json (a REPORT). The row is stamped only through
// promote-unlock.js SYM strength=auto, which reads this report. Never typed.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { outflowsByDay } from './detect-cadence.js';

export function strengthFromSeries(spec, byDayPerWallet, { now = Date.now() } = {}) {
  const grace = spec.graceDays ?? 3;
  const windowDays = grace + 2;
  const wallets = Array.isArray(spec.wallets) && spec.wallets.length ? spec.wallets : [{ addr: spec.wallet, meanAmount: spec.meanAmount }];
  const days = new Set(); let oldest = null;
  for (const w of wallets) {
    const s = byDayPerWallet[w.addr] || {};
    for (const [d, amt] of Object.entries(s)) {
      if (!oldest || d < oldest) oldest = d;
      if (amt >= w.meanAmount * 0.5) days.add(d);
    }
  }
  if (!oldest) return null;
  const spanDays = Math.max(1, Math.round((now - new Date(oldest + 'T00:00:00Z').getTime()) / 86400e3));
  const chanceRate = +Math.min(1, days.size * windowDays / spanDays).toFixed(2);
  return { windowDays, qualifyingDays: days.size, spanDays, chanceRate, oldest };
}

export function strengthFromClusterSpec(spec) {
  if (!spec || !(spec.spanDays > 0) || !Number.isFinite(spec.offIndex)) return null;
  const chanceRate = +Math.min(1, (spec.hits + spec.offIndex) * spec.windowDays / spec.spanDays).toFixed(2);
  return { windowDays: spec.windowDays, qualifyingDays: spec.hits + spec.offIndex, spanDays: spec.spanDays, chanceRate, replayRate: +(spec.hits / spec.n).toFixed(2), replayN: spec.n };
}

const IS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_CLI) (async () => {
  const syms = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const tokens = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens;
  const watch = existsSync('data/cadence-watch.json') ? JSON.parse(readFileSync('data/cadence-watch.json', 'utf8')) : { months: {} };
  const out = existsSync('data/falsifier-strength.json') ? JSON.parse(readFileSync('data/falsifier-strength.json', 'utf8')) : {};
  const t0 = Date.now();
  for (const t of tokens) {
    if (!t.verified || t.retired || (syms.length && !syms.includes(t.sym))) continue;
    if (t.reviewBy && !t.cadence) { out[t.sym] = { kind: 'dead-man', verdict: 'NONE', basis: `reviewBy ${t.reviewBy} tests freshness, not the claim — no chance rate exists because nothing on chain is checked`, at: new Date().toISOString().slice(0, 16) }; console.log(`${t.sym}: NONE (dead-man switch)`); continue; }
    if (t.enforcement === 'contract' && t.clusterSpec) {
      const s = strengthFromClusterSpec(t.clusterSpec);
      if (!s) { console.log(`${t.sym}: clusterSpec lacks spanDays/offIndex — re-promote`); continue; }
      out[t.sym] = { kind: 'contract-cliff', ...s, replayHits: t.clusterSpec.hits, verdict: s.chanceRate >= 0.5 ? 'WEAK' : 'STRONG', basis: `${s.qualifyingDays} clusters in ${s.spanDays}d, w${s.windowDays} → chance ${s.chanceRate}; replay ${s.replayRate} of ${s.replayN}`, at: new Date().toISOString().slice(0, 16) };
      console.log(`${t.sym}: ${out[t.sym].verdict} chance ${s.chanceRate} replay ${s.replayRate}`); continue;
    }
    if (!t.cadence) continue;
    const spec = t.cadence;
    const wallets = Array.isArray(spec.wallets) && spec.wallets.length ? spec.wallets.map((w) => w.addr) : [spec.wallet];
    const series = {};
    let ok = true;
    for (const a of wallets) {
      const s = await outflowsByDay(a, t.sym, 60, t0 + 150_000);
      if (!Object.keys(s).length) { ok = false; break; }
      series[a] = s;
    }
    if (!ok) { console.log(`${t.sym}: fetch empty — not derived (we did not look)`); continue; }
    const s = strengthFromSeries(spec, series);
    // replay: the watch's own stamps + the promotion backtest (monthsObserved all confirmed by construction)
    const stamps = Object.entries(watch.months || {}).filter(([k]) => k.startsWith(t.sym + ':')).map(([, v]) => v);
    const confirmed = stamps.filter((v) => v.action === 'CONFIRM').length;
    const replayN = (spec.monthsObserved || 0) + stamps.length, replayHits = (spec.monthsObserved || 0) + confirmed;
    const replayRate = replayN ? +(replayHits / replayN).toFixed(2) : null;
    out[t.sym] = { kind: Array.isArray(spec.wallets) ? 'cadence-family' : 'cadence', ...s, replayRate, replayN, replayHits, verdict: s.chanceRate >= 0.5 ? 'WEAK' : 'STRONG',
      basis: `${s.qualifyingDays} days ≥50% of mean in ${s.spanDays}d (since ${s.oldest}), w${s.windowDays} → chance ${s.chanceRate}; replay ${replayHits}/${replayN}`, at: new Date().toISOString().slice(0, 16) };
    console.log(`${t.sym}: ${out[t.sym].verdict} chance ${s.chanceRate} (${s.qualifyingDays} qualifying days / ${s.spanDays}d) replay ${replayHits}/${replayN}`);
  }
  writeFileSync('data/falsifier-strength.json.tmp', JSON.stringify(out, null, 1)); renameSync('data/falsifier-strength.json.tmp', 'data/falsifier-strength.json');
  console.log('-> data/falsifier-strength.json');
})();
