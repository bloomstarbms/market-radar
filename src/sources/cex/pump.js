// Pump detection over rolling in-memory snapshots (per exchange:symbol).
// Window = span of the snapshot buffer (~5 polls). Volume surge is measured
// against an EMA of per-window traded volume, so sustained-high-volume pairs
// don't alert forever.

const RULES = {
  bufferSize: 6,          // snapshots kept (~5 min at 60s polls)
  priceJumpPct: 5,        // % move across window -> signal
  bigMovePct: 10,         // % move across window -> strong signal
  volSurgeRatio: 5,       // window volume >= 5x its EMA
  minQuoteVol24h: 200_000,// ignore illiquid pairs (USD)
  minWindowVolUsd: 20_000,// ignore dust surges
};

const buffers = new Map(); // key -> [{price, vol24h, ts}]
const volEma = new Map();  // key -> EMA of window volume

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
  const windowMin = ((Date.now() - oldest.ts) / 60000).toFixed(0);

  // Traded volume within the window (24h rolling counter delta, floor at 0)
  const windowVol = Math.max(0, t.quoteVol24h - oldest.vol24h);
  const ema = volEma.get(key) ?? windowVol;
  volEma.set(key, ema * 0.85 + windowVol * 0.15);

  const signals = [];
  if (movePct >= RULES.bigMovePct)
    signals.push(`Price +${movePct.toFixed(1)}% in ${windowMin}m (BIG)`);
  else if (movePct >= RULES.priceJumpPct)
    signals.push(`Price +${movePct.toFixed(1)}% in ${windowMin}m`);
  if (ema > 0 && windowVol >= RULES.minWindowVolUsd && windowVol / ema >= RULES.volSurgeRatio)
    signals.push(`Volume surge: $${fmt(windowVol)} in ${windowMin}m (${(windowVol / ema).toFixed(1)}x normal)`);

  if (!signals.length || movePct < RULES.priceJumpPct) return null; // price move required

  const severity = (movePct >= RULES.bigMovePct && signals.length >= 2) ? 'HIGH'
    : (movePct >= RULES.bigMovePct || signals.length >= 2) ? 'MEDIUM' : 'LOW';
  return {
    source: 'CEX', type: 'PUMP', severity, key,
    title: `${t.symbol} pumping on ${exchange.toUpperCase()}`,
    lines: [...signals, `Price: $${t.price} · 24h: ${t.change24hPct >= 0 ? '+' : ''}${t.change24hPct.toFixed(1)}% · Vol24h: $${fmt(t.quoteVol24h)}`],
    url: chartUrl(exchange, t.symbol),
  };
}

function chartUrl(ex, symbol) {
  if (ex === 'binance') return `https://www.binance.com/en/trade/${symbol.replace('USDT', '_USDT')}`;
  if (ex === 'mexc') return `https://www.mexc.com/exchange/${symbol.replace('USDT', '_USDT')}`;
  return `https://www.bybit.com/en/trade/spot/${symbol.replace('USDT', '/USDT')}`;
}
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0);
export { RULES };
