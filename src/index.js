import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { load } from './core/store.js';
import { startBot } from './core/telegram.js';
import { dispatch } from './core/dispatcher.js';
import { getPairsForTokens, bestPairPerToken } from './sources/dex/dexscreener.js';
import { checkRevival } from './sources/dex/revival.js';
import { pollCex } from './sources/cex/monitor.js';
import { checkWhales } from './sources/chain/whale.js';

const ONCE = process.argv.includes('--once');

function loadWatchlist() {
  const wl = JSON.parse(readFileSync(config.watchlistPath, 'utf8'));
  const byChain = {};
  for (const t of wl.tokens) (byChain[t.chainId] ||= []).push(t.address);
  return byChain;
}

async function pollDex() {
  const byChain = loadWatchlist();
  for (const [chainId, addrs] of Object.entries(byChain)) {
    try {
      const pairs = await getPairsForTokens(chainId, addrs);
      const best = bestPairPerToken(pairs);
      console.log(`[dex] ${chainId}: ${Object.keys(best).length}/${addrs.length} tokens found`);
      if (config.debug) {
        const top = Object.values(best).map(p => ({ s: p.baseToken.symbol, h1: p.priceChange?.h1 || 0, v: p.volume?.h1 || 0 }))
          .sort((a, b) => Math.abs(b.h1) - Math.abs(a.h1)).slice(0, 3);
        for (const t of top) if (t.h1 !== 0 || t.v > 0) console.log(`  [debug] ${chainId} active: ${t.s} ${t.h1 >= 0 ? '+' : ''}${t.h1}% 1h, $${(t.v/1000).toFixed(1)}K vol/1h`);
      }
      for (const pair of Object.values(best)) {
        const alert = checkRevival(pair);
        if (alert) await dispatch(alert);
        await checkWhales(pair); // on-chain whale transfers (needs API keys in .env)
      }
    } catch (e) {
      console.error(`[dex] ${chainId} poll failed:`, e.message);
    }
  }
}

async function pollAll() {
  await Promise.allSettled([pollDex(), pollCex()]);
}

async function main() {
  load();
  const whaleMode = (config.etherscanKey ? 'evm ' : '') + (config.heliusKey ? 'solana' : '') || 'OFF (no keys)';
  console.log(`Market Radar starting · poll ${config.pollIntervalSec}s · telegram ${config.telegramToken ? 'ON' : 'OFF (console-only)'} · cex [${config.cexExchanges.join(', ')}] · whale ${whaleMode}`);
  startBot();
  await pollAll();
  if (ONCE) { console.log('[once] done'); process.exit(0); }
  setInterval(pollAll, config.pollIntervalSec * 1000);
}

main();
