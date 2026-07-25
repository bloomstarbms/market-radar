// CEX orchestrator: poll each enabled exchange, run listing + pump checks.
import { EXCHANGES } from './exchanges.js';
import { checkPump, takeDebugStats } from './pump.js';
import { checkListings } from './listings.js';
import { dispatch } from '../../core/dispatcher.js';
import { config } from '../../config.js';

const lastFingerprint = new Map(); // exchange -> sum of all 24h volumes last poll

export async function pollCex() {
  const moves = new Map();
  for (const name of config.cexExchanges) {
    const fetcher = EXCHANGES[name];
    if (!fetcher) { console.error(`[cex] unknown exchange: ${name}`); continue; }
    try {
      const tickers = await fetcher();
      // Stale-feed guard: if the total 24h volume across ALL pairs is byte-identical
      // to last poll, the exchange served frozen data — skip it entirely this cycle.
      const fp = tickers.reduce((s, t) => s + (t.quoteVol24h || 0), 0);
      if (lastFingerprint.get(name) === fp) {
        console.log(`[cex] ${name}: stale feed detected, skipping poll`);
        continue;
      }
      lastFingerprint.set(name, fp);
      let alerts = 0;
      for (const listing of checkListings(name, tickers)) if (await dispatch(listing)) alerts++;
      for (const t of tickers) {
        const alert = checkPump(name, t);
        if (alert) {
          if (alert.type === 'PUMP' || alert.type === 'DUMP') {
            const base = t.symbol.replace('USDT', '');
            const m = moves.get(base) || { up: new Set(), down: new Set() };
            (alert.type === 'PUMP' ? m.up : m.down).add(name);
            moves.set(base, m);
          }
          if (await dispatch(alert)) alerts++;
        }
      }
      console.log(`[cex] ${name}: ${tickers.length} USDT pairs scanned${alerts ? `, ${alerts} alerts` : ''}`);
      if (config.debug) {
        const rows = takeDebugStats();
        const movers = [...rows].sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct)).slice(0, 3);
        const vols = [...rows].sort((a, b) => b.volRatio - a.volRatio).slice(0, 2);
        for (const r of movers) console.log(`  [debug] ${name} mover: ${r.symbol} ${r.movePct >= 0 ? '+' : ''}${r.movePct.toFixed(2)}% (window), vol ${r.volRatio.toFixed(1)}x`);
        for (const r of vols) if (r.volRatio > 2) console.log(`  [debug] ${name} volume: ${r.symbol} ${r.volRatio.toFixed(1)}x normal ($${(r.windowVol/1000).toFixed(0)}K in window)`);
      }
    } catch (e) {
      console.error(`[cex] ${name} poll failed:`, e.message);
    }
  }
  for (const [base, m] of moves) {
    const dir = m.up.size >= 3 ? 'up' : m.down.size >= 3 ? 'down' : null;
    if (!dir) continue;
    const venues = dir === 'up' ? [...m.up] : [...m.down];
    await dispatch({
      source: 'SIG', type: 'MULTIEX', severity: venues.length >= 4 ? 'HIGH' : 'MEDIUM',
      key: base, cooldownMin: 60,
      title: `${base} moving ${dir === 'up' ? 'UP' : 'DOWN'} on ${venues.length} exchanges at once`,
      lines: [
        `Confirmed across: ${venues.join(', ')}`,
        `A move on 3+ venues at once is real market-wide flow, not one exchange's wash trading`,
      ],
    });
  }
}
