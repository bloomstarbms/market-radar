// CUSTODY CADENCE DETECTION — the bucket-D backtest turned into a discovery method.
//
//   node detect-cadence.js EIGEN          family from data/vesting-discovery.json
//   node detect-cadence.js ZRO --top 12   cap wallets examined
//   node detect-cadence.js 0xabc... 0xdef...   explicit addresses (symbol inferred no)
//
// WHY: discovery over 10 Ethereum-native large-caps found ZERO OZ-shaped vesting —
// every token with locked supply came back CUSTODY (BitGo WalletSimple, GnosisSafe).
// Professionally-managed treasuries do not use VestingWallet; the schedule lives in
// their BEHAVIOUR. EIGEN's schedule was derived by hand from ten consecutive month-end
// outflows — and by this project's own standard that is STRONGER than a contract read,
// because it verifies behaviour rather than intent. A wallet that has moved ~9.6M on
// the 30th for ten straight months IS the schedule.
//
// Detects two patterns over the family's aggregated daily outflows:
//   FIXED-DAY   emissions cluster on day N of the month (std <= 1.5 days)
//   MONTH-END   emissions land in the last 3 days of each month (the EIGEN shape:
//               30th, clamped to 28/29 in short months)
// Requires >= 4 CONSECUTIVE months and amount consistency (CV < 1.0) before it will
// call anything a schedule. Derived schedules are ANNOUNCEMENT-GRADE-PLUS evidence for
// promoteRow(source: 'onchain-cadence'), never auto-promoted — a human confirms.
// READ-ONLY except its own report (data/cadence-report.json).
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jget = async (url) => { try { const r = await fetch(url, { headers: { accept: 'application/json' } }); return await r.json(); } catch { return null; } };

// PAGINATION IS THE FAILURE MODE HERE, not a tuning knob: EIGEN's monthly emission
// is a BATCH of dozens of transfers, so 4 pages (200 transfers) covered only 3 months
// and the validation gate returned INSUFFICIENT on the known metronome. Depth must be
// driven by DATE SPAN (>= 14 months), not page count.
async function outflowsByDay(addr, tokenSym, maxPages = 30) {
  const byDay = {};
  let next = '', oldest = null;
  const cutoff = new Date(Date.now() - 14 * 30.44 * 86400e3).toISOString().slice(0, 10);
  for (let p = 0; p < maxPages; p++) {
    const j = await jget(`https://eth.blockscout.com/api/v2/addresses/${addr}/token-transfers?filter=from${next}`);
    for (const t of (j?.items || [])) {
      const d = (t.timestamp || '').slice(0, 10);
      if (d && (!oldest || d < oldest)) oldest = d;
      if (tokenSym && (t.token?.symbol || '') !== tokenSym) continue;
      const dec = Number(t.total?.decimals ?? 18);
      if (d) byDay[d] = (byDay[d] || 0) + Number(t.total?.value || 0) / 10 ** dec;
    }
    if (oldest && oldest < cutoff) break; // span covered — enough history for 12-month cadence
    if (!j?.next_page_params) break;
    next = '&' + Object.entries(j.next_page_params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    await sleep(280);
  }
  return byDay;
}

const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

// Dominant-class detection, NOT largest-per-month. Validation lesson (EIGEN wallet
// 0x34BcF805): 11 consecutive month-end emissions were present, but ONE off-schedule
// treasury move (Nov 19, 8.53M — the single largest day) out-sized Nov 30 and broke a
// naive "largest emission per month" cluster. Treasuries make occasional ad-hoc moves;
// the cadence is the DOMINANT class, and off-schedule moves are reported, not fatal.
export function detectCadence(byDay, { minMonths = 4, minAmount = 0 } = {}) {
  const entries = Object.entries(byDay).filter(([, v]) => v > minAmount).sort();
  if (!entries.length) return { verdict: 'NO-OUTFLOWS' };
  const peak = Math.max(...entries.map(([, v]) => v));
  // significant emission days only: >= 10% of the largest daily outflow
  const sig = entries.filter(([, v]) => v >= peak * 0.1)
    .map(([d, v]) => { const [y, m, day] = d.split('-').map(Number); return { d, y, m, day, v, last: lastDayOfMonth(y, m) }; });
  const monthKey = (e) => `${e.y}-${String(e.m).padStart(2, '0')}`;
  const monthIdx = (k) => { const [y, m] = k.split('-').map(Number); return y * 12 + m; };
  if (new Set(sig.map(monthKey)).size < minMonths)
    return { verdict: 'INSUFFICIENT', monthsSeen: new Set(sig.map(monthKey)).size };

  // Candidate classes: MONTH-END (within 2 days of month's last day — the EIGEN shape,
  // day 30 clamping to 28/29) and FIXED-DAY d for every d, tolerance ±1.
  const candidates = [{ id: 'ME', match: (e) => e.last - e.day <= 2 }];
  for (let d = 1; d <= 28; d++) candidates.push({ id: `D${d}`, match: (e) => Math.abs(e.day - d) <= 1, day: d });

  let best = null;
  const nowIdx = (() => { const n = new Date(); return n.getUTCFullYear() * 12 + n.getUTCMonth() + 1; })();
  for (const c of candidates) {
    // largest matching emission per month, then longest consecutive run ending recently
    const perMonth = {};
    for (const e of sig) if (c.match(e)) { const k = monthKey(e); if (!perMonth[k] || e.v > perMonth[k].v) perMonth[k] = e; }
    const months = Object.keys(perMonth).sort();
    if (months.length < minMonths) continue;
    let run = [], cur = [months[0]];
    for (let i = 1; i < months.length; i++) {
      if (monthIdx(months[i]) - monthIdx(months[i - 1]) === 1) cur.push(months[i]);
      else { if (cur.length > run.length) run = cur; cur = [months[i]]; }
    }
    if (cur.length > run.length) run = cur;
    // schedule must be CURRENT: run ends within 2 months of now (this month's emission may not have fired yet)
    if (run.length < minMonths || nowIdx - monthIdx(run[run.length - 1]) > 2) continue;
    if (!best || run.length > best.run.length) best = { c, run, perMonth };
  }
  if (!best) return { verdict: 'IRREGULAR', sigDays: sig.length };

  const es = best.run.map((k) => best.perMonth[k]);
  const amounts = es.map((e) => e.v);
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const cv = Math.sqrt(amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length) / mean;
  const pattern = best.c.id === 'ME' ? 'MONTH-END' : 'FIXED-DAY';
  // FIXED-DAY targetDay = MODAL observed day, not the tolerance center: ENA emitted on
  // the 6th (9x) or 8th (4x, every time the 6th was a weekend) — center said "7", a day
  // it NEVER emitted on. Weekend roll-forward is common in human-operated distributions.
  const dayCounts = {};
  for (const e of es) dayCounts[e.day] = (dayCounts[e.day] || 0) + 1;
  const modalDay = +Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0][0];
  const targetDay = best.c.id === 'ME' ? Math.max(...es.map((e) => e.day)) : modalDay;
  // honesty line: significant moves inside the run's span that the class does NOT explain
  const span = [es[0].d, es[es.length - 1].d];
  const offSchedule = sig.filter((e) => e.d >= span[0] && e.d <= span[1] && !best.c.match(e))
    .map((e) => ({ d: e.d, amt: Math.round(e.v) }));
  if (cv >= 1.0) return { verdict: 'DAY-STABLE-AMOUNT-UNSTABLE', pattern, targetDay, monthsRun: best.run.length, cv: +cv.toFixed(2), offSchedule };
  return {
    verdict: 'CADENCE', pattern, targetDay, monthsRun: best.run.length,
    meanAmount: Math.round(mean), cv: +cv.toFixed(2),
    firstSeen: es[0].d, lastSeen: es[es.length - 1].d,
    emissions: es.map((e) => ({ d: e.d, amt: Math.round(e.v) })),
    offSchedule,
  };
}

