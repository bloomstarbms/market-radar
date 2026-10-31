// Fixture 90/92's child. Runs ONLY inside a boot-check copy (token blank, network stubbed). Each mode is
// a separate process, so "restart" is a real one: module memory gone, state.json read back from disk.
//   one    note event A (tx 0xfx92a), exit
//   two    note event B (tx 0xfx92b) and a three-token tx (0xfx90batch); report what CONFLUENCE sees,
//          fire A, B and the batch's first token, then try its other two tokens
//   three  report what is left after a second restart (consumed events stay consumed)
import { existsSync } from 'node:fs';
if (!existsSync('.copy-marker')) { console.error('whale-persist-child: refusing, not a boot-check copy'); process.exit(2); }
globalThis.fetch = async () => { throw new Error('fixture 92: no network'); };
const mode = process.argv[2];
const origLog = console.log;
console.log = () => {}; console.error = () => {};
const { load, getState, save } = await import('../src/core/store.js');
const { loadOutcomes } = await import('../src/core/outcomes.js');
load(); loadOutcomes();
const b = await import('../src/core/budget.js');
const c = await import('../src/core/confluence.js');
const st = getState();
const A = 'ethereum:0xfx92aaaa', B = 'ethereum:0xfx92bbbb', C = ['ethereum:0xfx90c1', 'ethereum:0xfx90c2', 'ethereum:0xfx90c3'];
const w = (sym) => ({ direction: 'Binance → wallet (WITHDRAWAL)', exchange: 'Binance', usd: 2e6, symbol: sym, isWithdrawal: true, label: 'accumulation', history: 'used' });
const pair = (key, sym) => ({ chainId: 'ethereum', baseToken: { address: key.split(':')[1], symbol: sym }, priceUsd: '2', liquidity: { usd: 1e6 }, url: '' });
const active = { volH1: 200e3, volAvgH1: 10e3, priceH1: 1, cex: null };
const run = (fn) => b.withLadder({}, () => b.withMultipliers({}, fn));
const out = { mode };
if (mode === 'one') {
  st.whaleEvents = {};
  Object.assign(st, { budgetLog: [], ladder: {}, threads: {}, suppressed: {}, recur: {}, alerted: {}, lastAlert: {} });
  c.noteWhale(A, { ...w('FXA'), hash: '0xfx92a' });
  save();
  out.eventsA = c.whaleEventsFor(A).length;
} else if (mode === 'two') {
  out.afterRestartA = c.whaleEventsFor(A).map((e) => e.hash);
  c.noteWhale(B, { ...w('FXB'), hash: '0xfx92b' });
  out.seen = Object.values(st.whaleEvents).map((e) => e.hash).sort();
  out.firedA = await run(() => c.checkConfluence(pair(A, 'FXA'), active));
  out.firedB = await run(() => c.checkConfluence(pair(B, 'FXB'), active));
  // one transaction, three watchlist tokens: one event, one call
  for (const [i, k] of C.entries()) c.noteWhale(k, { ...w('FXC' + i), hash: '0xfx90batch' });
  out.batchEvents = Object.values(st.whaleEvents).filter((e) => e.hash === '0xfx90batch').map((e) => Object.keys(e.tokens).length);
  out.firedC = [];
  for (const [i, k] of C.entries()) out.firedC.push(await run(() => c.checkConfluence(pair(k, 'FXC' + i), active)));
  c.noteWhale(C[2], { ...w('FXC2'), hash: '0xfx90batch' }); // the same tx seen again by a later poll
  out.revived = !!c.accumulationFor(C[2]);
} else if (mode === 'three') {
  out.left = Object.values(st.whaleEvents).map((e) => ({ hash: e.hash, consumed: !!e.consumed })).sort((x, y) => x.hash.localeCompare(y.hash));
  out.accumA = !!c.accumulationFor(A);
}
console.log = origLog;
console.log('FX92-RESULT ' + JSON.stringify(out));
process.exit(0);
