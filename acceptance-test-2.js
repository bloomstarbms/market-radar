// Acceptance test #2 (spec §9): 30-day Binance BTCUSDT replay -> zero "unusual
// volume" alerts on routine windows. Direct regression test for the 76.9x defect.
//
// v2: first run FAILED at z>=4, persistence=1 (68 alerts / 10 days — fat-tailed 5m
// volume makes MAD-z of 4 commonplace). This version sweeps z-threshold x persistence
// (consecutive windows required) so the parameter choice is measured, not guessed.
// It also separates "below notional floor" from "baseline invalid" — different facts.
import { buildHourlyBaseline } from './src/core/baseline.js';

const SYM = 'BTCUSDT';
const DAYS = 30, SPLIT = 20;
const end = Date.now();
const start = end - DAYS * 86400e3;

const candles = [];
let cursor = start;
while (cursor < end) {
  const u = `https://api.binance.com/api/v3/klines?symbol=${SYM}&interval=5m&startTime=${cursor}&limit=1000`;
  const res = await fetch(u);
  if (!res.ok) { console.error(`binance ${res.status} — aborting`); process.exit(1); }
  const page = await res.json();
  if (!page.length) break;
  for (const c of page) candles.push({ ts: c[0], volumeUsd: Number(c[7]) });
  cursor = page[page.length - 1][0] + 5 * 60e3;
  if (page.length < 1000) break;
}
const splitTs = start + SPLIT * 86400e3;
const train = candles.filter((c) => c.ts < splitTs);
const test = candles.filter((c) => c.ts >= splitTs);
const baseline = buildHourlyBaseline(train, { lookbackDays: SPLIT * 12, minCoverage: 0.9 });
const adv = train.reduce((s, c) => s + c.volumeUsd, 0) / SPLIT;
console.log(`fetched ${candles.length} candles · train ${train.length} · test ${test.length} · ADV $${(adv / 1e9).toFixed(2)}B · floor $${(0.005 * adv / 1e6).toFixed(1)}M`);

// Score every test window once.
const scored = test.map((c) => {
  const r = baseline.zFor(c.ts, c.volumeUsd, 250_000, adv);
  return { ts: c.ts, z: r.valid ? r.z : null, reason: r.reason };
});
const invalid = scored.filter((s) => s.z === null && !/floor/.test(String(s.reason))).length;
const floored = scored.filter((s) => /floor/.test(String(s.reason))).length;
console.log(`baseline-invalid ${invalid} · below-floor ${floored} · scoreable ${scored.filter((s) => s.z !== null).length}\n`);

console.log('alerts per 10 days (rows: z threshold, cols: consecutive windows required)');
console.log('           persist=1  persist=2  persist=3');
for (const zt of [4, 5, 6, 8, 10]) {
  const row = [];
  for (const persist of [1, 2, 3]) {
    let run = 0, alerts = 0, clusters = [];
    for (const s of scored) {
      const hit = s.z !== null && s.z >= zt;
      run = hit ? run + 1 : 0;
      if (run === persist) { alerts++; clusters.push(new Date(s.ts).toISOString().slice(5, 16)); }
    }
    row.push({ alerts, clusters });
  }
  console.log(`  z>=${String(zt).padEnd(3)}   ${row.map((r) => String(r.alerts).padStart(6)).join('     ')}` +
    (row[1].alerts > 0 && row[1].alerts <= 6 ? `    [p2 events: ${row[1].clusters.join(', ')}]` : ''));
}
