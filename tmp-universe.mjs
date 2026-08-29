import { readFileSync, writeFileSync } from 'node:fs';
import { classifySymbol } from './src/core/taxonomy.js';
const arr = JSON.parse(readFileSync('data/outcomes.json', 'utf8'));
const c = {};
for (const r of arr) {
  if (r.suppressed || !r.symbol) continue;
  const base = r.symbol.replace(/(USDT|USDC|BUSD|USD)$/, '');
  if (!base || base.length < 2) continue;
  c[base] = (c[base] || 0) + 1;
}
const uni = Object.keys(c).filter((s) => c[s] >= 3);
const kept = [], excluded = [];
for (const s of uni) { const v = classifySymbol(s); (v?.state === 'EXCLUDE' ? excluded : kept).push(s); }
const scanned = new Set(Object.keys(JSON.parse(readFileSync('data/vesting-discovery.json', 'utf8'))));
const inUnlocks = new Set(JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens.map((t) => t.sym));
const queue = kept.filter((s) => !scanned.has(s) && !inUnlocks.has(s)).sort();
console.log('bases n>=3:', uni.length, '| excluded(taxonomy):', excluded.length, '| kept:', kept.length, '| queue:', queue.length);
console.log('excluded sample:', excluded.slice(0, 8).join(','));
writeFileSync('data/scan-queue.json', JSON.stringify({ rule: 'base symbols (quote stripped) with >=3 unsuppressed outcome rows, taxonomy EXCLUDE dropped, minus scanned+unlocks.json — 2026-08-29', queue }, null, 1));
console.log(queue.join(' '));
