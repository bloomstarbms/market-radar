// Build the rescan queue from the FALLBACK index (top-250 by mcap; CryptoRank key
// invalid on v1 and v2 at 2026-09-04, public page unreachable). Rule recorded in the
// queue file so the population is reproducible and its weakness stated: a mcap index
// includes fully-distributed tokens, so the "chosen population" claim is weaker than
// a known-unlocks index would give. The falsification line still applies to the
// LOCKED-SUPPLY denominator, which conditions on having something to find.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { classifySymbol } from './src/core/taxonomy.js';

const idx = JSON.parse(readFileSync('data/top250-index.json', 'utf8')).coins;
const unlocks = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens;
const scanned = existsSync('data/vesting-discovery.json') ? Object.keys(JSON.parse(readFileSync('data/vesting-discovery.json', 'utf8'))) : [];
// No vesting by construction: fiat/asset-backed stables, wrapped/bridged majors,
// liquid-staking receipts, tokenised RWAs. Pattern + explicit list, both recorded.
const NO_VEST_RX = /^(W|CB|WST|ST|RS|EZ|WE|B|M|JITO)?(BTC|ETH|SOL|BNB)$|USD|DAI$|FRAX|PAXG|XAUT|BUIDL|FIGR|EURC|EURT|GHO$|LUSD|CRVUSD|USDE|USDS|USDD|TUSD|PYUSD|FDUSD|USD1|USDG|RLUSD|USDY|USYC|SUSDE|SDAI|WEETH|RETH|CBETH|LBTC|TBTC|SOLVBTC|FBTC|MSOL|BSOL|JITOSOL|STETH|WSTETH|CBBTC|WBTC|WETH/;
const inUnlocks = new Set(unlocks.map((t) => t.sym));
const dropped = { noVest: [], excluded: [], inUnlocks: [], scanned: [] };
const queue = [];
for (const c of idx) {
  const s = c.sym;
  if (NO_VEST_RX.test(s)) { dropped.noVest.push(s); continue; }
  if (classifySymbol(s)?.state === 'EXCLUDE') { dropped.excluded.push(s); continue; }
  if (inUnlocks.has(s)) { dropped.inUnlocks.push(s); continue; }
  if (scanned.includes(s)) { dropped.scanned.push(s); continue; }
  queue.push(s);
}
const rule = `top-250 by mcap (CoinGecko, fetched ${JSON.parse(readFileSync('data/top250-index.json', 'utf8')).at}) minus: no-vesting-by-construction (stables/wrapped/LST/RWA regex, ${dropped.noVest.length}), taxonomy EXCLUDE (${dropped.excluded.length}), already in unlocks.json (${dropped.inUnlocks.length}), already scanned (${dropped.scanned.length}). FALLBACK population — CryptoRank key invalid 2026-09-04.`;
writeFileSync('data/scan-queue.json', JSON.stringify({ rule, builtAt: new Date().toISOString().slice(0, 16), queue, dropped }, null, 1));
console.log('queue:', queue.length, '| dropped noVest', dropped.noVest.length, 'excluded', dropped.excluded.length, 'inUnlocks', dropped.inUnlocks.length, 'scanned', dropped.scanned.length);
console.log(queue.join(' '));
