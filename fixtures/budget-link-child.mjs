// Fixture 88's child. Runs ONLY inside a boot-check copy (token blank, network stubbed) and drives the
// REAL dispatcher with the shapes that spend B-tier budget, then prints, as JSON, what the budget log
// and the outcomes table say about each other. Refuses to run anywhere without .copy-marker.
import { existsSync } from 'node:fs';
if (!existsSync('.copy-marker')) { console.error('budget-link-child: refusing, not a boot-check copy'); process.exit(2); }
// No network, except one deep synthetic book: MULTIEX now carries a track, so the executability gate
// runs on it, and an unreadable book would (correctly) suppress the call before it reached the budget.
globalThis.fetch = async (url) => {
  if (String(url).startsWith('https://api.mexc.com/api/v3/depth?symbol=FX88USDT&')) return { ok: true, status: 200, json: async () => ({ bids: [['0.4999', '2000000']], asks: [['0.5001', '2000000']] }) };
  throw new Error('fixture 88: no network');
};
const bugs = [];
const origErr = console.error;
console.error = (...a) => { const l = a.join(' '); if (/\[OPERATOR\]\[BUG\]/.test(l)) bugs.push(l); };
const { load, getState } = await import('../src/core/store.js');
const { loadOutcomes, allOutcomes } = await import('../src/core/outcomes.js');
load(); loadOutcomes();
const b = await import('../src/core/budget.js');
const { dispatch } = await import('../src/core/dispatcher.js');
const { multiexAlerts } = await import('../src/sources/cex/monitor.js');
const { noteWhale, checkConfluence } = await import('../src/core/confluence.js');
const st = getState();
Object.assign(st, { budgetLog: [], ladder: {}, threads: {}, suppressed: {}, recur: {}, alerted: {} });
const before = allOutcomes().length;
// Hermetic around admit (it runs before dispatch's first await): no ladder, neutral multipliers.
const run = (fn) => b.withLadder({}, () => b.withMultipliers({}, fn));
const out = {};
// 1. MULTIEX, as monitor.js builds it: four venues confirm FX88 up; mexc saw it first.
const moves = new Map([['FX88', { up: new Set(['mexc', 'gate', 'kucoin', 'bitget']), down: new Set(), track: { up: { kind: 'cex', exchange: 'mexc', symbol: 'FX88USDT', price: 0.5 } } }]]);
const [mx] = multiexAlerts(moves);
out.multiexTrack = mx.track;
out.multiex = await run(() => dispatch(mx));
// 2. CONFLUENCE, as the engine fires it: a withdrawal noted, then activity on the same token.
const pair = { chainId: 'ethereum', baseToken: { address: '0xfx88confluence', symbol: 'FXC' }, priceUsd: '2', liquidity: { usd: 1e6 }, url: '' };
noteWhale('ethereum:0xfx88confluence', { direction: 'Binance → wallet (WITHDRAWAL)', exchange: 'Binance', usd: 2e6, symbol: 'FXC', isWithdrawal: true });
out.confluence = await run(() => checkConfluence(pair, { volH1: 200e3, volAvgH1: 10e3, priceH1: 1 }));
// 3. The 29 Oct shape: a MULTIEX with no track (what Q was). 4. Any charge-bearing call without a price.
const bugsBefore = bugs.length;
out.oldMultiex = await run(() => dispatch({ source: 'SIG', type: 'MULTIEX', severity: 'HIGH', key: 'FX88OLD', cooldownMin: 60, title: 'FX88OLD moving UP on 4 exchanges at once', lines: [] }));
out.noPrice = await run(() => dispatch({ source: 'SIG', type: 'CONFLUENCE', severity: 'HIGH', key: 'ethereum:0xfx88noprice', title: 'FXN: accumulation + activity (ethereum)', lines: [], track: { kind: 'dex', chainId: 'ethereum', address: '0xfx88noprice', price: 0 } }));
out.refusalBugs = bugs.slice(bugsBefore);
out.budgetLog = [...st.budgetLog];
out.rows = allOutcomes().slice(before).map((r) => ({ ts: r.ts, type: r.type, charged: r.charged ?? null, suppressed: r.suppressed, exchange: r.exchange ?? null, symbol: r.symbol ?? null, address: r.address ?? null }));
out.audit = b.budgetAudit(st.budgetLog, allOutcomes());
out.bugs = bugs;
console.error = origErr;
console.log('FX88-RESULT ' + JSON.stringify(out));
process.exit(0);
