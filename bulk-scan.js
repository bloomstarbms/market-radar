// BULK UNLOCK COVERAGE SCAN — coverage session orchestrator.
//
//   node bulk-scan.js --resolve          build/refresh data/resolution-map.json only
//   node bulk-scan.js --budget 420       scan until queue empty or budget (s) spent
//
// Wraps discover() + detectCadence() over data/scan-queue.json. Design constraints
// from the session brief, all load-bearing:
//   CHECKPOINTED   every token's result is written before the next starts; an
//                  interrupted run resumes (data/bulk-scan-state.json).
//   ERROR-ISOLATED one malformed token logs ERROR and the run continues.
//   TIME-BUDGETED  exits cleanly before the caller's timeout; rerun to continue.
//   RESOLUTION     CoinGecko mcap-rank (top-2000) — NOT DexScreener search, which
//                  resolved EIGEN to a symbol-squatter. Rule: highest-mcap coin with
//                  matching symbol; no top-2000 match => UNRESOLVED-LOWCAP (honest:
//                  below the rank floor, not "no token"). No eth platform =>
//                  NON-NATIVE with its platform list recorded (the L1 pile).
// READ-ONLY except its own outputs: resolution-map.json, bulk-scan-state.json,
// vesting-discovery.json (same file the manual tool writes), cadence-report.json.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { discover } from './discover-vesting.js';
import { detectCadence, outflowsByDay } from './detect-cadence.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJ = (p, d) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d; } catch { return d; } };
const writeJ = (p, o) => { writeFileSync(p + '.tmp', JSON.stringify(o, null, 1)); renameSync(p + '.tmp', p); };

const NATIVE_HINTS = ['solana', 'sui', 'aptos', 'the-open-network', 'starknet', 'sei-network', 'celestia',
  'osmosis', 'near-protocol', 'internet-computer', 'cardano', 'tron', 'binance-smart-chain'];

