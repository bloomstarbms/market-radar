// DexScreener client. Free API, no key. https://docs.dexscreener.com
const BASE = 'https://api.dexscreener.com';

// Batch-fetch pairs for token addresses on one chain (max 30 addresses).
export async function getPairsForTokens(chainId, addresses) {
  const res = await fetch(`${BASE}/tokens/v1/${chainId}/${addresses.join(',')}`);
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  return res.json(); // array of pairs
}

// For each token, keep only its most liquid pair.
export function bestPairPerToken(pairs) {
  const best = {};
  for (const p of pairs || []) {
    const addr = p.baseToken?.address;
    if (!addr) continue;
    const liq = p.liquidity?.usd || 0;
    if (!best[addr] || liq > (best[addr].liquidity?.usd || 0)) best[addr] = p;
  }
  return best;
}
