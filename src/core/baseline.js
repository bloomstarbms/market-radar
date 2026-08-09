// Robust volume baselines — spec §2.3.
//
// The defect this replaces: "BTCUSDT $8.79M in 5m (76.9x normal)" on Binance, where
// $8.79M/5m is an ordinary quiet window. A rolling MEAN over a lookback containing
// missing/zero candles collapses the denominator, and the very outliers you want to
// detect dominate whatever remains. Everything here follows from that autopsy:
//
//   median + MAD    fat-tailed volume; the mean is the bug
//   winsorize       one real spike must not poison the next 30 days of baseline
//   coverage gate   missing data -> baseline_invalid -> NO signal (never a big z)
//   hour-of-day     03:00 UTC volume compares against 03:00 UTC history
//   notional floor  a 105x multiple on $444k of volume is an artifact, not a signal
//
// Grid note: the spec asks for day-of-week x hour-of-day. With a 30d lookback that is
// ~4 samples per cell — degenerate for a median, let alone a MAD. Hour-of-day gives 30
// per cell, which is the honest choice until 90d+ of history exists. Documented, not
// hidden.

export function winsorize(series, lo = 0.01, hi = 0.99) {
  if (!series?.length) return [];
  const sorted = [...series].sort((a, b) => a - b);
  // Index against length-1: floor(0.99 * n) with n=30 selects the max itself, which
  // caps nothing — the exact off-by-one that lets a spike poison its own baseline.
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
  const [l, h] = [q(lo), q(hi)];
  return series.map((x) => Math.min(h, Math.max(l, x)));
}

export function median(xs) {
  if (!xs?.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 0.6745 scales MAD to be consistent with stdev under normality.
// MAD of 0 means a degenerate series — NEVER a signal, per spec.
export function robustZ(series, x) {
  if (!series || series.length < 20) return { z: 0, valid: false, reason: 'too-few-samples' };
  const w = winsorize(series);
  const med = median(w);
  const mad = median(w.map((v) => Math.abs(v - med)));
  if (mad === 0) return { z: 0, valid: false, reason: 'degenerate-mad' };
  return { z: (0.6745 * (x - med)) / mad, valid: true, med, mad };
}

// candles: [{ ts, volumeUsd }] hourly, ideally 30d. Refuses to produce a baseline for
// any hour bucket whose coverage is below `minCoverage` of expected non-zero bars —
// this single rule kills the 76.9x class of error.
export function buildHourlyBaseline(candles, { minCoverage = 0.9, lookbackDays = 30 } = {}) {
  const buckets = Array.from({ length: 24 }, () => []);
  for (const c of candles || []) {
    const v = Number(c.volumeUsd);
    if (!Number.isFinite(v)) continue;
    buckets[new Date(c.ts).getUTCHours()].push(v);
  }
  const expectedPerBucket = lookbackDays; // one sample per hour bucket per day
  const grid = buckets.map((xs) => {
    const nonZero = xs.filter((v) => v > 0);
    const coverage = nonZero.length / expectedPerBucket;
    if (coverage < minCoverage) return { valid: false, reason: `coverage-${(coverage * 100).toFixed(0)}%` };
    return { valid: true, series: winsorize(nonZero) };
  });
  return {
    grid,
    // Returns { z, valid, reason? } — invalid NEVER yields a signal.
    zFor(ts, volumeUsd, notionalFloorUsd = 250_000, adv = 0) {
      const cell = grid[new Date(ts).getUTCHours()];
      if (!cell.valid) return { z: 0, valid: false, reason: cell.reason };
      const r = robustZ(cell.series, volumeUsd);
      if (!r.valid) return r;
      // Absolute floor alongside the relative multiple: both must clear.
      const floor = Math.max(notionalFloorUsd, 0.005 * adv);
      if (volumeUsd < floor) return { z: r.z, valid: false, reason: `below-notional-floor-$${Math.round(floor / 1000)}k` };
      return r;
    },
  };
}
