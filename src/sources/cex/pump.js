// Pump / dump / volume-anomaly detection over rolling in-memory snapshots.
// Fast window ≈ bufferSize polls (~5 min); slow window ≈ 1h anchor for grinders.
import { CHART_URLS } from './exchanges.js';

const RULES = {
  bufferSize: 6,           // fast window snapshots (~5 min at 60s polls)
  priceJumpPct: 5,         // |move| across fast window -> signal
  bigMovePct: 10,          // |move| across fast window -> strong signal
  slowJumpPct: 10,         // |move| across ~1h anchor -> grinding move signal
  volSurgeRatio: 5,        // window volume >= 5x its EMA (with price move)
  volOnlyRatio: 10,        // >= 10x EMA with flat price -> stealth volume alert
  minQuoteVol24h: 200_000, // ignore illiquid pairs (USD)
  minWindowVolUsd: 20_000, // ignore dust surges
  minVolOnlyUsd: 100_000,  // stealth-volume alerts need real size
};

const buffers = new Map();  // key -> [{price, vol24h, ts}]
const volEma = new Map();   // key -> EMA of window volume
const hourAnchor = new Map(); // key -> {price, ts} refreshed when > 1h old

let debugRows = [];
export function takeDebugStats() { const r = debugRows; debugRows = []; return r; }

export function checkPump(exchange, t) {
  if (!t.price || t.quoteVol24h < RULES.minQuoteVol24h) return null;
  const key = `${exchange}:${t.symbol}`;
  const buf = buffers.get(key) || [];
  buf.push({ price: t.price, vol24h: t.quoteVol24h, ts: Date.now() });
  if (buf.length > RULES.bufferSize) buf.shift();
  buffers.set(key, buf);

  // slow anchor bookkeeping
  const anchor = hourAnchor.get(key);
  if (!anchor) hourAnchor.set(key, { price: t.price, ts: Date.now() });

  if (buf.length < 3) return null;

  const oldest = buf[0];
  const movePct = ((t.price - oldest.price) / oldest.price) * 100;
  const absMove = Math.abs(movePct);
  const windowMin = Math.max(1, Math.round((Date.now() - oldest.ts) / 60000));

  const windowVol = Math.max(0, t.quoteVol24h - oldest.vol24h);
  const ema = volEma.get(key) ?? windowVol;
  volEma.set(key, ema * 0.85 + windowVol * 0.15);
  const volRatio = ema > 0 ? windowVol / ema : 0;
  const volSurging = windowVol >= RULES.minWindowVolUsd && volRatio >= RULES.volSurgeRatio;

  debugRows.push({ symbol: t.symbol, movePct, volRatio, windowVol });
  const ctx = `Price: $${t.price} · 24h: ${t.change24hPct >= 0 ? '+' : ''}${t.change24hPct.toFixed(1)}% · Vol24h: $${fmt(t.quoteVol24h)}`;
  const track = { kind: 'cex', exchange, symbol: t.symbol, price: t.price };

  // 1) Fast directional move
  if (absMove >= RULES.priceJumpPct) {
    const up = movePct > 0;
    const signals = [`Price ${up ? '+' : ''}${movePct.toFixed(1)}% in ${windowMin}m${absMove >= RULES.bigMovePct ? ' (BIG)' : ''}`];
    if (volSurging) signals.push(`Volume surge: $${fmt(windowVol)} in ${windowMin}m (${volRatio.toFixed(1)}x normal)`);
    const severity = (absMove >= RULES.bigMovePct && volSurging) ? 'HIGH'
      : (absMove >= RULES.bigMovePct || volSurging) ? 'MEDIUM' : 'LOW';
    return { source: 'CEX', type: up ? 'PUMP' : 'DUMP', severity, key,
      title: `${t.symbol} ${up ? 'pumping' : 'selling off'} on ${exchange.toUpperCase()}`,
      lines: [...signals, ctx], url: CHART_URLS[exchange]?.(t.symbol), track };
  }

  // 2) Slow grind vs 1h anchor
  if (anchor && Date.now() - anchor.ts >= 3600e3) {
    const slowPct = ((t.price - anchor.price) / anchor.price) * 100;
    hourAnchor.set(key, { price: t.price, ts: Date.now() }); // reset anchor each hour
    if (Math.abs(slowPct) >= RULES.slowJumpPct) {
      const up = slowPct > 0;
      return { source: 'CEX', type: up ? 'PUMP' : 'DUMP', severity: Math.abs(slowPct) >= 2 * RULES.slowJumpPct ? 'HIGH' : 'MEDIUM', key: `${key}:1h`,
        title: `${t.symbol} ${up ? 'grinding up' : 'bleeding'} on ${exchange.toUpperCase()} (1h)`,
        lines: [`Price ${up ? '+' : ''}${slowPct.toFixed(1)}% over the last hour`, ctx],
        url: CHART_URLS[exchange]?.(t.symbol), track };
    }
  }

  // 3) Stealth volume: big volume, flat price
  if (windowVol >= RULES.minVolOnlyUsd && volRatio >= RULES.volOnlyRatio) {
    return { source: 'CEX', type: 'VOLUME', severity: volRatio >= RULES.volOnlyRatio * 2 ? 'MEDIUM' : 'LOW', key,
      title: `${t.symbol} unusual volume on ${exchange.toUpperCase()} (price flat)`,
      lines: [`$${fmt(windowVol)} traded in ${windowMin}m (${volRatio.toFixed(1)}x normal), price only ${movePct >= 0 ? '+' : ''}${movePct.toFixed(1)}%`,
        `Possible quiet accumulation or distribution before a move`, ctx],
      url: CHART_URLS[exchange]?.(t.symbol), track };
  }
  return null;
}

const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0);
export { RULES };
