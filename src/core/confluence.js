// CONFLUENCE ENGINE
// Two independent signals landing on the same token inside a short window are
// worth far more than either alone. The pattern we care about:
//   (1) coins LEAVING an exchange (withdrawal = accumulation / cold storage), and
//   (2) real market activity on that same token (volume spike / price move).
// Accumulation followed by activity is the actual revival footprint — as opposed
// to volume with no accumulation (noise) or accumulation with no follow-through.
import { dispatch } from './dispatcher.js';

const WINDOW_MS = 12 * 3600e3; // how long a whale event stays "fresh"
const whaleEvents = new Map(); // key -> { dir, exchange, usd, ts, symbol }

// Called by the whale module on every dispatched on-chain move.
export function noteWhale(key, { direction, exchange, usd, symbol, isWithdrawal }) {
  whaleEvents.set(key, { direction, exchange, usd, symbol, isWithdrawal, ts: Date.now() });
  // prune
  for (const [k, v] of whaleEvents) if (Date.now() - v.ts > WINDOW_MS) whaleEvents.delete(k);
}

// Called by the DEX poll with live market state for a watchlist token.
// Fires only when a recent WITHDRAWAL is paired with genuine market activity.
export async function checkConfluence(pair, { volH1, volAvgH1, priceH1 }) {
  const key = `${pair.chainId}:${pair.baseToken.address}`;
  const w = whaleEvents.get(key);
  if (!w || !w.isWithdrawal) return false;
  if (Date.now() - w.ts > WINDOW_MS) { whaleEvents.delete(key); return false; }

  const volRatio = volAvgH1 > 0 ? volH1 / volAvgH1 : 0;
  const hasActivity = (volRatio >= 2 && volH1 >= 50_000) || priceH1 >= 8;
  if (!hasActivity) return false;

  const hoursAgo = ((Date.now() - w.ts) / 3600e3).toFixed(1);
  const fired = await dispatch({
    source: 'SIG', type: 'CONFLUENCE', severity: 'HIGH', key, cooldownMin: 720,
    title: `${pair.baseToken.symbol}: accumulation + activity (${pair.chainId})`,
    lines: [
      `🔻 ${w.exchange} withdrawal $${fmt(w.usd)} — ${hoursAgo}h ago (coins left the exchange)`,
      `📊 Now moving: volume $${fmt(volH1)}/h (${volRatio.toFixed(1)}x avg)${priceH1 ? ` · price ${priceH1 >= 0 ? '+' : ''}${priceH1}% 1h` : ''}`,
      `Two independent signals aligned — accumulation followed by real activity`,
      `Price: $${pair.priceUsd} · Liq: $${fmt(pair.liquidity?.usd || 0)}`,
    ],
    url: pair.url,
    track: { kind: 'dex', chainId: pair.chainId, address: pair.baseToken.address, price: Number(pair.priceUsd) || 0 },
  });
  if (fired) whaleEvents.delete(key); // consume so it doesn't re-fire on the same whale event
  return fired;
}

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Number(n).toFixed(0);
