// Funding-rate extremes on Binance USDT-perps — your best-performing signal.
// v0.6: adds funding VELOCITY (is the squeeze building?) and OPEN INTEREST
// confirmation (is real money behind it?). OI is only fetched for the handful
// of symbols that already clear the funding bar, so the call cost stays tiny.
import { dispatch } from '../../core/dispatcher.js';

const RULES = {
  extremePct: Number(process.env.FUNDING_MIN_PCT || 0.5),  // |funding| >= this %/8h -> alert (user-tuned)
  severePct: Number(process.env.FUNDING_SEVERE_PCT || 0.75), // |funding| >= this -> extra-severe
  velocityPct: 0.03,   // funding moved this much since last poll -> squeeze building
  oiSurgePct: 10,      // open interest up this much in ~1h -> real positioning
  intervalSec: 900,    // poll every 15 min
  cooldownMin: 240,
};

let lastPoll = 0;
const prevFunding = new Map(); // symbol -> last funding %
const oiHistory = new Map();   // symbol -> [{oi, ts}]

async function longShortRatio(symbol) {
  try {
    const res = await fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=15m&limit=1`);
    if (!res.ok) return null;
    const j = await res.json();
    if (!j[0]) return null;
    return {
      ratio: Number(j[0].longShortRatio),
      longPct: Number(j[0].longAccount) * 100,
      shortPct: Number(j[0].shortAccount) * 100,
    };
  } catch { return null; }
}

async function openInterest(symbol) {
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`);
    if (!res.ok) return null;
    const j = await res.json();
    return Number(j.openInterest) || null;
  } catch { return null; }
}

export async function pollFunding() {
  if (Date.now() - lastPoll < RULES.intervalSec * 1000) return;
  lastPoll = Date.now();
  let data;
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex');
    if (!res.ok) throw new Error(`fapi ${res.status}`);
    data = await res.json();
  } catch (e) { console.error('[funding] poll failed:', e.message); return; }

  const candidates = [];
  for (const r of data) {
    if (!r.symbol.endsWith('USDT')) continue;
    const f = Number(r.lastFundingRate) * 100;
    const prev = prevFunding.get(r.symbol);
    prevFunding.set(r.symbol, f);
    if (Math.abs(f) < RULES.extremePct) continue;
    candidates.push({ symbol: r.symbol, f, mark: Number(r.markPrice), prev });
  }

  let n = 0;
  for (const c of candidates.slice(0, 25)) { // cap OI calls per cycle
    const [oi, ls] = await Promise.all([openInterest(c.symbol), longShortRatio(c.symbol)]);
    const hist = oiHistory.get(c.symbol) || [];
    if (oi) { hist.push({ oi, ts: Date.now() }); while (hist.length > 5) hist.shift(); oiHistory.set(c.symbol, hist); }
    const oldOi = hist.length > 1 ? hist[0].oi : null;
    const oiChange = oldOi ? ((oi - oldOi) / oldOi) * 100 : null;

    const shortsPay = c.f < 0;
    // velocity: is the funding becoming MORE extreme since last poll?
    const velocity = c.prev !== undefined ? c.f - c.prev : null;
    const building = velocity !== null && Math.sign(velocity) === Math.sign(c.f) && Math.abs(velocity) >= RULES.velocityPct;
    const oiConfirm = oiChange !== null && oiChange >= RULES.oiSurgePct;

    // Severity: extremes alone = MEDIUM; add velocity or OI confirmation for HIGH
    const severe = Math.abs(c.f) >= RULES.severePct;
    const severity = (severe && (building || oiConfirm)) ? 'HIGH'
      : (severe || building || oiConfirm) ? 'HIGH' : 'MEDIUM';

    const lines = [
      shortsPay ? `Shorts paying longs ${Math.abs(c.f).toFixed(3)}%/8h — crowded short, squeeze fuel`
                : `Longs paying shorts ${Math.abs(c.f).toFixed(3)}%/8h — crowded long, flush risk`,
    ];
    if (building) lines.push(`⚡ Squeeze BUILDING: funding moved ${velocity > 0 ? '+' : ''}${velocity.toFixed(3)}% since last check`);
    if (oiConfirm) lines.push(`📈 Open interest +${oiChange.toFixed(1)}% — real money entering, not just noise`);
    else if (oiChange !== null) lines.push(`Open interest ${oiChange >= 0 ? '+' : ''}${oiChange.toFixed(1)}%`);
    // Long/short crowd confirmation: extreme positioning is where reversals fire
    if (ls) {
      const crowded = ls.longPct >= 70 ? 'long' : ls.shortPct >= 65 ? 'short' : null;
      let posLine = `Positioning: ${ls.longPct.toFixed(0)}% of traders LONG vs ${ls.shortPct.toFixed(0)}% SHORT`;
      if (crowded) posLine += ` — crowd heavily ${crowded}, reversal risk`;
      if (crowded && shortsPay === (crowded === 'short')) posLine += ' ⚡ matches funding';
      lines.push(posLine);
    }
    lines.push(`Mark price: $${c.mark}`);

    if (await dispatch({
      source: 'CEX', type: 'FUNDING', severity, key: c.symbol, cooldownMin: RULES.cooldownMin,
      title: `${c.symbol} funding ${c.f.toFixed(3)}%/8h${building ? ' (building)' : ''}${oiConfirm ? ' + OI surge' : ''}`,
      lines, url: `https://www.binance.com/en/futures/${c.symbol}`,
      track: { kind: 'cex', exchange: 'binance', symbol: c.symbol, price: c.mark },
    })) n++;
  }
  console.log(`[funding] ${data.length} perps · ${candidates.length} extremes${n ? ` · ${n} alerts` : ''}`);
}
export { RULES };
