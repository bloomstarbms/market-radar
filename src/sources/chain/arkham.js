// Arkham Intel API label enrichment (optional — needs ARKHAM_API_KEY in .env).
// Looks up who owns a wallet: exchanges, funds, market makers, named individuals.
// Results are cached 24h. Degrades silently without a key or on errors.
import { config } from '../../config.js';

const cache = new Map(); // address -> { label, ts }
const TTL = 24 * 3600e3;
let disabled = false;

export async function arkhamLabel(address) {
  if (!config.arkhamKey || disabled || !address) return null;
  const hit = cache.get(address);
  if (hit && Date.now() - hit.ts < TTL) return hit.label;
  try {
    const res = await fetch(`https://api.arkm.com/intelligence/address/${address}`, {
      headers: { 'API-Key': config.arkhamKey },
    });
    if (res.status === 401 || res.status === 403) {
      disabled = true;
      console.error('[arkham] API key rejected — label enrichment disabled this run');
      return null;
    }
    if (!res.ok) return null;
    const j = await res.json();
    // Response can be flat or keyed by chain — check both shapes defensively.
    const pick = (o) => o?.arkhamEntity || o?.arkhamLabel ? o : null;
    const node = pick(j) || Object.values(j || {}).map(pick).find(Boolean);
    const ent = node?.arkhamEntity, lab = node?.arkhamLabel;
    const name = ent?.name || lab?.name || null;
    const label = name ? {
      name,
      isCex: ent?.type === 'cex' || /exchange|binance|coinbase|okx|bybit|kraken|kucoin|gate|mexc|htx|crypto\.com/i.test(name),
    } : null;
    cache.set(address, { label, ts: Date.now() });
    if (cache.size > 5000) cache.clear();
    return label;
  } catch { return null; }
}
