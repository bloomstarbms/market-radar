// CEX orchestrator: poll each enabled exchange, run pump checks, dispatch alerts.
import { EXCHANGES } from './exchanges.js';
import { checkPump } from './pump.js';
import { dispatch } from '../../core/dispatcher.js';
import { config } from '../../config.js';

export async function pollCex() {
  for (const name of config.cexExchanges) {
    const fetcher = EXCHANGES[name];
    if (!fetcher) { console.error(`[cex] unknown exchange: ${name}`); continue; }
    try {
      const tickers = await fetcher();
      let alerts = 0;
      for (const t of tickers) {
        const alert = checkPump(name, t);
        if (alert && await dispatch(alert)) alerts++;
      }
      console.log(`[cex] ${name}: ${tickers.length} USDT pairs scanned${alerts ? `, ${alerts} alerts` : ''}`);
    } catch (e) {
      console.error(`[cex] ${name} poll failed:`, e.message);
    }
  }
}
