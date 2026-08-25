// Executability gate — spec §1.2.
//
// For a $10k–$100k trader this is the highest-value filter in the system: it answers
// "could I actually take this position, and get back out?" 24h volume does not answer
// that — volume on MEXC/Gate low-float pairs is substantially wash traded, so the gate
// reads the L2 book directly.
//
// RUNTIME ORDER (deviates from the spec's phase order, deliberately):
// The spec has this refreshed every 5m for every symbol on every venue. That assumes
// free streaming L2 and was written for the VPS case; under REST polling it would be
// 412 symbols x 9 venues x 288 refreshes/day. So we SCORE FIRST (free, local) and gate
// only the survivors, cached 5m — same final output, ~1% of the requests. The gate
// still exists before any detector relies on it; only when it runs has changed.
import { config } from '../config.js';

const CACHE_MS = 5 * 60e3;
const cache = new Map(); // exch:symbol -> { at, result }

// AUDIT-TRIGGER: a BYPASS depends on these numbers. The tier-2 delist proxy pushes
// only on symbols this gate marks tradeable (standing in for position awareness until
// cross-cutting B lands), so moving minExecutableUsd silently moves which delist
// sweeps reach you. Changing anything here = re-run the bypass audit in
// REMAINING-WORK-NOTES.md ("unconditional bypass wearing a justification"), trigger 3.
export const GATE = {
  minExecutableUsd: Number(process.env.GATE_MIN_EXEC_USD || 25_000),
  maxSlippageBps: Number(process.env.GATE_SLIPPAGE_BPS || 50),
  maxSpreadBps: Number(process.env.GATE_MAX_SPREAD_BPS || 40),
  maxRoundTripBps: Number(process.env.GATE_MAX_ROUNDTRIP_BPS || 120),
  takerFeeBps: Number(process.env.GATE_TAKER_FEE_BPS || 10), // ~0.10% typical spot taker
};

// Walk one side of the book and return the USD notional executable before the price
// moves more than `slippageBps` from mid. Levels are [price, qty].
export function walkSide(levels, mid, slippageBps, side) {
  if (!levels?.length || !mid) return 0;
  const limit = side === 'buy' ? mid * (1 + slippageBps / 10_000) : mid * (1 - slippageBps / 10_000);
  let usd = 0;
  for (const [pRaw, qRaw] of levels) {
    const p = Number(pRaw), q = Number(qRaw);
    if (!Number.isFinite(p) || !Number.isFinite(q)) continue;
    if (side === 'buy' ? p > limit : p < limit) break; // past the slippage budget
    usd += p * q;
  }
  return usd;
}

// min(bid_side, ask_side) — you must be able to get OUT, not just in. Walking only the
// asks tells you how to enter and nothing about exiting, and the exit is the half that
// kills you on a microcap.
export function executableSize(book, slippageBps = GATE.maxSlippageBps) {
  const bestBid = Number(book.bids?.[0]?.[0]);
  const bestAsk = Number(book.asks?.[0]?.[0]);
  if (!bestBid || !bestAsk || bestAsk <= 0) return { usd: 0, spreadBps: Infinity, mid: 0 };
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
  const buyUsd = walkSide(book.asks, mid, slippageBps, 'buy');   // cost to enter
  const sellUsd = walkSide(book.bids, mid, slippageBps, 'sell'); // ability to exit
  return { usd: Math.min(buyUsd, sellUsd), buyUsd, sellUsd, spreadBps, mid };
}

// ---------------------------------------------------------------- venue books
// All public, keyless. Normalised to { bids:[[p,q]], asks:[[p,q]] }.
const DEPTH = {
  binance: (s) => [`https://api.binance.com/api/v3/depth?symbol=${s}&limit=100`, (j) => j],
  mexc: (s) => [`https://api.mexc.com/api/v3/depth?symbol=${s}&limit=100`, (j) => j],
  bybit: (s) => [`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${s}&limit=50`,
    (j) => ({ bids: j?.result?.b || [], asks: j?.result?.a || [] })],
  gate: (s) => [`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${s.replace('USDT', '_USDT')}&limit=100`,
    (j) => ({ bids: j?.bids || [], asks: j?.asks || [] })],
  kucoin: (s) => [`https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${s.replace('USDT', '-USDT')}`,
    (j) => ({ bids: j?.data?.bids || [], asks: j?.data?.asks || [] })],
  bitget: (s) => [`https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${s}&limit=100`,
    (j) => ({ bids: j?.data?.bids || [], asks: j?.data?.asks || [] })],
};

async function fetchBook(exchange, symbol) {
  const entry = DEPTH[exchange];
  if (!entry) return null;
  const [url, shape] = entry(symbol);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${exchange} depth ${res.status}`);
  return shape(await res.json());
}

// Returns { pass, status, executableUsd, spreadBps, roundTripBps, reasons[] }
// status: PASS | BLOCKED | UNVERIFIABLE — an unreadable book is not a liquid book, but
// it is also not a risk finding, so the funnel can tell them apart.
export async function checkExecutable(exchange, symbol) {
  const key = `${exchange}:${symbol}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  let result;
  try {
    const book = await fetchBook(exchange, symbol);
    if (!book) {
      result = { pass: false, status: 'UNVERIFIABLE', reasons: [`no-depth-endpoint-${exchange}`] };
    } else {
      const { usd, buyUsd, sellUsd, spreadBps } = executableSize(book);
      const roundTripBps = spreadBps + 2 * GATE.takerFeeBps;
      const reasons = [];
      if (usd < GATE.minExecutableUsd) reasons.push(`exec-$${Math.round(usd / 1000)}k`);
      if (spreadBps > GATE.maxSpreadBps) reasons.push(`spread-${spreadBps.toFixed(0)}bps`);
      if (roundTripBps > GATE.maxRoundTripBps) reasons.push(`roundtrip-${roundTripBps.toFixed(0)}bps`);
      result = {
        pass: reasons.length === 0,
        status: reasons.length === 0 ? 'PASS' : 'BLOCKED',
        executableUsd: Math.round(usd), buyUsd: Math.round(buyUsd), sellUsd: Math.round(sellUsd),
        spreadBps: Number(spreadBps.toFixed(1)), roundTripBps: Number(roundTripBps.toFixed(1)),
        reasons,
      };
    }
  } catch (e) {
    result = { pass: false, status: 'UNVERIFIABLE', reasons: [`depth-unavailable(${e.message})`] };
  }
  cache.set(key, { at: Date.now(), result });
  if (config.debug && !result.pass) console.log(`  [gate] ${exchange}:${symbol} ${result.status}: ${result.reasons.join(', ')}`);
  return result;
}
