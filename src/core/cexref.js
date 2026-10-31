// CEX REFERENCE FOR DEX FIGURES
// The CEX tickers the bot already polls every minute, kept for one hour for the symbols the DEX
// watchlist resolves to, so a DEX 1h change can be checked against the market before CONFLUENCE uses
// it. 29 Oct 20:36 UTC: DexScreener's Ethereum 1h change flipped from about -3% to +6..+23% across the
// watchlist in one poll while Binance kept falling, and the DEX price stamped on five calls was 9-22%
// above Binance spot. Each of those calls would have been caught by one of the two checks below.
import { config } from '../config.js';

const KEEP_MS = 75 * 60e3;          // one hour, plus slack for the 60 min look-back
const FRESH_MS = 5 * 60e3;          // a venue's last quote older than this is not a reference
const LOOKBACK_TOL_MS = 10 * 60e3;  // the "1h ago" sample may sit this far from exactly 60 min
const VENUE_AGREE = 0.25;           // a venue >25% from the venues' median is another asset on the same ticker
export const DEX_PREMIUM_MAX = 5;   // DEX price more than this % above the CEX reference: DEX 1h not used
const SAME_ASSET_X = 2;             // a DEX price more than 2x from the reference is another token on that ticker

const series = new Map();  // `${exchange}:${BASE}` -> [{ ts, price }]
const watchedByChain = new Map(); // chainId -> Set(BASE)
let watched = new Set();

// Called by the DEX poll: only these symbols are recorded (the CEX poll scans thousands).
export function watchSymbols(chainId, symbols) {
  watchedByChain.set(chainId, new Set([...symbols].map((s) => String(s).toUpperCase())));
  watched = new Set([...watchedByChain.values()].flatMap((s) => [...s]));
}

// Called by the CEX poll for every USDT ticker.
export function noteCexPrice(exchange, pairSymbol, price, now = Date.now()) {
  if (!(price > 0) || !String(pairSymbol).endsWith('USDT')) return;
  const base = pairSymbol.slice(0, -4).toUpperCase();
  if (!watched.has(base)) return;
  const k = `${exchange}:${base}`;
  const s = series.get(k) ?? [];
  s.push({ ts: now, price });
  while (s.length && now - s[0].ts > KEEP_MS) s.shift();
  series.set(k, s);
}

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// Pure over `venues` = [{ exchange, price, h1 }]: the consensus quote. Venues far from the median are
// another asset sharing the ticker (MEXC's BEAMUSDT was 2.2x Bybit's and Bitget's at 20:38 on 29 Oct);
// if fewer than half the venues agree, there is no reference.
export function consensus(venues) {
  if (!venues.length) return null;
  const mid = median(venues.map((v) => v.price));
  const agree = venues.filter((v) => Math.abs(v.price / mid - 1) <= VENUE_AGREE);
  if (!agree.length || agree.length * 2 < venues.length) return null;
  const h1s = agree.map((v) => v.h1).filter((x) => x != null);
  return { price: median(agree.map((v) => v.price)), h1: h1s.length ? median(h1s) : null, venues: agree.map((v) => v.exchange), dropped: venues.filter((v) => !agree.includes(v)).map((v) => v.exchange) };
}

export function cexRef(symbol, now = Date.now(), order = config.cexExchanges) {
  const base = String(symbol || '').toUpperCase();
  const venues = [];
  for (const ex of order) {
    const s = series.get(`${ex}:${base}`);
    const last = s?.at(-1);
    if (!last || now - last.ts > FRESH_MS) continue;
    let past = null;
    for (const p of s) if (Math.abs(p.ts - (last.ts - 3600e3)) <= LOOKBACK_TOL_MS && (!past || Math.abs(p.ts - (last.ts - 3600e3)) < Math.abs(past.ts - (last.ts - 3600e3)))) past = p;
    venues.push({ exchange: ex, price: last.price, h1: past ? (last.price / past.price - 1) * 100 : null });
  }
  return consensus(venues);
}

// Pure: may CONFLUENCE use this DEX 1h change? `cex` is consensus()/cexRef() output or null.
export function dexH1Check({ dexH1, dexPrice, cex, chainDistrusted = false }) {
  const pct = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  if (chainDistrusted) return { use: false, why: 'chain-flip', reason: 'the chain\'s DEX 1h figures flipped sign on most of the watchlist in one poll' };
  if (!cex || !(dexPrice > 0)) return { use: true, why: 'no-cex', reason: 'no CEX reference for this symbol' };
  const ratio = dexPrice / cex.price;
  if (ratio > SAME_ASSET_X || ratio < 1 / SAME_ASSET_X) return { use: true, why: 'other-asset', reason: `CEX ${cex.venues.join('/')} quote is ${ratio.toFixed(2)}x the DEX price: another asset on the same ticker, not a reference` };
  const premium = (ratio - 1) * 100;
  if (premium > DEX_PREMIUM_MAX + 1e-9) return { use: false, why: 'premium', premium, reason: `DEX price ${pct(premium)} vs CEX (${cex.venues.join('/')}), above the ${DEX_PREMIUM_MAX}% limit` };
  if (cex.h1 != null && dexH1 && cex.h1 && Math.sign(dexH1) !== Math.sign(cex.h1)) return { use: false, why: 'direction', premium, reason: `DEX 1h ${pct(dexH1)} but CEX 1h ${pct(cex.h1)} (${cex.venues.join('/')}): opposite directions` };
  return { use: true, why: 'agrees', premium };
}

// Pure: the share of a chain's watchlist whose DEX 1h sign changed since the previous poll.
// prev/cur: { address: h1 }. Tokens at exactly 0 on either side are not compared.
export const FLIP_SHARE = 0.6, FLIP_MIN = 5;
export function chainFlip(prev, cur) {
  let compared = 0, flipped = 0;
  for (const [a, h] of Object.entries(cur || {})) {
    const p = prev?.[a];
    if (!p || !h) continue;
    compared++;
    if (Math.sign(p) !== Math.sign(h)) flipped++;
  }
  return { compared, flipped, distrust: compared >= FLIP_MIN && flipped / compared > FLIP_SHARE };
}
