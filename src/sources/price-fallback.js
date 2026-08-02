// CryptoRank price fallback — a backstop for majors when the primary feed is down.
//
// Why this exists: outcomes.js stamps BTC's price on every alert so returns can be
// scored as alpha. That stamp came from Binance alone. If Binance was unreachable
// (outage, geo-block) the stamp was 0, and because it's written once at record time,
// every alert logged during that window lost its alpha score permanently.
//
// Scope is deliberately narrow. The Sandbox plan gives 400 credits/day and the list
// endpoint returns only the top 100 by rank, so this can serve BTC/ETH/majors but
// NOT the dead micro-caps on the DEX watchlist — those stay on DexScreener.
import { config } from '../config.js';

const URL = 'https://api.cryptorank.io/v3/currencies/list';
const CACHE_MS = 10 * 60e3; // 1 call per 10 min worst case = 144/day, inside the 400 budget
let cache = { at: 0, prices: new Map() };
let quietUntil = 0;

async function refresh() {
  if (Date.now() - cache.at < CACHE_MS) return cache.prices;
  if (Date.now() < quietUntil) return cache.prices;
  const res = await fetch(URL, { headers: { 'X-Api-Key': config.cryptorankKey } });
  if (!res.ok) {
    // 429 = rate limit, 401/403 = key or plan problem. Back off rather than hammering
    // a budget we can't see, and keep serving whatever we last cached.
    quietUntil = Date.now() + (res.status === 429 ? 60e3 : 30 * 60e3);
    throw new Error(`cryptorank ${res.status}`);
  }
  const j = await res.json();
  const prices = new Map();
  for (const c of j.data || []) {
    const p = Number(c.price);
    if (c.symbol && p > 0) prices.set(c.symbol.toUpperCase(), p);
  }
  if (prices.size) cache = { at: Date.now(), prices };
  return cache.prices;
}

// Returns 0 when unavailable — callers treat that exactly like a failed primary fetch.
export async function fallbackPrice(symbol) {
  if (!config.cryptorankKey) return 0;
  try {
    const prices = await refresh();
    return prices.get(symbol.toUpperCase()) || 0;
  } catch (e) {
    if (config.debug) console.log(`  [debug] price fallback failed: ${e.message}`);
    return 0;
  }
}
