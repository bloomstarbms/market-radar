// Pump / dump / volume-anomaly detection over rolling in-memory snapshots.
// Window = span of the snapshot buffer (~5 polls). Volume surge is measured
// against an EMA of per-window traded volume.

const RULES = {
  bufferSize: 6,           // snapshots kept (~5 min at 60s polls)
  priceJumpPct: 5,         // |move| across window -> signal
  bigMovePct: 10,          // |move| across window -> strong signal
  volSurgeRatio: 5,        // window volume >= 5x its EMA (with price move)
  volOnlyRatio: 10,        // >= 10x EMA with flat price -> stealth volume alert
  minQuoteVol24h: 200_000, // ignore illiquid pairs (USD)
  minWindowVolUsd: 20_000, // ignore dust surges
  minVolOnlyUsd: 100_000,  // stealth-volume alerts need real size
};

const buffers = new Map(); // key -> [{price, vol24h, ts}]
const volEma = new Map();  // key -> EMA of window volume

// Debug: collect per-poll stats so the monitor can log top movers / near-misses
let debugRows = [];
export function takeDebugStats() { const r = debugRows; debugRows = []; return r; }

export function checkPump(exchange, t) {
  if (!t.price || t.quoteVol24h < RULES.minQuoteVol24h) return null;
  const key = `${exchange}:${t.symbol}`;
  const buf = buffers.get(key) || [];
  buf.push({ price: t.price, vol24h: t.quoteVol24h, ts: Date.now() });
  if (buf.length > RULES.bufferSize) buf.shift();
  buffers.set(key, buf);
  if (buf.length < 3) return null; // need history first

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

  // 1) Directional move (pump or dump)
  if (absMove >= RULES.priceJumpPct) {
    const up = movePct > 0;
    const signals = [`Price ${up ? '+' : ''}${movePct.toFixed(1)}% in ${windowMin}m${absMove >= RULES.bigMovePct ? ' (BIG)' : ''}`];
    if (volSurging) signals.push(`Volume surge: $${fmt(windowVol)} in ${windowMin}m (${volRatio.toFixed(1)}x normal)`);
    const severity = (absMove >= RULES.bigMovePct && volSurging) ? 'HIGH'
      : (absMove >= RULES.bigMovePct || volSurging) ? 'MEDIUM' : 'LOW';
    return {
      source: 'CEX', type: up ? 'PUMP' : 'DUMP', severity, key,
      title: `${t.symbol} ${up ? 'pumping' : 'selling off'} on ${exchange.toUpperCase()}`,
      lines: [...signals, ctx],
      url: chartUrl(exchange, t.symbol),
    };
  }

  // 2) Stealth volume: big volume, flat price — possible accumulation/distribution
  if (windowVol >= RULES.minVolOnlyUsd && volRatio >= RULES.volOnlyRatio) {
    return {
      source: 'CEX', type: 'VOLUME', severity: volRatio >= RULES.volOnlyRatio * 2 ? 'MEDIUM' : 'LOW', key,
      title: `${t.symbol} unusual volume on ${exchange.toUpperCase()} (price flat)`,
      lines: [
        `$${fmt(windowVol)} traded in ${windowMin}m (${volRatio.toFixed(1)}x normal), price only ${movePct >= 0 ? '+' : ''}${movePct.toFixed(1)}%`,
        `Possible quiet accumulation or distribution before a move`,
        ctx,
      ],
      url: chartUrl(exchange, t.symbol),
    };
  }
  return null;
}

function chartUrl(ex, symbol) {
  if (ex === 'binance') return `https://www.binance.com/en/trade/${symbol.replace('USDT', '_USDT')}`;
  if (ex === 'mexc') return `https://www.mexc.com/exchange/${symbol.replace('USDT', '_USDT')}`;
  return `https://www.bybit.com/en/trade/spot/${symbol.replace('USDT', '/USDT')}`;
}
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0);
export { RULES };
