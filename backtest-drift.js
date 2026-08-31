// BACKTEST THE DRIFT DETECTOR against observed history — the detector deserves the
// standard it enforces. At monthly windows the first live signal is ~November, so a
// newly built mechanism would otherwise sit unexercised outside its fixtures for two
// months (the untested-premise shape). EIGEN has 11 months and ENA 13: 24 real
// observations available today.
//
// Runs INCREMENTALLY — at each month the detector sees only data up to that month,
// so the output is what it WOULD have said at the time, not hindsight.
//   node backtest-drift.js
import { readFileSync } from 'node:fs';
import { driftStatus } from './src/sources/calendar/cadence-watch.js';

const rep = JSON.parse(readFileSync('data/cadence-report.json', 'utf8'));
const rows = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens;

// Series builder: month -> observed amount, compared LIKE WITH LIKE (peak-day
// emissions against a peak-day-derived mean; family rows sum their members).
function series(sym) {
  const row = rows.find((t) => t.sym === sym);
  const per = rep[sym].perWallet.filter((p) => typeof p.solo === 'object');
  const fam = Array.isArray(row.cadence?.wallets);
  const watched = fam ? new Set(row.cadence.wallets.map((w) => w.addr.toLowerCase()))
    : new Set([row.cadence.wallet.toLowerCase()]);
  const mean = fam ? (row.cadence.familyMean ?? row.cadence.wallets.reduce((s, w) => s + w.meanAmount, 0))
    : row.cadence.meanAmount;
  const byMonth = {};
  for (const p of per) {
    if (!watched.has(p.addr.toLowerCase())) continue;
    for (const e of p.solo.emissions) {
      const m = e.d.slice(0, 7);
      byMonth[m] = (byMonth[m] || 0) + e.amt;
    }
  }
  return { mean, months: Object.entries(byMonth).sort() };
}

for (const sym of ['EIGEN', 'ENA']) {
  const { mean, months } = series(sym);
  console.log(`\n=== ${sym} — ${months.length} historical windows, static mean ${Math.round(mean).toLocaleString()}`);
  const stamps = {};
  let fired = 0;
  for (const [m, amt] of months) {
    stamps[m] = { action: 'CONFIRM', ratio: +(amt / mean).toFixed(3) };
    const d = driftStatus(stamps);           // sees only months up to and including m
    const pct = Math.round((stamps[m].ratio - 1) * 100);
    const flag = d?.drifting ? `  <<< DRIFT ${d.pct > 0 ? '+' : ''}${d.pct}% x${d.run}` : '';
    if (d?.drifting) fired++;
    console.log(`  ${m}  ${String(Math.round(amt).toLocaleString()).padStart(12)}  ratio ${stamps[m].ratio.toFixed(3)} (${pct > 0 ? '+' : ''}${pct}%)${flag}`);
  }
  const ratios = Object.values(stamps).map((s) => s.ratio);
  const min = Math.min(...ratios), max = Math.max(...ratios);
  const avgAbs = ratios.reduce((s, r) => s + Math.abs(r - 1), 0) / ratios.length;
  console.log(`  range ${min.toFixed(3)}..${max.toFixed(3)} · mean |deviation| ${(avgAbs * 100).toFixed(1)}% · drift fired in ${fired}/${months.length} windows`);
}

// SENSITIVITY — "never fires on history" is only good news if it CAN fire. A
// detector that is silent on real data AND on injected change is not calibrated,
// it is dead. Replays each token's real series, then appends a permanent step
// change of size k, and reports how many windows until DRIFT is raised.
console.log('\n=== SENSITIVITY: months-to-detect after a permanent step change');
for (const sym of ['EIGEN', 'ENA']) {
  const { mean, months } = series(sym);
  const out = [];
  for (const k of [-0.5, -0.35, -0.25, -0.15, -0.08, 0.15, 0.25, 0.5]) {
    const stamps = {};
    for (const [m, amt] of months) stamps[m] = { action: 'CONFIRM', ratio: +(amt / mean).toFixed(3) };
    let detected = null;
    for (let i = 1; i <= 12 && detected === null; i++) {
      const m = `2027-${String(i).padStart(2, '0')}`;
      stamps[m] = { action: 'CONFIRM', ratio: +(1 + k).toFixed(3) };
      const d = driftStatus(stamps);
      if (d?.drifting) detected = i;
    }
    out.push(`${k > 0 ? '+' : ''}${Math.round(k * 100)}%: ${detected === null ? 'NEVER' : detected + 'mo'}`);
  }
  console.log(`  ${sym.padEnd(6)} ${out.join(' · ')}`);
}
