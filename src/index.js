import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { load, getState } from './core/store.js';
import { startBot, broadcast } from './core/telegram.js';
import { dispatch, formatAlert } from './core/dispatcher.js';
import { loadOutcomes, checkOutcomes, statsSummary } from './core/outcomes.js';
import { getPairsForTokens, bestPairPerToken } from './sources/dex/dexscreener.js';
import { checkRevival } from './sources/dex/revival.js';
import { pollCex } from './sources/cex/monitor.js';
import { pollFunding } from './sources/cex/funding.js';
import { checkWhales } from './sources/chain/whale.js';

const ONCE = process.argv.includes('--once');
const startedAt = Date.now();
let alertCount = 0;

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
        if (alert && await dispatch(alert)) alertCount++;
        await checkWhales(pair);
      }
    } catch (e) {
      console.error(`[dex] ${chainId} poll failed:`, e.message);
    }
  }
}

let lastHeartbeat = Date.now();
async function heartbeat() {
  if (!config.heartbeatHours || Date.now() - lastHeartbeat < config.heartbeatHours * 3600e3) return;
  lastHeartbeat = Date.now();
  const up = ((Date.now() - startedAt) / 3600e3).toFixed(1);
  await broadcast(formatAlert({
    source: 'SYS', type: 'HEARTBEAT', severity: 'LOW',
    title: 'Market Radar is alive',
    lines: [`Uptime ${up}h · ${alertCount} alerts this run · ${getState().subscribers.length} subscribers`, `/stats for the signal scoreboard`],
  }));
}

async function pollAll() {
  await Promise.allSettled([pollDex(), pollCex(), pollFunding()]);
  await checkOutcomes().catch(() => {});
  await heartbeat().catch(() => {});
}

async function main() {
  load();
  loadOutcomes();
  const whaleMode = (config.etherscanKey ? 'evm ' : '') + (config.heliusKey ? 'solana' : '') || 'OFF (no keys)';
  console.log(`Market Radar starting · poll ${config.pollIntervalSec}s · telegram ${config.telegramToken ? 'ON' : 'OFF (console-only)'} · cex [${config.cexExchanges.join(', ')}] · whale ${whaleMode}`);
  startBot();
  await pollAll();
  if (ONCE) { console.log('[once] done'); process.exit(0); }
  setInterval(pollAll, config.pollIntervalSec * 1000);
}

main();
