// CADENCE PASS over the bulk-scan shortlist (rows marked cadencePass:'pending').
// Same slice discipline as bulk-scan: checkpoint per token, budget-aware, capped
// pagination (12 pages/wallet — bulk grade; any HIT gets a full-depth
// detect-cadence.js re-run before promotion, per the recorded rule).
//   node cadence-pass.js --budget 140
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { detectCadence, outflowsByDay } from './detect-cadence.js';

const readJ = (p, d) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d; } catch { return d; } };
const writeJ = (p, o) => { writeFileSync(p + '.tmp', JSON.stringify(o, null, 1)); renameSync(p + '.tmp', p); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const budget = Number(process.argv[process.argv.indexOf('--budget') + 1]) || 140;
  const report = readJ('data/vesting-discovery.json', {});
  const cadReport = readJ('data/cadence-report.json', {});
  const t0 = Date.now();
  let n = 0;
  const pending = Object.values(report).filter((t) => t.cadencePass === 'pending');
  for (const t of pending) {
    if ((Date.now() - t0) / 1000 > budget) break;
    try {
      // Per-token deadline: a monster wallet family must finish TRUNCATED within a
      // slice, or the pass livelocks on it (observed: two zero-progress slices).
      const tokenDeadline = Date.now() + 75_000;
      const wallets = (t.contracts || []).filter((c) => c.bucket === 'D' || c.bucket === 'C')
        .sort((a, b) => b.bal - a.bal).slice(0, 3);
      const familyByDay = {}; const perWallet = [];
      for (const w of wallets) {
        const byDay = await outflowsByDay(w.addr, t.sym, 8, tokenDeadline);
        for (const [d, v] of Object.entries(byDay)) familyByDay[d] = (familyByDay[d] || 0) + v;
        const solo = detectCadence(byDay);
        perWallet.push({ addr: w.addr, bal: w.bal, solo: solo.verdict === 'CADENCE' ? solo : solo.verdict });
        await sleep(250);
      }
      const family = detectCadence(familyByDay);
      const hits = perWallet.filter((p) => typeof p.solo === 'object').length;
      t.cadence = { family: family.verdict === 'CADENCE' ? family : family.verdict, hits };
      t.cadencePass = 'done';
      cadReport[t.sym] = { at: new Date().toISOString().slice(0, 16), family, perWallet, note: 'bulk pass, pagination capped at 12 — re-run detect-cadence.js at full depth before promoting' };
      console.log(`${t.sym}: family=${t.cadence.family.verdict || t.cadence.family} hits=${hits}`);
    } catch (e) { t.cadencePass = 'error: ' + String(e.message).slice(0, 120); console.log(`${t.sym}: ERROR`); }
    writeJ('data/vesting-discovery.json', report);
    writeJ('data/cadence-report.json', cadReport);
    n++;
  }
  const left = Object.values(report).filter((t) => t.cadencePass === 'pending').length;
  console.log(`\nthis run: ${n} · remaining: ${left}`);
  process.exit(left ? 2 : 0);
})();
