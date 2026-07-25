// LIQUIDATION / DELEVERAGE CASCADE MONITOR
// Free liquidation dollar feeds are paywalled, but a sharp collapse in OPEN
// INTEREST means leveraged positions are being force-closed — that IS a
// liquidation cascade. Paired with a price move it marks capitulation bottoms
// (longs liquidated, price down) and blow-off tops (shorts squeezed, price up).
// We watch the majors — a BTC/ETH/SOL cascade is a market-wide event.
import { dispatch } from '../../core/dispatcher.js';

const RULES = {
  symbols: (process.env.CASCADE_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT').split(','),
  oiDropPct: Number(process.env.CASCADE_OI_DROP || 4),   // OI falls >= this % over the window
  priceMovePct: 2,                                        // with price moving >= this %
  intervalSec: 300,
  cooldownMin: 120,
};
let lastPoll = 0;

async function oiHist(symbol) {
  try {
    const res = await fetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=4`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
async function markPrice(symbol) {
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
    const j = await res.json();
    return Number(j.markPrice) || null;
  } catch { return null; }
}

const priceHist = new Map(); // symbol -> [{p, ts}]

export async function pollCascade() {
  if (Date.now() - lastPoll < RULES.intervalSec * 1000) return;
  lastPoll = Date.now();
  let n = 0;
  for (const sym of RULES.symbols) {
    const hist = await oiHist(sym);
    if (!hist || hist.length < 2) continue;
    const oiNow = Number(hist[hist.length - 1].sumOpenInterest);
    const oiThen = Number(hist[0].sumOpenInterest);
    const oiDrop = ((oiThen - oiNow) / oiThen) * 100; // positive = OI fell

    const p = await markPrice(sym);
    const ph = priceHist.get(sym) || [];
    if (p) { ph.push({ p, ts: Date.now() }); while (ph.length > 4) ph.shift(); priceHist.set(sym, ph); }
    const pOld = ph.length > 1 ? ph[0].p : p;
    const priceMove = pOld ? ((p - pOld) / pOld) * 100 : 0;

    if (oiDrop < RULES.oiDropPct || Math.abs(priceMove) < RULES.priceMovePct) continue;

    const longsHit = priceMove < 0; // price down + OI down = longs liquidated
    await dispatch({
      source: 'CEX', type: 'CASCADE', severity: oiDrop >= RULES.oiDropPct * 2 ? 'HIGH' : 'MEDIUM',
      key: sym, cooldownMin: RULES.cooldownMin,
      title: `${sym.replace('USDT', '')} deleveraging: OI −${oiDrop.toFixed(1)}%, price ${priceMove >= 0 ? '+' : ''}${priceMove.toFixed(1)}%`,
      lines: [
        `Open interest collapsed ${oiDrop.toFixed(1)}% — leveraged positions force-closed`,
        longsHit
          ? `Longs liquidated into the drop — often marks a local capitulation bottom`
          : `Shorts squeezed out on the way up — often marks a blow-off top`,
        `Cascades exhaust fast; the reversal often comes right after. Not an entry — a timing marker.`,
        `Mark price: $${p}`,
      ],
      url: `https://www.binance.com/en/futures/${sym}`,
      track: { kind: 'cex', exchange: 'binance', symbol: sym, price: p },
    }) && n++;
  }
  if (n) console.log(`[cascade] ${n} deleverage events on majors`);
}
export { RULES };
