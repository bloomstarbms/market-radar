// Permanent regression fixtures. Run: node regression-fixtures.js
// Each entry here is a bug that actually shipped, expressed as an assertion.
import { classify, allowPriceDetector } from './src/core/taxonomy.js';
import { executableSize } from './src/core/executability.js';
import { robustZ, winsorize, buildHourlyBaseline } from './src/core/baseline.js';

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };

// --- RLUSD: liquid ($9.7M executable, measured live) AND untradeable-by-design.
// It sailed through the executability gate and was only stopped by taxonomy. Proof
// the two layers answer different questions; if either weakens, this catches it.
t('RLUSD classifies STABLECOIN', classify('RLUSDUSDT', { price: 1.0002, change24hPct: 0.01 }) === 'STABLECOIN');
t('RLUSD blocked from VOLUME', allowPriceDetector('RLUSDUSDT', { price: 1.0002, change24hPct: 0.01 }, 'VOLUME').allowed === false);
t('RLUSD allowed for DEPEG', allowPriceDetector('RLUSDUSDT', { price: 0.94, change24hPct: -6 }, 'DEPEG').allowed === true);

// --- one-sided book: deep asks, empty bids. The easy implementation walks only the
// asks and reports an exit that does not exist.
const trap = executableSize({ bids: [[99.9, 0.01]], asks: [[100.1, 1000]] }, 50);
t('executable size bound by EXIT side', Math.abs(trap.usd - 99.9 * 0.01) < 0.01);

// --- the 76.9x defect: gappy data must invalidate the baseline, never inflate a z.
const gappyBase = Array.from({ length: 10 }, (_, d) => ({ ts: Date.UTC(2026, 0, 1 + d, 3), volumeUsd: 5e6 }));
const b = buildHourlyBaseline(gappyBase, { lookbackDays: 30 });
t('gappy lookback -> baseline_invalid, no signal', b.zFor(Date.UTC(2026, 1, 1, 3), 1e9).valid === false);

// --- MAD=0 degenerate series must never signal.
t('degenerate MAD never signals', robustZ(Array(30).fill(100), 1e9).valid === false);

// --- winsorize off-by-one: quantile index must not select the max itself.
t('winsorize caps its own spike', Math.max(...winsorize([...Array(29).fill(100), 1e9])) === 100);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
