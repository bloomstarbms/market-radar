// DexScreener client. Free API, no key. https://docs.dexscreener.com
const BASE = 'https://api.dexscreener.com';

// Only trust pairs quoted in majors — scam pools pair a real token against a
// worthless quote token with a fabricated USD value, producing absurd prices
// and fake liquidity (e.g. ORCA/MET claiming ORCA = $6,201).
export const TRUSTED_QUOTES = new Set([
  'USDC','USDT','DAI','FDUSD','TUSD','BUSD',
  'SOL','WSOL','ETH','WETH','BNB','WBNB','MATIC','WMATIC','AVAX','WAVAX','ARB','OP',
]);

// Batch-fetch pairs for token addresses on one chain (API limit: 30 per call).
export async function getPairsForTokens(chainId, addresses) {
  const all = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const res = await fetch(`${BASE}/tokens/v1/${chainId}/${batch.join(',')}`);
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    all.push(...await res.json());
  }
  return all;
}

// For each token, keep only its most liquid TRUSTED pair.
export function bestPairPerToken(pairs) {
  const best = {};
  for (const p of pairs || []) {
    const addr = p.baseToken?.address;
    if (!addr) continue;
    if (!TRUSTED_QUOTES.has((p.quoteToken?.symbol || '').toUpperCase())) continue;
    const liq = p.liquidity?.usd || 0;
    if (!best[addr] || liq > (best[addr].liquidity?.usd || 0)) best[addr] = p;
  }
  return best;
}