// ---- CLI
(async () => {
  const args = process.argv.slice(2);
  const topIdx = args.indexOf('--top');
  const topN = topIdx >= 0 ? Number(args[topIdx + 1]) : 10;
  const positional = args.filter((a, i) => !a.startsWith('--') && (topIdx < 0 || (i !== topIdx + 1)));
  if (!positional.length) { console.log('usage: node detect-cadence.js SYM|0xaddr... [--top N]'); process.exit(1); }

  let sym = null, wallets = [];
  if (positional[0].startsWith('0x')) wallets = positional.map((a) => ({ addr: a, bal: 0 }));
  else {
    sym = positional[0].toUpperCase();
    const rep = JSON.parse(readFileSync('data/vesting-discovery.json', 'utf8'))[sym];
    if (!rep?.contracts?.length) { console.error(`${sym} not in data/vesting-discovery.json — run discover-vesting.js first`); process.exit(1); }
    wallets = rep.contracts.filter((c) => c.bucket === 'D' || c.bucket === 'C')
      .sort((a, b) => b.bal - a.bal).slice(0, topN);
  }
  console.log(`cadence scan: ${sym ?? 'explicit'} · ${wallets.length} wallets`);

  const familyByDay = {};
  const perWallet = [];
  for (const w of wallets) {
    const byDay = await outflowsByDay(w.addr, sym);
    for (const [d, v] of Object.entries(byDay)) familyByDay[d] = (familyByDay[d] || 0) + v;
    const solo = detectCadence(byDay);
    perWallet.push({ addr: w.addr, bal: w.bal, days: Object.keys(byDay).length, solo: solo.verdict === 'CADENCE' ? solo : solo.verdict });
    process.stdout.write('.');
    await sleep(350);
  }
  console.log();
  const family = detectCadence(familyByDay);
  console.log('\nFAMILY AGGREGATE:', JSON.stringify(family, null, 1));
  console.log('\nper-wallet:');
  for (const p of perWallet) {
    const s = typeof p.solo === 'string' ? p.solo
      : `CADENCE ${p.solo.pattern} day~${p.solo.targetDay} x${p.solo.monthsRun}mo mean ${p.solo.meanAmount}`;
    console.log(` ${p.addr.slice(0, 12)} bal ${String(p.bal).padStart(11)} · ${s}`);
  }
  const reportPath = 'data/cadence-report.json';
  const rep = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
  rep[sym ?? wallets[0].addr] = { at: new Date().toISOString().slice(0, 16), family, perWallet };
  writeFileSync(reportPath + '.tmp', JSON.stringify(rep, null, 1));
  renameSync(reportPath + '.tmp', reportPath);
  console.log('\n-> data/cadence-report.json');
  // Per-wallet hits are the primary signal: a family whose wallets emit on DIFFERENT
  // days is correctly IRREGULAR in aggregate while individually metronomic.
  const hits = perWallet.filter((p) => typeof p.solo === 'object');
  if (family.verdict === 'CADENCE' || hits.length)
    console.log(`\nEVIDENCE GRADE: ${hits.length} wallet(s) with consecutive-month cadence${family.verdict === 'CADENCE' ? ' + family-level cadence' : ''} — promoteRow(source:'onchain-cadence') candidate. A HUMAN CONFIRMS; this tool never promotes.`);
})();
