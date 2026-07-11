// Funding-rate extremes on Binance USDT-perps. Extreme negative funding on a
// beaten-down coin = shorts paying longs heavily = squeeze fuel.
import { dispatch } from '../../core/dispatcher.js';

const RULES = {
  extremePct: 0.10,   // |funding| >= 0.10% per 8h -> signal
  severePct: 0.25,    // |funding| >= 0.25% -> HIGH
  intervalSec: 900,   // poll every 15 min
  cooldownMin: 240,   // don't repeat the same symbol within 4h
};
let lastPoll = 0;

export async function pollFunding() {
  if (Date.now() - lastPoll < RULES.intervalSec * 1000) return;
  lastPoll = Date.now();
  let data;
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex');
    if (!res.ok) throw new Error(`fapi ${res.status}`);
    data = await res.json();
  } catch (e) { console.error('[funding] poll failed:', e.message); return; }

  let n = 0;
  for (const r of data) {
    if (!r.symbol.endsWith('USDT')) continue;
    const f = Number(r.lastFundingRate) * 100; // % per 8h
    if (Math.abs(f) < RULES.extremePct) continue;
    const shortsPay = f < 0;
    await dispatch({
      source: 'CEX', type: 'FUNDING', severity: Math.abs(f) >= RULES.severePct ? 'HIGH' : 'MEDIUM',
      key: r.symbol, cooldownMin: RULES.cooldownMin,
      title: `${r.symbol} funding ${f.toFixed(3)}%/8h on Binance perps`,
      lines: [
        shortsPay ? `Shorts are paying longs heavily — crowded short, squeeze fuel` : `Longs paying shorts heavily — crowded long, flush risk`,
        `Mark price: $${Number(r.markPrice)}`,
      ],
      url: `https://www.binance.com/en/futures/${r.symbol}`,
      track: { kind: 'cex', exchange: 'binance', symbol: r.symbol, price: Number(r.markPrice) },
    }) && n++;
  }
  console.log(`[funding] scanned ${data.length} perps${n ? `, ${n} extremes` : ''}`);
}
export { RULES };
