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
import { spanCovered } from './src/core/pagination.js';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 15s abort — a stalled connection must not eat a scan slice (same fix as discovery).
const jget = async (url) => { try { const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); return await r.json(); } catch { return null; } };

// PAGINATION IS THE FAILURE MODE HERE, not a tuning knob: EIGEN's monthly emission
// is a BATCH of dozens of transfers, so 4 pages (200 transfers) covered only 3 months
// and the validation gate returned INSUFFICIENT on the known metronome. Depth must be
// driven by DATE SPAN (>= 14 months), not page count.
// deadlineTs (optional): stop paginating when past it — a busy wallet must yield a
// truncated-but-labelled result inside a bounded slice, not eat the whole run.
export async function outflowsByDay(addr, tokenSym, maxPages = 30, deadlineTs = null) {
  const byDay = {};
  let next = '', oldest = null;
  const cutoff = new Date(Date.now() - 14 * 30.44 * 86400e3).toISOString().slice(0, 10);
  for (let p = 0; p < maxPages; p++) {
    if (deadlineTs && Date.now() > deadlineTs) break;
    const j = await jget(`https://eth.blockscout.com/api/v2/addresses/${addr}/token-transfers?filter=from${next}`);
    for (const t of (j?.items || [])) {
      const d = (t.timestamp || '').slice(0, 10);
      if (d && (!oldest || d < oldest)) oldest = d;
      if (tokenSym && (t.token?.symbol || '') !== tokenSym) continue;
      const dec = Number(t.total?.decimals ?? 18);
      if (d) byDay[d] = (byDay[d] || 0) + Number(t.total?.value || 0) / 10 ** dec;
    }
    if (spanCovered(oldest, cutoff)) break; // span covered — enough history for 12-month cadence
    if (!j?.next_page_params) break;
    next = '&' + Object.entries(j.next_page_params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    await sleep(280);
  }
  return byDay;
}

// ARBITRUM ONE (2026-11-04): the same per-day outflow series, read through Etherscan V2 (chainid
// 42161, the bot's existing free key — tokentx answers there; Blockscout's Arbitrum instance is
// challenge-walled). Filtered by the token's CONTRACT ADDRESS, not its symbol (a spoof token can
// carry any symbol). Etherscan pages by page×offset ≤ 10,000 rows, newest first; the walk stops
// when the date span is covered (spanCovered, the same guard as above) and reports `covered`.
const ES_KEY = (() => { try { return readFileSync('.env', 'utf8').match(/ETHERSCAN_API_KEY=(\S+)/)?.[1] ?? ''; } catch { return ''; } })();
const ES_CHAIN = { arbitrum: 42161 };
export async function outflowsByDayEtherscan(addr, tokenAddr, chain, { maxPages = 10, now = Date.now() } = {}) {
  const byDay = {};
  let oldest = null;
  const cutoff = new Date(now - 14 * 30.44 * 86400e3).toISOString().slice(0, 10);
  for (let page = 1; page <= maxPages; page++) {
    let j = null;
    for (let i = 0; i < 4 && !j; i++) {
      j = await jget(`https://api.etherscan.io/v2/api?chainid=${ES_CHAIN[chain]}&module=account&action=tokentx&contractaddress=${tokenAddr}&address=${addr}&page=${page}&offset=1000&sort=desc&apikey=${ES_KEY}`);
      if (j && /rate limit/i.test(String(j.result))) { j = null; await sleep(1500); }
    }
    if (!j) return { byDay, covered: false, oldest, reason: 'fetch failed' };
    const rows = Array.isArray(j.result) ? j.result : [];
    for (const t of rows) {
      const d = new Date(Number(t.timeStamp) * 1000).toISOString().slice(0, 10);
      if (!oldest || d < oldest) oldest = d;
      if (t.from.toLowerCase() !== addr.toLowerCase()) continue;
      byDay[d] = (byDay[d] || 0) + Number(t.value) / 10 ** Number(t.tokenDecimal || 18);
    }
    if (rows.length < 1000) return { byDay, covered: true, oldest }; // the wallet's whole history
    if (spanCovered(oldest, cutoff)) return { byDay, covered: true, oldest };
    await sleep(350);
  }
  return { byDay, covered: false, oldest, reason: `page cap (${maxPages * 1000} rows) before ${cutoff}` };
}

const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

// Dominant-class detection, NOT largest-per-month. Validation lesson (EIGEN wallet
// 0x34BcF805): 11 consecutive month-end emissions were present, but ONE off-schedule
// treasury move (Nov 19, 8.53M — the single largest day) out-sized Nov 30 and broke a
// naive "largest emission per month" cluster. Treasuries make occasional ad-hoc moves;
// the cadence is the DOMINANT class, and off-schedule moves are reported, not fatal.
// SIGNIFICANCE FLOOR (v0.33.9). It was 10% of the single largest day — logged as a soft
// spot on 2026-09-08, made blocking by ENA on 2026-10-06: one 186M day lifted the floor
// to 18.6M, above every normal 10-13M emission, and a 13-month metronome read
// INSUFFICIENT. Now 10% of the MEDIAN of the top-k days, k = months in the span (at
// least 4): a median of the largest days is what a "typical emission" is, and one
// outlier cannot move it. `floor: 'peak'` keeps the old rule so the change is
// demonstrated, not asserted. `now` is injectable: "the run must be current" used the
// wall clock, which would rot every fixture built on real dates.
export function significanceFloor(values, months, mode = 'median-top') {
  if (!values.length) return 0;
  if (mode === 'peak') return Math.max(...values) * 0.1;
  const k = Math.max(4, months);
  const top = [...values].sort((a, b) => b - a).slice(0, k);
  const mid = Math.floor(top.length / 2);
  const median = top.length % 2 ? top[mid] : (top[mid - 1] + top[mid]) / 2;
  return median * 0.1;
}
// exclude: months ('YYYY-MM') the operator marked excluded through annotate-verdict.js (a
// catch-up window is a real emission, so it still counts toward the RUN — the day held —
// but its amount stays out of meanAmount and cv, and the emission is listed `excluded`).
export function detectCadence(byDay, { minMonths = 4, minAmount = 0, floor = 'median-top', now = new Date(), exclude = new Set() } = {}) {
  const entries = Object.entries(byDay).filter(([, v]) => v > minAmount).sort();
  if (!entries.length) return { verdict: 'NO-OUTFLOWS' };
  const monthsInSpan = new Set(entries.map(([d]) => d.slice(0, 7))).size;
  const sigFloor = significanceFloor(entries.map(([, v]) => v), monthsInSpan, floor);
  const sig = entries.filter(([, v]) => v >= sigFloor)
    .map(([d, v]) => { const [y, m, day] = d.split('-').map(Number); return { d, y, m, day, v, last: lastDayOfMonth(y, m) }; });
  const monthKey = (e) => `${e.y}-${String(e.m).padStart(2, '0')}`;
  const monthIdx = (k) => { const [y, m] = k.split('-').map(Number); return y * 12 + m; };
  if (new Set(sig.map(monthKey)).size < minMonths)
    return { verdict: 'INSUFFICIENT', monthsSeen: new Set(sig.map(monthKey)).size, sigFloor: Math.round(sigFloor) };

  // Candidate classes: MONTH-END (within 2 days of month's last day — the EIGEN shape,
  // day 30 clamping to 28/29) and FIXED-DAY d for every d, tolerance ±1.
  const candidates = [{ id: 'ME', match: (e) => e.last - e.day <= 2 }];
  for (let d = 1; d <= 28; d++) candidates.push({ id: `D${d}`, match: (e) => Math.abs(e.day - d) <= 1, day: d });

  let best = null;
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;
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
  if (!best) return { verdict: 'IRREGULAR', sigDays: sig.length, sigFloor: Math.round(sigFloor) };

  const es = best.run.map((k) => best.perMonth[k]);
  const counted = es.filter((e) => !exclude.has(monthKey(e)));
  const amounts = (counted.length ? counted : es).map((e) => e.v);
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
  if (cv >= 1.0) return { verdict: 'DAY-STABLE-AMOUNT-UNSTABLE', pattern, targetDay, monthsRun: best.run.length, cv: +cv.toFixed(2), meanAmount: Math.round(mean), emissions: es.map((e) => ({ d: e.d, amt: Math.round(e.v), ...(exclude.has(monthKey(e)) ? { excluded: true } : {}) })), offSchedule, sigFloor: Math.round(sigFloor) };
  return {
    verdict: 'CADENCE', pattern, targetDay, monthsRun: best.run.length,
    meanAmount: Math.round(mean), cv: +cv.toFixed(2),
    firstSeen: es[0].d, lastSeen: es[es.length - 1].d,
    emissions: es.map((e) => ({ d: e.d, amt: Math.round(e.v), ...(exclude.has(monthKey(e)) ? { excluded: true } : {}) })),
    offSchedule,
  };
}

// ---- CLI (guarded: bulk-scan imports detectCadence/outflowsByDay; an unguarded
// IIFE would run this CLI against the importer's argv)
import { pathToFileURL } from 'node:url';
const IS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_CLI) (async () => {
  const args = process.argv.slice(2);
  const topIdx = args.indexOf('--top');
  const topN = topIdx >= 0 ? Number(args[topIdx + 1]) : 10;
  const chainIdx = args.indexOf('--chain');
  const chain = chainIdx >= 0 ? args[chainIdx + 1] : 'ethereum';
  if (chain !== 'ethereum' && !ES_CHAIN[chain]) { console.error(`--chain ${chain}: supported are ethereum (default) and ${Object.keys(ES_CHAIN).join(', ')}`); process.exit(1); }
  if (chain !== 'ethereum' && !ES_KEY) { console.error('ETHERSCAN_API_KEY missing from .env — the Arbitrum reader needs it'); process.exit(1); }
  const positional = args.filter((a, i) => !a.startsWith('--') && (topIdx < 0 || (i !== topIdx + 1)) && (chainIdx < 0 || i !== chainIdx + 1));
  if (!positional.length) { console.log('usage: node detect-cadence.js SYM|0xaddr... [--top N] [--chain arbitrum]'); process.exit(1); }

  let sym = null, wallets = [], tokenAddr = null;
  if (positional[0].startsWith('0x')) {
    if (chain !== 'ethereum') { console.error('--chain needs SYM mode: wallets and the token address come from data/vesting-discovery.json, never typed'); process.exit(1); }
    wallets = positional.map((a) => ({ addr: a, bal: 0 }));
  } else {
    sym = positional[0].toUpperCase();
    const rep = JSON.parse(readFileSync('data/vesting-discovery.json', 'utf8'))[sym];
    if (!rep?.contracts?.length) { console.error(`${sym} not in data/vesting-discovery.json — run discover-vesting.js${chain !== 'ethereum' ? ` ${sym} --chain ${chain}` : ''} first`); process.exit(1); }
    // On Arbitrum the discovery's chain must match, and VESTING WALLETS (bucket A) are scanned too:
    // there the schedule's emitters ARE the vesting wallets (a release is the outflow).
    if (chain !== 'ethereum') {
      if (rep.chain !== 'arbitrum-one') { console.error(`${sym}'s discovery is for ${rep.chain}, not ${chain} — run discover-vesting.js ${sym} --chain ${chain}`); process.exit(1); }
      tokenAddr = rep.token;
    }
    const buckets = chain === 'ethereum' ? ['D', 'C'] : ['A', 'D', 'C'];
    wallets = rep.contracts.filter((c) => buckets.includes(c.bucket))
      .sort((a, b) => b.bal - a.bal).slice(0, topN);
  }
  console.log(`cadence scan: ${sym ?? 'explicit'} · ${chain} · ${wallets.length} wallets`);

  // Months the operator excluded through annotate-verdict.js (catch-up windows): read
  // from the watch's own file, never typed. They stay in the run, out of the mean.
  let exclude = new Set();
  try {
    const months = JSON.parse(readFileSync('data/cadence-watch.json', 'utf8')).months?.[sym] || {};
    exclude = new Set(Object.entries(months).filter(([, r]) => r?.excluded).map(([k]) => k));
  } catch { /* no watch state: nothing excluded */ }
  if (exclude.size) console.log(`excluded from the mean (annotate-verdict.js): ${[...exclude].join(', ')}`);
  const familyByDay = {};
  const perWallet = [];
  const uncovered = [];
  for (const w of wallets) {
    let byDay, covered = true;
    if (chain === 'ethereum') byDay = await outflowsByDay(w.addr, sym);
    else { const f = await outflowsByDayEtherscan(w.addr, tokenAddr, chain); byDay = f.byDay; covered = f.covered; if (!covered) uncovered.push(`${w.addr.slice(0, 12)} (${f.reason})`); }
    for (const [d, v] of Object.entries(byDay)) familyByDay[d] = (familyByDay[d] || 0) + v;
    const solo = detectCadence(byDay, { exclude });
    perWallet.push({ addr: w.addr, bal: w.bal, bucket: w.bucket, name: w.name ?? null, days: Object.keys(byDay).length, covered, solo: solo.verdict === 'CADENCE' ? solo : solo.verdict });
    process.stdout.write('.');
    await sleep(350);
  }
  console.log();
  const family = detectCadence(familyByDay, { exclude });
  // An uncovered wallet is "we did not look" for its older days: said, not hidden.
  if (uncovered.length) console.log(`\n⚠️ ${uncovered.length} wallet(s) not covered back 14 months — their older days are missing, not empty: ${uncovered.join(', ')}`);
  // Day-level family series, last 6 months: what the windows held, for the report.
  const recentDays = Object.entries(familyByDay).filter(([d]) => d >= new Date(Date.now() - 183 * 86400e3).toISOString().slice(0, 10)).sort();
  console.log(`\nfamily outflows by day, last 6 months (${recentDays.length} days with outflows):`);
  for (const [d, v] of recentDays) console.log(`  ${d}  ${Math.round(v).toLocaleString()}`);
  console.log('\nFAMILY AGGREGATE:', JSON.stringify(family, null, 1));
  console.log('\nper-wallet:');
  for (const p of perWallet) {
    const s = typeof p.solo === 'string' ? p.solo
      : `CADENCE ${p.solo.pattern} day~${p.solo.targetDay} x${p.solo.monthsRun}mo mean ${p.solo.meanAmount}`;
    console.log(` ${p.addr.slice(0, 12)} bal ${String(p.bal).padStart(11)} · ${s}`);
  }
  const reportPath = 'data/cadence-report.json';
  const rep = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
  rep[sym ?? wallets[0].addr] = { at: new Date().toISOString().slice(0, 16), chain, family, perWallet, ...(uncovered.length ? { uncovered } : {}) };
  writeFileSync(reportPath + '.tmp', JSON.stringify(rep, null, 1));
  renameSync(reportPath + '.tmp', reportPath);
  console.log('\n-> data/cadence-report.json');
  // Per-wallet hits are the primary signal: a family whose wallets emit on DIFFERENT
  // days is correctly IRREGULAR in aggregate while individually metronomic.
  const hits = perWallet.filter((p) => typeof p.solo === 'object');
  if (family.verdict === 'CADENCE' || hits.length)
    console.log(`\nEVIDENCE GRADE: ${hits.length} wallet(s) with consecutive-month cadence${family.verdict === 'CADENCE' ? ' + family-level cadence' : ''} — promoteRow(source:'onchain-cadence') candidate. A HUMAN CONFIRMS; this tool never promotes.`);
})();