// CoinGecko free tier 429s after a handful of calls/min — every fetch retries with
// patient backoff, and fetched pages are cached into the map file so an interrupted
// resolution RESUMES (same checkpointing rule as the scan itself).
async function cgGet(url, tries = 7) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) { console.error(`  429, waiting ${25 * (i + 1)}s...`); await sleep(25000 * (i + 1)); continue; }
      return await r.json();
    } catch { await sleep(5000); }
  }
  return null;
}
async function buildResolutionMap(queue) {
  const map = readJ('data/resolution-map.json', { builtAt: null, syms: {}, ranks: {}, pagesDone: 0 });
  const ranks = map.ranks || {};
  for (let p = (map.pagesDone || 0) + 1; p <= 8; p++) {
    const j = await cgGet(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&page=${p}`);
    if (!Array.isArray(j)) { console.error('markets page', p, 'failed after retries'); break; }
    for (const c of j) ranks[c.id] = c.market_cap_rank ?? 9999;
    map.ranks = ranks; map.pagesDone = p;
    writeJ('data/resolution-map.json', map);
    console.log(`markets page ${p}: ${Object.keys(ranks).length} ranked`);
    await sleep(12000);
  }
  const list = await cgGet('https://api.coingecko.com/api/v3/coins/list?include_platform=true');
  if (!Array.isArray(list)) throw new Error('coins/list failed after retries — rerun --resolve; pages are cached');
  const bySym = {};
  for (const c of list) (bySym[c.symbol.toUpperCase()] = bySym[c.symbol.toUpperCase()] || []).push(c);
  for (const sym of queue) {
    const cands = (bySym[sym] || []).filter((c) => ranks[c.id] !== undefined)
      .sort((a, b) => ranks[a.id] - ranks[b.id]);
    if (!cands.length) { map.syms[sym] = { verdict: 'UNRESOLVED-LOWCAP', note: 'no CoinGecko coin with this symbol inside top-2000 mcap — below rank floor, NOT proof no token exists' }; continue; }
    const c = cands[0];
    const eth = c.platforms?.ethereum || null;
    const plats = Object.keys(c.platforms || {}).filter(Boolean);
    map.syms[sym] = {
      cgId: c.id, name: c.name, rank: ranks[c.id],
      ethAddr: eth, platforms: plats,
      ambiguity: cands.length > 1 ? cands.slice(1, 3).map((x) => `${x.id}@${ranks[x.id]}`) : undefined,
      verdict: eth ? 'ETH' : (plats.length ? 'NON-NATIVE' : 'NATIVE-L1'),
    };
  }
  map.builtAt = new Date().toISOString().slice(0, 16);
  writeJ('data/resolution-map.json', map);
  const c = {}; for (const v of Object.values(map.syms)) c[v.verdict] = (c[v.verdict] || 0) + 1;
  console.log('resolution map:', JSON.stringify(c));
  return map;
}

async function scanOne(sym, res, report, cadReport) {
  if (res.verdict === 'UNRESOLVED-LOWCAP') { report[sym] = { sym, verdict: 'UNRESOLVED-LOWCAP', note: res.note, at: new Date().toISOString().slice(0, 16) }; return 'UNRESOLVED-LOWCAP'; }
  if (res.verdict !== 'ETH') {
    report[sym] = { sym, verdict: 'NON-NATIVE', nativeChain: res.platforms?.[0] ?? 'own-chain', platforms: res.platforms, cgId: res.cgId,
      note: 'No Ethereum ERC-20 (CoinGecko platforms) — vesting, if any, lives off-Ethereum. Do NOT mistake for NO-LOCKED-SUPPLY.', at: new Date().toISOString().slice(0, 16) };
    return 'NON-NATIVE';
  }
  const r = await discover(sym, { addr: res.ethAddr, addrSource: `coingecko:${res.cgId} (mcap rank ${res.rank})` });
  // Cadence is a SEPARATE pass (detect-cadence.js) over the locked-supply shortlist:
  // the runtime environment caps any single invocation at ~170s and in-token work is
  // lost on the cap, so a cadence-heavy family inlined here livelocks — the token
  // restarts every call and never completes. Discovery stays cheap per token.
  if ((r.verdict === 'D-CUSTODY' || r.verdict === 'C-CUSTOM') && (r.contractHeldPctSupply ?? 0) >= 1) r.cadencePass = 'pending';
  report[sym] = r;
  return r.verdict;
}

(async () => {
  // No instance lock: the runtime runs each invocation in its own PID namespace with
  // die-with-parent — overlap is impossible, and a lockfile from a killed run would
  // only block the resume. (A lock was tried; the "overlapping scanner" it guarded
  // against turned out to be the grep matching its own wrapper.)
  const budget = Number(process.argv[process.argv.indexOf('--budget') + 1]) || 150;
  const queue = readJ('data/scan-queue.json', {}).queue || [];
  if (!queue.length) { console.error('no scan queue'); process.exit(1); }
  let map = readJ('data/resolution-map.json', null);
  if (process.argv.includes('--resolve') || !map?.builtAt) map = await buildResolutionMap(queue);
  if (process.argv.includes('--resolve')) process.exit(0);

  const state = readJ('data/bulk-scan-state.json', { done: {}, errors: {} });
  // FETCH-FAILED and ERROR are RETRYABLE, not settled — leaving them in done would
  // freeze a transient network failure into permanent non-coverage.
  for (const [s, v] of Object.entries(state.done)) if (v === 'FETCH-FAILED' || v === 'ERROR') delete state.done[s];
  const report = readJ('data/vesting-discovery.json', {});
  const cadReport = readJ('data/cadence-report.json', {});
  const t0 = Date.now();
  let n = 0;
  for (const sym of queue) {
    if (state.done[sym]) continue;
    if ((Date.now() - t0) / 1000 > budget) break;
    const res = map.syms[sym];
    if (!res) { state.done[sym] = 'NO-RESOLUTION-ENTRY'; continue; }
    try {
      const v = await scanOne(sym, res, report, cadReport);
      state.done[sym] = v;
      console.log(`${sym}: ${v}`);
    } catch (e) {
      state.done[sym] = 'ERROR';
      state.errors[sym] = String(e.message).slice(0, 200);
      console.log(`${sym}: ERROR ${e.message}`);
    }
    // CHECKPOINT EVERY TOKEN — a scan that dies at token 47 must have kept 46.
    writeJ('data/bulk-scan-state.json', state);
    writeJ('data/vesting-discovery.json', report);
    writeJ('data/cadence-report.json', cadReport);
    n++;
    await sleep(400);
  }
  const remaining = queue.filter((s) => !state.done[s]).length;
  const counts = {};
  for (const s of queue) if (state.done[s]) counts[String(state.done[s]).split(' ')[0]] = (counts[String(state.done[s]).split(' ')[0]] || 0) + 1;
  console.log(`\nthis run: ${n} tokens · remaining: ${remaining}`);
  console.log('cumulative:', JSON.stringify(counts));
  process.exit(remaining ? 2 : 0); // 2 = rerun to continue
})();
