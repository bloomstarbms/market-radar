// ROUTE 2 — CONTRACT-CLIFF VERIFICATION via post-cliff claim clustering.
//
//   node detect-cliff-cluster.js SYM                  contract from discovery report (bucket C, largest)
//   node detect-cliff-cluster.js SYM 0xcontract       explicit contract (report-resolved prefix ok)
//   node detect-cliff-cluster.js --sweep SYM...       parameter sweep across tokens
//
// WHY: 2024-25 insider vesting is contract-CLAIMABLE — each beneficiary pulls
// individually, so custody-cadence (route 1) sees nothing. But claims CLUSTER in the
// days after a cliff opens. This points the same detection idea at the VESTING
// CONTRACT with a wider window, and requires the cluster to REPLAY on the index's
// past cliff dates. The aggregator's dates are the HYPOTHESIS; the chain is the TEST.
//
// The contract must look like vesting, not a bridge/exchange: outflows to MANY
// distinct recipients (bridges send to few, repeatedly). STO's LayerZero adapter
// produced a false custody hit last session; the recipient check is the guard.
//
// feedWasLooking applies: an uncovered window is NOT an empty window. Pagination must
// reach every cliff under test or the verdict is UNVERIFIED, never FAILED.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jget = async (url) => { try { const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); return await r.json(); } catch (e) { if (process.env.DEBUG_FETCH) console.error('[jget]', e.message, url.slice(0, 140)); return null; } };
const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

// RESUMABLE pagination cache (data/cliff-fetch-cache.json). A busy vesting proxy (L3:
// 2,000 transfers reach back five weeks) needs more pages than one ~170s slice, and a
// restart from page 1 every slice would never finish — the livelock class again.
// Progress (byDay, cursor, oldest) persists per contract+token and resumes.
const CACHE = 'data/cliff-fetch-cache.json';
const loadCache = () => { try { return existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}; } catch { return {}; } };
const saveCache = (c) => { writeFileSync(CACHE + '.tmp', JSON.stringify(c)); renameSync(CACHE + '.tmp', CACHE); };
const ser = (byDay) => Object.fromEntries(Object.entries(byDay).map(([d, r]) => [d, { amt: r.amt, to: [...r.to] }]));
const deser = (o) => Object.fromEntries(Object.entries(o || {}).map(([d, r]) => [d, { amt: r.amt, to: new Set(r.to) }]));

