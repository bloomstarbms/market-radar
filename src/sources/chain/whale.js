// On-chain whale-transfer monitor for watchlist tokens.
// EVM chains via Etherscan V2 multichain API (free key), Solana via Helius (free key).
// Threshold: min(WHALE_USD, WHALE_LIQ_PCT% of pair liquidity) — so dormant
// low-liquidity tokens still trigger. Direction is best-effort via a small
// list of known exchange hot wallets (extend EXCHANGE_WALLETS below).
import { config } from '../../config.js';
import { dispatch } from '../../core/dispatcher.js';

const RULES = {
  whaleUsd: Number(process.env.WHALE_USD || 1_000_000),
  liqPct: Number(process.env.WHALE_LIQ_PCT || 20),
  maxTxPerPoll: 25,
  intervalSec: Number(process.env.WHALE_INTERVAL || 300), // per-token on-chain check spacing (protects free API quotas)
};

// Best-effort labels (lowercase). Extend freely — this is the poor man's Arkham.
const EXCHANGE_WALLETS = {
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': 'Binance',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': 'Binance',
  '0x9696f59e4d72e237be84ffd425dcad154bf96976': 'Binance',
  '0xf89d7b9c864f589bbf53a82105107622b35eaa40': 'Bybit',
  '0x0d0707963952f2fba59dd06f2b425ace40b492fe': 'Gate.io',
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b': 'OKX',
  '0xd6216fc19db775df9774a6e33526131da7d19a2c': 'KuCoin',
};

const CHAIN_IDS = { ethereum: 1, bsc: 56, base: 8453, arbitrum: 42161, polygon: 137, optimism: 10, avalanche: 43114 };
const lastSeen = new Map(); // tokenKey -> newest tx id already processed
const lastCheck = new Map(); // tokenKey -> ts of last on-chain check

export function classifyDirection(from, to) {
  const f = EXCHANGE_WALLETS[from?.toLowerCase()];
  const t = EXCHANGE_WALLETS[to?.toLowerCase()];
  if (t) return { dir: `→ ${t} deposit`, hint: 'possible incoming SELL-OFF', sev: 'HIGH' };
  if (f) return { dir: `← ${f} withdrawal`, hint: 'possible accumulation', sev: 'MEDIUM' };
  return { dir: 'wallet → wallet', hint: 'watch for follow-up', sev: 'LOW' };
}

export function effectiveThreshold(liqUsd) {
  if (!liqUsd || liqUsd <= 0) return RULES.whaleUsd;
  return Math.min(RULES.whaleUsd, liqUsd * (RULES.liqPct / 100));
}

async function evmTransfers(chainId, tokenAddress) {
  const url = `https://api.etherscan.io/v2/api?chainid=${CHAIN_IDS[chainId]}&module=account&action=tokentx&contractaddress=${tokenAddress}&page=1&offset=${RULES.maxTxPerPoll}&sort=desc&apikey=${config.etherscanKey}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== '1' && json.message !== 'No transactions found') throw new Error(json.result || json.message);
  return (Array.isArray(json.result) ? json.result : []).map((tx) => ({
    id: `${tx.hash}:${tx.from}:${tx.to}`,
    from: tx.from, to: tx.to,
    amount: Number(tx.value) / 10 ** Number(tx.tokenDecimal || 18),
    hash: tx.hash,
    explorer: `https://${chainId === 'bsc' ? 'bscscan.com' : chainId === 'base' ? 'basescan.org' : 'etherscan.io'}/tx/${tx.hash}`,
  }));
}

async function solanaTransfers(mint) {
  const url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${config.heliusKey}&limit=${RULES.maxTxPerPoll}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`helius ${res.status}`);
  const txs = await res.json();
  const out = [];
  for (const tx of txs) {
    for (const tt of tx.tokenTransfers || []) {
      if (tt.mint !== mint) continue;
      out.push({
        id: `${tx.signature}:${tt.fromUserAccount}:${tt.toUserAccount}`,
        from: tt.fromUserAccount, to: tt.toUserAccount,
        amount: Number(tt.tokenAmount),
        hash: tx.signature,
        explorer: `https://solscan.io/tx/${tx.signature}`,
      });
    }
  }
  return out;
}

// Called from the DEX poll loop with the live pair (price + liquidity known).
export async function checkWhales(pair) {
  const chainId = pair.chainId;
  const token = pair.baseToken.address;
  const isSolana = chainId === 'solana';
  if (isSolana && !config.heliusKey) return;
  if (!isSolana && (!config.etherscanKey || !CHAIN_IDS[chainId])) return;

  const key = `${chainId}:${token}`;
  if (Date.now() - (lastCheck.get(key) || 0) < RULES.intervalSec * 1000) return;
  lastCheck.set(key, Date.now());
  let txs;
  try {
    txs = isSolana ? await solanaTransfers(token) : await evmTransfers(chainId, token);
  } catch (e) {
    console.error(`[whale] ${key} fetch failed:`, e.message);
    return;
  }
  if (!txs.length) return;

  const seen = lastSeen.get(key);
  lastSeen.set(key, txs[0].id);
  if (seen === undefined) return; // first poll: baseline only, don't replay history

  const price = Number(pair.priceUsd) || 0;
  const liq = pair.liquidity?.usd || 0;
  const threshold = effectiveThreshold(liq);
  if (!price) return;

  for (const tx of txs) {
    if (tx.id === seen) break; // everything older already processed
    const usd = tx.amount * price;
    if (usd < threshold) continue;
    const { dir, hint, sev } = classifyDirection(tx.from, tx.to);
    await dispatch({
      source: 'CHAIN', type: 'WHALE', severity: sev, key: `${key}:${tx.hash}`,
      title: `${pair.baseToken.symbol}: $${fmt(usd)} moved (${chainId})`,
      lines: [
        `${fmt(tx.amount)} ${pair.baseToken.symbol} ${dir} — ${hint}`,
        `Threshold: $${fmt(threshold)} (min of $${fmt(RULES.whaleUsd)} / ${RULES.liqPct}% of $${fmt(liq)} liquidity)`,
        `Tx: ${tx.explorer}`,
      ],
      url: pair.url,
    });
  }
}

const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2);
export { RULES };
