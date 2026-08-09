// Instrument taxonomy — spec §1.1.
//
// Classify before any detector touches a symbol. The original system alerted on RLUSD
// for "price flat" and SOXLB for "unusual volume"; both are taxonomy failures, not
// detector failures. A stablecoin trading flat is the definition of working correctly.
//
// This is NOT redundant with the executability gate. Measured: RLUSD passes the gate
// comfortably ($9.7M executable, tight book) because it is a real, liquid instrument —
// it is simply one whose price is pinned by design. Liquidity and tradability are
// different questions, so both layers are required.
import { isStockName, isStockSymbol } from '../sources/cex/exchanges.js';

export const AssetClass = {
  MAJOR: 'MAJOR', LARGE_ALT: 'LARGE_ALT', MID_ALT: 'MID_ALT', MICROCAP: 'MICROCAP',
  STABLECOIN: 'STABLECOIN', TOKENIZED_EQUITY: 'TOKENIZED_EQUITY', WRAPPED: 'WRAPPED',
  LST_LRT: 'LST_LRT', MEME: 'MEME',
};

const MAJORS = new Set(['BTC', 'ETH', 'SOL']);

// Explicit list, plus a structural fallback below for ones we haven't named.
const STABLES = new Set([
  'USDT', 'USDC', 'RLUSD', 'FDUSD', 'DAI', 'USDE', 'TUSD', 'USDD', 'PYUSD', 'USDP',
  'GUSD', 'LUSD', 'FRAX', 'SUSD', 'USDS', 'BUSD', 'EURC', 'EURT', 'USDY', 'USD1',
  'CRVUSD', 'GHO', 'USDB', 'USDF', 'USDG', 'XAUT', 'PAXG',
]);

// Wrapped/bridged representations dedupe to their underlying — never alert on both
// WBTC and BTC for the same flow.
const WRAPPED_MAP = {
  WBTC: 'BTC', CBBTC: 'BTC', TBTC: 'BTC', BTCB: 'BTC', RENBTC: 'BTC',
  WETH: 'ETH', CBETH: 'ETH', WEETH: 'ETH', BETH: 'ETH',
  WSOL: 'SOL', MSOL: 'SOL', JITOSOL: 'SOL', BSOL: 'SOL',
};
const LST_LRT = new Set(['STETH', 'WSTETH', 'RETH', 'EZETH', 'RSETH', 'PUFETH', 'SWETH', 'ANKRETH', 'LSETH', 'OSETH']);

const MEMES = new Set([
  'DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'BOME', 'MOG', 'BRETT', 'POPCAT',
  'MEW', 'TURBO', 'NEIRO', 'PNUT', 'ACT', 'GOAT', 'FARTCOIN', 'ELON', 'BABYDOGE',
]);

const base = (symbol) => String(symbol || '').toUpperCase()
  .replace(/[-_]/g, '').replace(/(USDT|USDC|USD|BUSD|KRW|BTC|ETH)$/, '');

// A stablecoin we haven't named still behaves like one: price pinned near 1.0 and
// 24h change under a fraction of a percent. Structural, so the list can lag reality.
function looksPegged(ctx) {
  const p = Number(ctx?.price);
  const chg = Math.abs(Number(ctx?.change24hPct ?? 0));
  return Number.isFinite(p) && p > 0.90 && p < 1.10 && chg < 0.5;
}

// ctx (optional): { price, change24hPct, quoteVol24h, name }
export function classify(symbol, ctx = {}) {
  const b = base(symbol);
  if (!b) return AssetClass.MICROCAP;

  if (isStockSymbol(String(symbol).toUpperCase()) || isStockName(ctx.name)) return AssetClass.TOKENIZED_EQUITY;
  if (STABLES.has(b)) return AssetClass.STABLECOIN;
  if (MAJORS.has(b)) return AssetClass.MAJOR;
  if (WRAPPED_MAP[b]) return AssetClass.WRAPPED;
  if (LST_LRT.has(b)) return AssetClass.LST_LRT;
  if (looksPegged(ctx)) return AssetClass.STABLECOIN;
  if (MEMES.has(b)) return AssetClass.MEME;

  // Size buckets from real 24h quote volume — a proxy, and a weak one on wash-heavy
  // venues, which is exactly why the executability gate exists downstream.
  const vol = Number(ctx.quoteVol24h ?? 0);
  if (vol >= 100_000_000) return AssetClass.LARGE_ALT;
  if (vol >= 5_000_000) return AssetClass.MID_ALT;
  return AssetClass.MICROCAP;
}

export const underlyingOf = (symbol) => WRAPPED_MAP[base(symbol)] || base(symbol);

// Classes excluded from every price-move / volume detector.
const PRICE_DETECTOR_EXCLUDED = new Set([AssetClass.STABLECOIN, AssetClass.TOKENIZED_EQUITY]);

// Returns { allowed, cls, reason }. Stablecoins keep exactly one valid alert path —
// a depeg — and nothing else.
export function allowPriceDetector(symbol, ctx = {}, alertType = '') {
  const cls = classify(symbol, ctx);
  if (cls === AssetClass.STABLECOIN && alertType === 'DEPEG') return { allowed: true, cls };
  if (PRICE_DETECTOR_EXCLUDED.has(cls)) {
    return { allowed: false, cls, reason: `taxonomy-${cls.toLowerCase()}` };
  }
  return { allowed: true, cls };
}
