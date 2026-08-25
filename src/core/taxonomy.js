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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { isStockName, isStockSymbol } from '../sources/cex/exchanges.js';

export const AssetClass = {
  MAJOR: 'MAJOR', LARGE_ALT: 'LARGE_ALT', MID_ALT: 'MID_ALT', MICROCAP: 'MICROCAP',
  STABLECOIN: 'STABLECOIN', TOKENIZED_EQUITY: 'TOKENIZED_EQUITY', WRAPPED: 'WRAPPED',
  LST_LRT: 'LST_LRT', MEME: 'MEME',
  // A 3x product's price series is a DECAYING DERIVATIVE of the underlying: it moves
  // violently for structural reasons (daily rebalance, volatility drag) that have
  // nothing to do with the asset. Excluded from listing facts AND from every price
  // detector — BTC3L is not a BTC listing, and its -12% day is not a DUMP signal.
  LEVERAGED_TOKEN: 'LEVERAGED_TOKEN',
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

// ---- text-level equity detection, for ANNOUNCEMENTS where no symbol/book exists yet.
// The taxonomy is the ONE owner of tokenized-equity knowledge. The 14 Aug miss
// happened partly because a second regex lived in announcements.js and drifted out of
// sync (it knew 'xstock' and 'tokenized stock'; Bybit had renamed the line 'TradFi').
// When a venue invents the next product-line label, add it HERE and nowhere else.
const EQUITY_TEXT_RX = /tradfi|tokenized stock|tokenised stock|xstock|equit(y|ies)|\bstocks?\b|\betfs?\b/i;
const LEVERAGE_BOILERPLATE = /,?\s*with up to \d+x leverage/ig; // on every perp title; would trip name rules
// THREE-STATE announcement classification — 'EQUITY' | 'UNRECOGNISED' | 'CRYPTO'.
// Consistent with every other classifier here: degrade to CAUTION, not to a
// permissive default. Binary was why 'TradFi' became six pushes rather than one
// operator line. UNRECOGNISED does not push; it routes to digest and tells the
// operator, which is the same shape as unlocks' `estimated` (logged, never alerted).
export function classifyAnnouncementText(title, opts = {}) {
  if (isEquityText(title)) return { cls: 'EQUITY', novel: [] };
  const novel = (opts.novelTokens ?? defaultNovelTokens)(title, opts);
  if (novel.length) return { cls: 'UNRECOGNISED', novel };
  return { cls: 'CRYPTO', novel: [] };
}
// Indirection keeps taxonomy.js free of file I/O and makes the vocabulary injectable.
let defaultNovelTokens = () => [];
export function setNovelTokenFn(fn) { defaultNovelTokens = fn; }

// ---------------------------------------------------------------- symbol-level
// SYMBOL classification, for the TICKER path (symbol-set diffing). A brand-new
// listing has no ticker data at detection time, so market-data taxonomy is
// impossible and title-based isEquityText() has no title to read — classification
// must run against the SYMBOL STRING. Lives HERE, beside isEquityText, because a
// parallel implementation elsewhere is exactly how 'TradFi' drifted out of sync.
//
// *** THE DEFAULT DIRECTION IS DELIBERATELY OPPOSITE TO THE ANNOUNCEMENT PATH. ***
// For announcement TITLES, UNRECOGNISED diverts and does NOT push: most titles are
// noise, so a conservative default is cheap. For SYMBOLS, most new symbols are
// genuine crypto listings, so blocking on ambiguity would suppress the very thing we
// want. Therefore EXCLUDE requires a POSITIVE wrapper match, and UNRECOGNISED PUSHES
// while being logged for review. Same three states, opposite default, because the
// BASE RATES DIFFER. Do not "fix" this inconsistency — making symbols conservative
// would start swallowing real listings.
const LEVERAGED_RX = /(\d)(L|S)$/;            // 3L 3S 5L 5S 2L 2S
const XSTOCK_RX = /^([A-Z0-9]{2,12})X$/;      // TSLAX, CRCLX — needs corroboration
// Genuine crypto assets whose symbols decompose into <equity ticker> + X. Guard list,
// checked BEFORE the X rule. GMX was found on live data (stem GM = General Motors).
const CRYPTO_EXCEPTIONS = new Set([
  'GMX', 'MAX', 'IMX', 'AVAX', 'DYDX', 'BNX', 'PAX', 'XMX', 'RLX', 'CVX', 'FLUX',
  'HELIX', 'MATIC', 'PENDLE', 'RUNE', 'VELODROME', 'ONYX', 'PHX', 'LUX', 'MTX',
]);

let equityTickers = null;
function loadEquityTickers() {
  if (equityTickers) return equityTickers;
  try {
    const p = join(config.dataDir, 'equity-tickers.json');
    equityTickers = new Set((JSON.parse(readFileSync(p, 'utf8')).tickers || []).map((t) => t.toUpperCase()));
  } catch { equityTickers = new Set(); }
  return equityTickers;
}

// Returns { state: 'EXCLUDE'|'UNRECOGNISED'|'OK', cls?, reason? }
export function classifySymbol(base, quote = 'USDT', venue = '', deps = {}) {
  const b = String(base || '').toUpperCase().replace(/[-_]/g, '');
  if (!b) return { state: 'OK' };
  const tickers = deps.tickers ?? loadEquityTickers();

  // LEVERAGED: the suffix is SUFFICIENT ON ITS OWN. A 3x product is excluded whatever
  // the underlying — BTC3L is not a BTC listing — so no corroboration is needed and
  // none should be required.
  const lev = b.match(LEVERAGED_RX);
  if (lev) {
    const stem = b.slice(0, -2);
    return { state: 'EXCLUDE', cls: AssetClass.LEVERAGED_TOKEN,
      reason: `leveraged token (${lev[1]}x ${lev[2] === 'L' ? 'long' : 'short'} ${stem || '?'})`,
      underlying: stem, side: lev[2] === 'L' ? 'long' : 'short' };
  }

  // xSTOCK: a bare trailing X is COMMON in crypto naming, so this rule requires BOTH
  // the convention AND corroboration from the equity ticker list. A ticker match
  // alone must NEVER block — crypto/equity ticker collisions are frequent and a bare
  // list hit would suppress genuine crypto listings.
  //
  // KNOWN-CRYPTO GUARD, added after the rule caught GMX on live data: GMX decomposes
  // to stem 'GM' + X, and GM (General Motors) is in the equity list — so a major
  // crypto protocol would have been silently suppressed. Stem LENGTH cannot separate
  // these (MCDX, WMTX, SPYX, PGX are genuine xStocks with 2-3 char stems), so the
  // discriminator has to be the whole symbol. This is the inverse of the "ticker match
  // alone never blocks" rule and enforces it: a symbol that IS a known crypto asset is
  // never excluded, whatever it happens to decompose into.
  // EXTEND THIS LIST whenever a genuine crypto is caught by the X rule.
  if (CRYPTO_EXCEPTIONS.has(b)) return { state: 'OK', reason: 'known crypto asset — X-rule guard' };
  const xm = b.match(XSTOCK_RX);
  if (xm) {
    const stem = xm[1];
    if (tickers.has(stem)) {
      return { state: 'EXCLUDE', cls: AssetClass.TOKENIZED_EQUITY,
        reason: `xStock convention + '${stem}' is a known equity ticker`, underlying: stem };
    }
    return { state: 'UNRECOGNISED', reason: `trailing-X convention but '${stem}' is not a known equity ticker — pushed, logged for review` };
  }

  // No wrapper convention: a plain symbol is a plain listing, whatever the string
  // resembles. This is where the inverted default does its work.
  return { state: 'OK' };
}

export function isEquityText(title) {
  const stripped = String(title || '').replace(LEVERAGE_BOILERPLATE, '');
  if (EQUITY_TEXT_RX.test(stripped)) return true;
  if (isStockName(stripped)) return true;
  // Bare tickers ("JNJUSDT") with no company name: match against the tokenized-stock
  // symbol sets the ticker fetchers maintain. Structurally can NOT catch symbols
  // announced minutes ago — that is what the label regex and batch collapse are for.
  for (const [, sym] of stripped.toUpperCase().matchAll(/\b([A-Z0-9]{2,15}USDT)\b/g)) {
    if (isStockSymbol(sym)) return true;
  }
  return false;
}

// Classes excluded from every price-move / volume detector.
const PRICE_DETECTOR_EXCLUDED = new Set([AssetClass.STABLECOIN, AssetClass.TOKENIZED_EQUITY,
  AssetClass.LEVERAGED_TOKEN]);

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
