// CEX orchestrator: poll each enabled exchange, run listing + pump checks.
import { EXCHANGES } from './exchanges.js';
import { checkPump, takeDebugStats } from './pump.js';
import { checkListings } from './listings.js';
import { dispatch } from '../../core/dispatcher.js';
import { config } from '../../config.js';

export async function pollCex() {
  for (const name of config.cexExchanges) {
    const fetcher = EXCHANGES[name];
    if (!fetcher) { console.error(`[cex] unknown exchange: ${name}`); continue; }
    try {
      const tickers = await fetcher();
      let alerts = 0;
      for (const listing of checkListings(name, tickers)) if (await dispatch(listing)) alerts++;
      for (const t of tickers) {
        const alert = checkPump(name, t);
        if (alert && await dispatch(alert)) alerts++;
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
}