// Outflows from a contract, per day, WITH recipients. Date-span pagination + deadline.
// tokenAddr: filter server-side. SHARED lockup vaults (Hedgey, Sablier) hold dozens of
// tokens; RE's claims were buried past the page cap behind DOG/NET/PUFFER traffic and
// read as NO-CLUSTERS — a wrong verdict. With the filter, coverage is per token.
export async function outflowsWithRecipients(addr, sym, untilDate, { maxPages = 40, deadlineTs = null, tokenAddr = null, resume = true } = {}) {
  const key = `${addr.toLowerCase()}|${(tokenAddr || sym).toLowerCase()}`;
  const cache = resume ? loadCache() : {};
  const c0 = cache[key];
  const byDay = c0 ? deser(c0.byDay) : {};
  let next = c0?.next ?? '', oldest = c0?.oldest ?? null, pages = 0;
  if (c0?.done) return { byDay, covered: true, oldest, pages: 0, resumed: true };
  const tok = tokenAddr ? `&token=${tokenAddr}` : '';
  const persist = (done) => { if (resume) { cache[key] = { byDay: ser(byDay), next, oldest, done, at: new Date().toISOString().slice(0, 16) }; saveCache(cache); } };
  for (let p = 0; p < maxPages; p++) {
    if (deadlineTs && Date.now() > deadlineTs) break;
    const j = await jget(`https://eth.blockscout.com/api/v2/addresses/${addr}/token-transfers?filter=from${tok}${next}`);
    pages++;
    // A FAILED page is not a LAST page. The first run reported an empty L3 series as
    // covered:true after one transient Blockscout failure — "we did not look" wearing
    // "nothing there" clothes, in brand-new code. One retry, then UNCOVERED.
    if (j === null) {
      await sleep(1500);
      const again = await jget(`https://eth.blockscout.com/api/v2/addresses/${addr}/token-transfers?filter=from${tok}${next}`);
      if (again === null) { persist(false); return { byDay, covered: false, oldest, pages, reason: 'page fetch failed twice' }; }
      for (const t of (again.items || [])) { const d = (t.timestamp || '').slice(0, 10); if (d && (!oldest || d < oldest)) oldest = d; if ((t.token?.symbol || '').toUpperCase() !== sym.toUpperCase()) continue; const dec = Number(t.total?.decimals ?? 18); const amt = Number(t.total?.value || 0) / 10 ** dec; byDay[d] = byDay[d] || { amt: 0, to: new Set() }; byDay[d].amt += amt; byDay[d].to.add((t.to?.hash || '').toLowerCase()); }
      if (!again.next_page_params) { persist(true); return { byDay, covered: true, oldest, pages }; }
      if (oldest && oldest < untilDate) { persist(true); return { byDay, covered: true, oldest, pages }; }
      next = '&' + Object.entries(again.next_page_params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      await sleep(250); continue;
    }
    for (const t of (j?.items || [])) {
      const d = (t.timestamp || '').slice(0, 10);
      if (d && (!oldest || d < oldest)) oldest = d;
      if ((t.token?.symbol || '').toUpperCase() !== sym.toUpperCase()) continue;
      const dec = Number(t.total?.decimals ?? 18);
      const amt = Number(t.total?.value || 0) / 10 ** dec;
      byDay[d] = byDay[d] || { amt: 0, to: new Set() };
      byDay[d].amt += amt; byDay[d].to.add((t.to?.hash || '').toLowerCase());
    }
    if (!j?.next_page_params) { persist(true); return { byDay, covered: true, oldest, pages }; }
    if (oldest && oldest < untilDate) { persist(true); return { byDay, covered: true, oldest, pages }; }
    next = '&' + Object.entries(j.next_page_params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    if (pages % 5 === 0) persist(false);
    await sleep(250);
  }
  persist(false);
  return { byDay, covered: false, oldest, pages };
}

// PURE. byDay: {date: {amt, to:Set}}; cliffs: ['YYYY-MM-DD'...] (past). Returns per-
// cliff verdicts, the recipients-diversity check, and OFF-INDEX clusters (a strong
// cluster the index did not predict means the index is wrong or incomplete — reported,
// never silently ignored).
export function clusterVerdicts(byDay, cliffs, { windowDays = 5, minRatio = 3, minRecipients = 5 } = {}) {
  const days = Object.keys(byDay).sort();
  const inAnyWindow = new Set();
  const windows = cliffs.map((c) => {
    const start = new Date(c + 'T00:00:00Z').getTime();
    const ws = [];
    for (let i = 0; i < windowDays; i++) ws.push(new Date(start + i * 86400e3).toISOString().slice(0, 10));
    ws.forEach((d) => inAnyWindow.add(d));
    return { cliff: c, days: ws };
  });
  const nonWindow = days.filter((d) => !inAnyWindow.has(d)).map((d) => byDay[d].amt).sort((a, b) => a - b);
  const median = nonWindow.length ? nonWindow[Math.floor(nonWindow.length / 2)] : 0;
  const baseline = Math.max(median * windowDays, 1e-9);
  const perCliff = windows.map((w) => {
    let amt = 0; const to = new Set();
    for (const d of w.days) { const r = byDay[d]; if (r) { amt += r.amt; r.to.forEach((a) => to.add(a)); } }
    const ratio = amt / baseline;
    return { cliff: w.cliff, inWindow: Math.round(amt), ratio: +ratio.toFixed(2), recipients: to.size, cluster: ratio >= minRatio && to.size >= minRecipients };
  });
  // Off-index clusters: any rolling window of the same length, not overlapping a
  // cliff window, that would have qualified.
  const off = [];
  for (let i = 0; i < days.length; i++) {
    const start = new Date(days[i] + 'T00:00:00Z').getTime();
    const ws = []; for (let k = 0; k < windowDays; k++) ws.push(new Date(start + k * 86400e3).toISOString().slice(0, 10));
    if (ws.some((d) => inAnyWindow.has(d))) continue;
    let amt = 0; const to = new Set();
    for (const d of ws) { const r = byDay[d]; if (r) { amt += r.amt; r.to.forEach((a) => to.add(a)); } }
    if (amt / baseline >= minRatio && to.size >= minRecipients) { off.push({ from: days[i], inWindow: Math.round(amt), ratio: +(amt / baseline).toFixed(2), recipients: to.size }); i += windowDays - 1; }
  }
  const allRecipients = new Set(); for (const d of days) byDay[d].to.forEach((a) => allRecipients.add(a));
  const n = perCliff.length, hits = perCliff.filter((c) => c.cluster).length;
  return { baseline: Math.round(baseline), medianDaily: Math.round(median), perCliff, n, hits,
    verified: n >= 3 && hits / n >= 2 / 3, distinctRecipients: allRecipients.size, offIndexClusters: off,
    params: { windowDays, minRatio, minRecipients } };
}

export function loadCliffs(sym, now = Date.now()) {
  const idx = JSON.parse(readFileSync('data/unlock-index.json', 'utf8')).protocols.find((p) => p.symbol === sym);
  if (!idx) return { past: [], future: [] };
  const cliffs = idx.events.filter((e) => e.type === 'cliff').map((e) => day(e.t));
  const uniq = [...new Set(cliffs)];
  return { past: uniq.filter((d) => new Date(d + 'T00:00:00Z').getTime() + 86400e3 < now), future: uniq.filter((d) => new Date(d + 'T00:00:00Z').getTime() >= now) };
}

// Exported so the bridge-exclusion invariant is fixture-checked: a LayerZero adapter
// that emitted on a cadence day (STO, v0.29.0) is a BRIDGE, and must never reach the
// cluster detector as a vesting candidate.
export const NOT_VESTING_RX = /bridge|adapter|connector/i;
export function reportContracts(sym, discovery = null) {
  const r = (discovery || JSON.parse(readFileSync('data/vesting-discovery.json', 'utf8')))[sym];
  return (r?.contracts || []).filter((c) => c.bucket === 'C' && c.pctSupply >= 2 && !NOT_VESTING_RX.test(c.why || c.name || ''));
}

const IS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_CLI) (async () => {
  const budgetIdx = process.argv.indexOf('--budget');
  const budget = budgetIdx >= 0 ? Number(process.argv[budgetIdx + 1]) : 140;
  const args = process.argv.slice(2).filter((a, i) => !a.startsWith('--') && (budgetIdx < 0 || i + 2 !== budgetIdx + 1));
  const sweep = process.argv.includes('--sweep');
  const t0 = Date.now();
  const outPath = 'data/cliff-cluster-report.json';
  const report = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {};
  const syms = sweep ? args : [args[0]];
  for (const sym of syms) {
    if ((Date.now() - t0) / 1000 > budget) { console.log('budget reached; rerun to continue'); break; }
    const { past, future } = loadCliffs(sym);
    const cands = (!sweep && args[1]) ? [{ addr: args[1], pctSupply: null }] : reportContracts(sym);
    if (!cands.length) { report[sym] = { sym, verdict: 'NO-CANDIDATE-CONTRACT', at: new Date().toISOString().slice(0, 16) }; console.log(`${sym}: no candidate contract`); continue; }
    if (past.length < 3) { report[sym] = { sym, verdict: 'TOO-FEW-PAST-CLIFFS', pastCliffs: past.length, at: new Date().toISOString().slice(0, 16) }; console.log(`${sym}: ${past.length} past cliffs — untestable`); continue; }
    const earliest = past[0];
    const untilDate = new Date(new Date(earliest + 'T00:00:00Z').getTime() - 2 * 86400e3).toISOString().slice(0, 10);
    const results = [];
    for (const c of cands.slice(0, 2)) {
      const tokenAddr = (() => { try { return JSON.parse(readFileSync('data/resolution-map.json', 'utf8')).syms[sym]?.ethAddr ?? null; } catch { return null; } })();
      const f = await outflowsWithRecipients(c.addr, sym, untilDate, { deadlineTs: t0 + budget * 1000 - 5000, tokenAddr, maxPages: 400 });
      if (!f.covered) { results.push({ contract: c.addr, verdict: 'UNVERIFIED', reason: `fetch did not reach ${untilDate} (oldest ${f.oldest}, ${f.pages} pages) — not evidence` }); continue; }
      const grid = [];
      for (const windowDays of [3, 5, 7]) for (const minRatio of [2, 3, 5]) {
        const v = clusterVerdicts(f.byDay, past, { windowDays, minRatio });
        grid.push({ windowDays, minRatio, hits: v.hits, n: v.n, off: v.offIndexClusters.length });
      }
      const v = clusterVerdicts(f.byDay, past, { windowDays: 5, minRatio: 3 });
      results.push({ contract: c.addr, pctSupply: c.pctSupply, verdict: v.verified ? 'CLUSTERS-REPLAY' : v.hits ? 'PARTIAL' : 'NO-CLUSTERS', ...v, grid, pages: f.pages });
      console.log(`${sym} ${c.addr.slice(0, 10)} ${c.pctSupply ?? ''}%: ${v.hits}/${v.n} cliffs cluster (w5 r3) · recipients ${v.distinctRecipients} · off-index ${v.offIndexClusters.length} · ${v.verified ? 'REPLAYS' : 'no'}`);
      console.log('   ' + v.perCliff.map((p) => `${p.cliff}:${p.ratio}x/${p.recipients}r${p.cluster ? '✓' : '·'}`).join(' '));
    }
    report[sym] = { sym, pastCliffs: past, futureCliffs: future, results, at: new Date().toISOString().slice(0, 16) };
    writeFileSync(outPath + '.tmp', JSON.stringify(report, null, 1)); renameSync(outPath + '.tmp', outPath);
  }
  console.log('-> ' + outPath);
})();
