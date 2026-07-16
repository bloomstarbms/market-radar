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
  minUsd: Number(process.env.WHALE_MIN_USD || 50_000), // liquidity-relative threshold never drops below this
  maxTxPerPoll: 25,
  intervalSec: Number(process.env.WHALE_INTERVAL || 300), // per-token on-chain check spacing (protects free API quotas)
};

// Best-effort exchange wallet labels (community-known hot wallets).
// EVM keys MUST be lowercase; Solana keys are case-sensitive (kept exact).
// Extend freely — this is the poor man's Arkham. Unlabeled CEX wallets exist,
// so "wallet -> wallet" can still secretly be an exchange move.
const EXCHANGE_WALLETS = {
  // --- EVM (Ethereum & BSC share many) ---
  '0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be': 'Binance',
  '0xd551234ae421e3bcba99a0da6d736074f22192ff': 'Binance',
  '0x564286362092d8e7936f0549571a803b203aaced': 'Binance',
  '0x0681d8db095565fe8a346fa0277bffde9c0edbbf': 'Binance',
  '0xfe9e8709d3215310075d67e3ed32a380ccf451c8': 'Binance',
  '0xbe0eb53f46cd790cd13851d5eff43d12404d33e8': 'Binance',
  '0xf977814e90da44bfa03b6295a0616a897441acec': 'Binance',
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': 'Binance',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': 'Binance',
  '0x56eddb7aa87536c09ccc2793473599fd21a8b17f': 'Binance',
  '0x9696f59e4d72e237be84ffd425dcad154bf96976': 'Binance',
  '0x4976a4a02f38326660d17bf34b431dc6e2eb2327': 'Binance',
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': 'Coinbase',
  '0x503828976d22510aad0201ac7ec88293211d23da': 'Coinbase',
  '0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740': 'Coinbase',
  '0x3cd751e6b0078be393132286c442345e5dc49699': 'Coinbase',
  '0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511': 'Coinbase',
  '0xeb2629a2734e272bcc07bda959863f316f4bd4cf': 'Coinbase',
  '0x2910543af39aba0cd09dbb2d50200b3e800a63d2': 'Kraken',
  '0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13': 'Kraken',
  '0xe853c56864a2ebe4576a807d26fdc4a0ada51919': 'Kraken',
  '0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0': 'Kraken',
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b': 'OKX',
  '0x236f9f97e0e62388479bf9e5ba4889e46b0273c3': 'OKX',
  '0x98ec059dc3adfbdd63429454aeb0c990fba4a128': 'OKX',
  '0x5041ed759dd4afc3a72b8192c143f72f4724081a': 'OKX',
  '0xf89d7b9c864f589bbf53a82105107622b35eaa40': 'Bybit',
  '0xee5b5b923ffce93a870b3104b7ca09c3db80047a': 'Bybit',
  '0x2b5634c42055806a59e9107ed44d43c426e58258': 'KuCoin',
  '0x689c56aef474df92d44a1b70850f808488f9769c': 'KuCoin',
  '0xa1d8d972560c2f8144af871db508f0b0b10a3fbf': 'KuCoin',
  '0x4ad64983349c49defe8d7a4686202d24b25d0ce8': 'KuCoin',
  '0xd6216fc19db775df9774a6e33526131da7d19a2c': 'KuCoin',
  '0x0d0707963952f2fba59dd06f2b425ace40b492fe': 'Gate.io',
  '0x7793cd85c11a924478d358d49b05b37e91b5810f': 'Gate.io',
  '0x1c4b70a3968436b9a0a9cf5205c787eb81bb558c': 'Gate.io',
  '0x75e89d5979e4f6fba9f97c104c2f0afb3f1dcb88': 'MEXC',
  '0xab5c66752a9e8167967685f1450532fb96d5d24f': 'HTX',
  '0xe93381fb4c4f14bda253907b18fad305d799241a': 'HTX',
  '0xfdb16996831753d5331ff813c29a93c76834a0ad': 'HTX',
  '0x6262998ced04146fa42253a5c0af90ca02dfd2a3': 'Crypto.com',
  '0x46340b20830761efd32832a74d7169b29feb9758': 'Crypto.com',
  // --- Solana (case-sensitive) ---
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'Binance',
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'Binance',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'Binance',
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS': 'Coinbase',
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm': 'Coinbase',
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2': 'Bybit',
  '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD': 'OKX',
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5': 'Kraken',
  'BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6': 'KuCoin',
  'u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w': 'Gate.io',
  'ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ': 'MEXC',
};

function lookupWallet(addr) {
  if (!addr) return null;
  return EXCHANGE_WALLETS[addr] || EXCHANGE_WALLETS[addr.toLowerCase()] || null;
}

const CHAIN_IDS = { ethereum: 1, bsc: 56, base: 8453, arbitrum: 42161, polygon: 137, optimism: 10, avalanche: 43114 };
const lastSeen = new Map(); // tokenKey -> newest tx id already processed
const lastCheck = new Map(); // tokenKey -> ts of last on-chain check
const disabledChains = new Set(); // chains rejected by the API plan (logged once)

export function classifyDirection(from, to) {
  const f = lookupWallet(from);
  const t = lookupWallet(to);
  if (t && f) return { dir: `${f} \u2192 ${t} (exchange-to-exchange)`, hint: 'internal shuffle or arbitrage', sev: 'LOW' };
  if (t) return { dir: `wallet \u2192 ${t} (DEPOSIT)`, hint: 'coins moving onto exchange \u2014 possible incoming SELL-OFF', sev: 'HIGH' };
  if (f) return { dir: `${f} \u2192 wallet (WITHDRAWAL)`, hint: 'coins leaving exchange \u2014 likely accumulation / cold storage', sev: 'MEDIUM' };
  return { dir: 'wallet \u2192 wallet', hint: 'unknown parties \u2014 watch for follow-up', sev: 'LOW' };
}

export function effectiveThreshold(liqUsd) {
  if (!liqUsd || liqUsd <= 0) return RULES.whaleUsd;
  return Math.max(RULES.minUsd, Math.min(RULES.whaleUsd, liqUsd * (RULES.liqPct / 100)));
}

let lastEvmCall = 0;
async function evmTransfers(chainId, tokenAddress) {
  // Etherscan free tier: 3 calls/sec — space calls out
  const wait = lastEvmCall + 400 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastEvmCall = Date.now();
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
  if (disabledChains.has(chainId)) return;
  if (isSolana && !config.heliusKey) return;
  if (!isSolana && (!config.etherscanKey || !CHAIN_IDS[chainId])) return;

  const key = `${chainId}:${token}`;
  if (Date.now() - (lastCheck.get(key) || 0) < RULES.intervalSec * 1000) return;
  lastCheck.set(key, Date.now());
  if (config.debug) console.log(`  [debug] whale check: ${pair.baseToken.symbol} (${chainId})`);
  let txs;
  try {
    txs = isSolana ? await solanaTransfers(token) : await evmTransfers(chainId, token);
  } catch (e) {
    if (/not supported|upgrade/i.test(e.message)) {
      disabledChains.add(chainId);
      console.error(`[whale] ${chainId}: not covered by free API plan — whale checks disabled for this chain`);
    } else {
      console.error(`[whale] ${key} fetch failed:`, e.message);
    }
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
        `<a href="${tx.explorer}">view transaction</a>`,
      ],
      url: pair.url,
    });
  }
}

const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2);
export { RULES };
