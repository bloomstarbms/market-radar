// One-off repair: rebuild the BTC benchmark for alerts that never got scored.
//
// Background: alpha = alert return minus BTC return over the same window. Two ways
// that stamp went missing — alerts recorded before the benchmark feature existed
// (no btc at all), and alerts where Binance was unreachable at scoring time (btc
// stamped, but the alpha step silently skipped). Both left a usable price return
// on the row, so all that's missing is BTC, and BTC history is free to fetch.
//
// This is more accurate than the live path: it uses BTC at the exact checkpoint
// (ts + 1h/6h/24h) instead of "BTC right now, whenever scoring happened to run".
//
// Usage: node backfill-alpha.js          (dry run — reports, writes nothing)
//        node backfill-alpha.js --write  (makes a backup, then applies)
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const FILE = 'data/outcomes.json';
const WRITE = process.argv.includes('--write');
const CHECKPOINTS = [['h1', 3600e3], ['h6', 6 * 3600e3], ['h24', 24 * 3600e3]];

if (!existsSync(FILE)) { console.error(`missing ${FILE}`); process.exit(1); }
const rows = JSON.parse(readFileSync(FILE, 'utf8'));
console.log(`loaded ${rows.length} rows`);

// --- fetch hourly BTC candles covering the whole window (+24h for the last checkpoint)
const times = rows.map((r) => r.ts);
const from = Math.min(...times) - 3600e3;
const to = Math.max(...times) + 25 * 3600e3;
console.log(`fetching BTC 1h candles ${new Date(from).toISOString().slice(0, 10)} -> ${new Date(to).toISOString().slice(0, 10)}`);

const candles = [];
let cursor = from;
while (cursor < to) {
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${cursor}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`binance ${res.status} — aborting, nothing written`); process.exit(1); }
  const page = await res.json();
  if (!page.length) break;
  for (const c of page) candles.push([c[0], Number(c[4])]); // [openTime, close]
  cursor = page[page.length - 1][0] + 3600e3;
  if (page.length < 1000) break;
}
candles.sort((a, b) => a[0] - b[0]);
console.log(`got ${candles.length} candles`);
if (!candles.length) { console.error('no candles — aborting'); process.exit(1); }

// Nearest candle at or before t. Binary search: this runs ~8000 times.
function btcAt(t) {
  if (t < candles[0][0] || t > candles[candles.length - 1][0] + 3600e3) return 0;
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  return candles[lo][1];
}

let stamped = 0, scored = 0, skipped = 0;
for (const r of rows) {
  if (!r.btc) { const p = btcAt(r.ts); if (p) { r.btc = p; stamped++; } }
  if (!r.btc) { skipped++; continue; }
  for (const [label, ms] of CHECKPOINTS) {
    const ret = r.results?.[label];
    if (ret === undefined) continue;              // no price return recorded
    if (r.alpha?.[label] !== undefined) continue;  // already scored
    const later = btcAt(r.ts + ms);
    if (!later) continue;                          // checkpoint beyond our history
    const btcRet = ((later - r.btc) / r.btc) * 100;
    (r.alpha ??= {})[label] = Number((ret - btcRet).toFixed(2));
    scored++;
  }
}

const withAlpha = rows.filter((r) => r.alpha?.h24 !== undefined).length;
console.log(`\nBTC stamps added: ${stamped}`);
console.log(`alpha values computed: ${scored}`);
console.log(`rows with 24h alpha: ${withAlpha} / ${rows.length}`);
if (skipped) console.log(`rows still unscoreable (outside candle range): ${skipped}`);

if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write to apply.'); process.exit(0); }
copyFileSync(FILE, 'data/outcomes.backup.json');
writeFileSync(FILE, JSON.stringify(rows, null, 1));
console.log('\nbackup: data/outcomes.backup.json');
console.log('WRITTEN.');
