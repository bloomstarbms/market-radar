// On-chain whale-transfer monitor for watchlist tokens.
// EVM chains via Etherscan V2 (free key: ethereum/arbitrum/polygon) or Blockscout (keyless:
// base); bsc/optimism/avalanche only via Moralis, whose free tier is paused — see SOURCE_BY_CHAIN.
// Solana via Helius (free key).
// Threshold: min(WHALE_USD, WHALE_LIQ_PCT% of pair liquidity) — so dormant
// low-liquidity tokens still trigger. Direction is best-effort via a small
// list of known exchange hot wallets (extend EXCHANGE_WALLETS below).
import { config } from '../../config.js';
import { dispatch } from '../../core/dispatcher.js';
import { arkhamLabel } from './arkham.js';
import { noteWhale } from '../../core/confluence.js';

const RULES = {
  whaleUsd: Number(process.env.WHALE_USD || 1_000_000),
  liqPct: Number(process.env.WHALE_LIQ_PCT || 20),
  minUsd: Number(process.env.WHALE_MIN_USD || 50_000), // liquidity-relative threshold never drops below this
  tokenCooldownMin: Number(process.env.WHALE_TOKEN_COOLDOWN || 90), // max one whale alert per token per this window
  maxTxPerPoll: 25,
  intervalSec: Number(process.env.WHALE_INTERVAL || 300), // per-token on-chain check spacing (protects free API quotas)
  // Solana's Helius Enhanced API costs ~40 credits/call. 43 tokens every 5 min
  // burns the 1M free monthly quota in ~2 days, so Solana gets its own wide
  // spacing: 90 min keeps the whole month inside the free tier (~825K credits).
  solIntervalSec: Number(process.env.WHALE_INTERVAL_SOL || 300),   // cheap RPC trigger spacing (1 credit/call)
  solFullSec: Number(process.env.WHALE_SOL_FULL || 21600),         // safety-net full parse per token (6h)
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
  // --- Bitget ---
  '0x0639556f03714a74a5feeaf5736a4a64ff70d206': 'Bitget',
  '0x51971c86b04516062c1e708cdc048cb04fbe959f': 'Bitget',
  '0x5bdf85216ec1e38d6458c870992a69e38e03f7ef': 'Bitget',
  // --- Cold storage / reserves (movements here are high-signal) ---
  '0x34ea4138580435b5a521e460035edb19df1938c1': 'Binance cold',
  '0x8894e0a0c962cb723c1976a4421c95949be2d4e3': 'Binance cold',
  '0x2f7e209e0f5f645c7612d7610193fe268f118b28': 'Bybit cold',
  '0xd6153f5af5679a75cc85d8974463545181f48772': 'KuCoin cold',
  '0x1692e170361cefd1eb7240ec13d048fd9af6d667': 'KuCoin cold',
  '0xf16e9b0d03470827a95cdfd0cb8a8a3b46969b91': 'KuCoin cold',
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
// WHICH FREE SOURCE SERVES WHICH CHAIN — tested from the VPS on 2026-09-25 with real
// watchlist tokens, not read off a pricing page (the old comment said Etherscan's free
// plan was "ETH-only"; it answers arbitrum and polygon too):
//   etherscan   Etherscan V2 multichain, free key: ethereum, arbitrum, polygon return
//               rows; bsc/optimism/avalanche return "Free API access is not supported
//               for this chain".
//   blockscout  keyless, Etherscan-compatible query and record shape
//               (hash/from/to/value/tokenDecimal): base.blockscout.com.
//   moralis     paused its whole free tier ("Your Moralis Free usage is paused",
//               401 on every call — on the desktop before the migration too). Kept as
//               the ONLY route for bsc/optimism/avalanche so a paid plan revives them
//               with no code change; without one those chains are DARK and the
//               heartbeat says so daily (whaleCoverage) instead of one "disabled this
//               run" line at boot that nobody re-reads.
export const SOURCE_BY_CHAIN = { ethereum: 'etherscan', arbitrum: 'etherscan', polygon: 'etherscan', base: 'blockscout', bsc: 'moralis', optimism: 'moralis', avalanche: 'moralis', solana: 'helius' };
const BLOCKSCOUT_HOSTS = { base: 'base.blockscout.com' };
const MORALIS_CHAINS = { bsc: 'bsc', optimism: 'optimism', avalanche: 'avalanche' };
// Pure: the source a chain resolves to, and whether its credential is present.
export function whaleSource(chainId, cfg = config) {
  const source = SOURCE_BY_CHAIN[chainId] || null;
  if (!source) return { source: null, ready: false, why: 'no source mapped' };
  const need = { etherscan: cfg.etherscanKey, blockscout: true, moralis: cfg.moralisKey, helius: cfg.heliusKey }[source];
  return { source, ready: Boolean(need), why: need ? null : `${source} key missing` };
}
const lastSeen = new Map(); // tokenKey -> newest tx id already processed
const lastCheck = new Map(); // tokenKey -> ts of last on-chain check
const disabledChains = new Set(); // chains rejected by the API plan (logged once)
const darkReason = new Map();     // chain -> the sentence behind disabledChains, for the heartbeat
const pausedUntil = new Map();    // chain -> ts; temporary backoff after rate limits

// Heartbeat line: which chains are watched through which source, which are dark and
// why. A dark chain is a coverage fact, so it is reported daily, not logged once.
export function whaleCoverage(deps = {}) {
  const cfg = deps.cfg ?? config, dark = deps.dark ?? darkReason, paused = deps.paused ?? pausedUntil, now = deps.now ?? Date.now();
  const active = [], off = [];
  for (const chain of Object.keys(SOURCE_BY_CHAIN)) {
    const r = whaleSource(chain, cfg);
    if (dark.has(chain)) off.push(`${chain} DARK (${dark.get(chain)})`);
    else if (!r.ready) off.push(`${chain} off (${r.why})`);
    else active.push(`${chain} ${r.source}${(paused.get(chain) || 0) > now ? ' (backing off)' : ''}`);
  }
  return { active, off, line: `Whale coverage: ${active.join(' · ') || 'none'}${off.length ? ` · ⚠️ ${off.join(' · ')}` : ''}` };
}

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

// Etherscan V2 and Blockscout answer the same query with the same record shape; one
// mapper is the contract for both (fixture 69).
const SCANNER = { ethereum: 'etherscan.io', bsc: 'bscscan.com', base: 'basescan.org', arbitrum: 'arbiscan.io', polygon: 'polygonscan.com', optimism: 'optimistic.etherscan.io', avalanche: 'snowtrace.io' };
export function mapExplorerTx(chainId, tx) {
  return {
    id: `${tx.hash}:${tx.from}:${tx.to}`,
    from: tx.from, to: tx.to,
    amount: Number(tx.value) / 10 ** Number(tx.tokenDecimal || 18),
    hash: tx.hash,
    explorer: `https://${SCANNER[chainId] || 'etherscan.io'}/tx/${tx.hash}`,
  };
}
export function explorerUrl(chainId, tokenAddress, source, cfg = config) {
  const q = `module=account&action=tokentx&contractaddress=${tokenAddress}&page=1&offset=${RULES.maxTxPerPoll}&sort=desc`;
  if (source === 'blockscout') return `https://${BLOCKSCOUT_HOSTS[chainId]}/api?${q}`;
  return `https://api.etherscan.io/v2/api?chainid=${CHAIN_IDS[chainId]}&${q}&apikey=${cfg.etherscanKey}`;
}
// Both APIs answer status "0" for an empty result ("No transactions found" on
// Etherscan, "No token transfers found" on Blockscout): an empty list, not an error.
export function isEmptyExplorerAnswer(json) { return json.status !== '1' && /^No (token )?trans(actions|fers) found$/i.test(json.message || '') && !json.result?.length; }
const lastCall = { etherscan: 0, blockscout: 0 };
const SPACING_MS = { etherscan: 550, blockscout: 1000 }; // Etherscan free: 3 calls/sec; Blockscout is keyless — be polite
// Blockscout keyless: 10 requests per HOUR per IP. x-ratelimit-limit is 10 and
// x-ratelimit-reset is the time LEFT in the window, not its length — the first read
// (2026-09-25, "≈300s") caught a window with five minutes to go and the budget was
// set to 9 per 5 min; overnight the log showed exactly ten checks, a 429, a 53-min
// back-off, ten checks, a 429… The server's own reset says ~1h. So: 9 per 3600s, and
// the response headers are read on every call so a window the server closes early
// pauses the source until the stated reset (no 429 needed to learn it). A sleep long
// enough to respect this would block the DEX poll, so it is a BUDGET: over it, the
// token is skipped this poll WITHOUT being marked checked. 22 base tokens cycle in
// ~2.5h — the Moralis path was 2h; a free Blockscout API key would lift it.
export const BUDGET = { blockscout: { limit: 9, windowMs: 3600e3, times: [] } };
const sourcePausedUntil = { blockscout: 0 };
// Pure: from a response's rate-limit headers, when (if ever) the source must pause.
export function pauseFromHeaders(get, now = Date.now()) {
  const remaining = Number(get('x-ratelimit-remaining')), reset = Number(get('x-ratelimit-reset'));
  if (!Number.isFinite(remaining) || !Number.isFinite(reset) || remaining > 0 || reset <= 0) return null;
  return now + reset;
}
export function budgetAllows(source, now = Date.now(), budget = BUDGET, paused = sourcePausedUntil) {
  if ((paused[source] || 0) > now) return false; // the server closed the window; wait for its reset
  const b = budget[source]; if (!b) return true;
  b.times = b.times.filter((t) => now - t < b.windowMs);
  if (b.times.length >= b.limit) return false;
  b.times.push(now); return true;
}
// Blockscout says "Too many requests" in the body; Etherscan/Helius/Moralis say 429.
export function isRateLimited(msg) { return /429|too many requests/i.test(String(msg)); }
async function explorerTransfers(chainId, tokenAddress, source) {
  const wait = lastCall[source] + SPACING_MS[source] - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall[source] = Date.now();
  const res = await fetch(explorerUrl(chainId, tokenAddress, source));
  if (source === 'blockscout') { const p = pauseFromHeaders((h) => res.headers?.get?.(h)); if (p) sourcePausedUntil.blockscout = p; }
  if (res.status === 429) { // honour the window the server states, not a guessed 5 min
    const e = new Error('429 too many requests'); e.resetMs = Number(res.headers?.get?.('x-ratelimit-reset')) || 0; throw e;
  }
  const json = await res.json();
  if (json.status !== '1' && !isEmptyExplorerAnswer(json)) throw new Error(json.result || json.message);
  return (Array.isArray(json.result) ? json.result : []).map((tx) => mapExplorerTx(chainId, tx));
}

async function moralisTransfers(chainId, tokenAddress) {
  const res = await fetch(`https://deep-index.moralis.io/api/v2.2/erc20/${tokenAddress}/transfers?chain=${MORALIS_CHAINS[chainId]}&limit=${RULES.maxTxPerPoll}&order=DESC`, {
    headers: { 'X-API-Key': config.moralisKey, 'Accept': 'application/json' },
  });
  if (res.status === 401) {
    // Moralis returns 401 (not 429) when the daily CU allowance is spent. The key is
    // fine — it just has to wait for the UTC-midnight reset, so don't disable the chain.
    const body = await res.text().catch(() => '');
    if (/usage has been consumed|upgrade your plan/i.test(body)) throw new Error('moralis quota spent');
    // 2026-09: "Your Moralis Free usage is paused. Upgrade to a paid plan" — not a daily
    // quota, the plan itself. Same handling as a bad key (disabled), clearer reason.
    if (/usage is paused/i.test(body)) throw new Error('moralis key rejected: free tier paused');
    throw new Error('moralis key rejected');
  }
  if (res.status === 429) throw new Error('moralis 429');
  if (!res.ok) throw new Error(`moralis ${res.status}`);
  const j = await res.json();
  const scan = { bsc: 'bscscan.com', base: 'basescan.org', arbitrum: 'arbiscan.io', polygon: 'polygonscan.com' }[chainId] || 'etherscan.io';
  return (j.result || []).map((tx) => ({
    id: `${tx.transaction_hash}:${tx.from_address}:${tx.to_address}`,
    from: tx.from_address, to: tx.to_address,
    amount: Number(tx.value) / 10 ** Number(tx.token_decimals ?? 18),
    hash: tx.transaction_hash,
    explorer: `https://${scan}/tx/${tx.transaction_hash}`,
  }));
}

// Cheap trigger: getSignaturesForAddress costs ~1 credit vs ~40 for the parsed
// Enhanced API. Dormant tokens rarely move, so we pay the cheap call almost
// always and the expensive one only when the signature set actually changes.
const solLastSig = new Map();  // mint -> newest signature seen
const solLastFull = new Map(); // mint -> ts of last full (Enhanced) parse

async function solanaHasActivity(mint) {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${config.heliusKey}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [mint, { limit: 5 }] }),
  });
  if (res.status === 429) throw new Error('helius 429');
  if (!res.ok) throw new Error(`helius rpc ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(/max usage|429/i.test(j.error.message || '') ? 'helius 429' : `helius rpc: ${j.error.message}`);
  const newest = j.result?.[0]?.signature || null;
  const prev = solLastSig.get(mint);
  solLastSig.set(mint, newest);
  if (prev === undefined) return false; // first poll = baseline only
  return newest !== prev;
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
  const { source, ready } = whaleSource(chainId);
  const isSolana = source === 'helius';
  const viaMoralis = source === 'moralis';
  if (disabledChains.has(chainId)) return;
  if (!ready) return; // no source or no credential for it — whaleCoverage() reports which

  if (Date.now() < (pausedUntil.get(chainId) || 0)) return;
  const key = `${chainId}:${token}`;
  // Moralis free tier is CU-metered: space its chains 4x wider (default ~20 min/token)
  // Moralis free plan is 40K compute-units/DAY. 61 tokens at 20-min spacing burned
  // it in hours, so alt-EVM chains get 2h spacing (~730 calls/day, well inside budget).
  const interval = isSolana ? RULES.solIntervalSec
    : viaMoralis ? Number(process.env.WHALE_INTERVAL_EVM_ALT || 7200)
    : RULES.intervalSec;
  if (Date.now() - (lastCheck.get(key) || 0) < interval * 1000) return;
  if (!budgetAllows(source)) return; // this source's window budget is spent — not marked checked, so the next poll retries
  lastCheck.set(key, Date.now());
  if (config.debug) console.log(`  [debug] whale check: ${pair.baseToken.symbol} (${chainId})`);
  let txs;
  try {
    if (isSolana) {
      // Cheap check first; only pay for the parsed feed on real activity or the periodic safety net.
      const dueFull = Date.now() - (solLastFull.get(token) || 0) > RULES.solFullSec * 1000;
      const active = await solanaHasActivity(token);
      if (!active && !dueFull) return;
      solLastFull.set(token, Date.now());
      if (config.debug) console.log(`  [debug] solana full parse: ${pair.baseToken.symbol} (${active ? 'activity' : 'safety-net'})`);
      txs = await solanaTransfers(token);
    } else {
      txs = viaMoralis ? await moralisTransfers(chainId, token) : await explorerTransfers(chainId, token, source);
    }
  } catch (e) {
    if (/not supported|upgrade/i.test(e.message)) {
      disabledChains.add(chainId);
      darkReason.set(chainId, `${source}: not covered by the free plan`);
      console.error(`[whale] ${chainId}: not covered by free API plan — whale checks disabled for this chain`);
    } else if (/quota spent/.test(e.message)) {
      const reset = new Date();
      reset.setUTCHours(24, 5, 0, 0); // next UTC midnight + 5 min of slack
      pausedUntil.set(chainId, reset.getTime());
      console.error(`[whale] ${chainId}: Moralis daily quota spent — resuming ${reset.toISOString().slice(11, 16)} UTC`);
    } else if (/key rejected/.test(e.message)) {
      disabledChains.add(chainId);
      darkReason.set(chainId, e.message);
      console.error(`[whale] ${chainId}: ${e.message} — disabled this run`);
    } else if (isRateLimited(e.message)) {
      const ms = e.resetMs || 5 * 60e3;
      pausedUntil.set(chainId, Date.now() + ms);
      console.error(`[whale] ${chainId}: rate limited — backing off ${Math.max(1, Math.round(ms / 60e3))} min`);
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
    let { dir, hint, sev } = classifyDirection(tx.from, tx.to);
    // Arkham enrichment: replace "wallet"/"unknown" with real entity names
    const [fromArk, toArk] = await Promise.all([arkhamLabel(tx.from), arkhamLabel(tx.to)]);
    if (fromArk || toArk) {
      const fName = fromArk?.name || lookupWallet(tx.from) || 'wallet';
      const tName = toArk?.name || lookupWallet(tx.to) || 'wallet';
      if (toArk?.isCex && !fromArk?.isCex) { dir = `${fName} \u2192 ${tName} (DEPOSIT)`; hint = 'coins moving onto exchange \u2014 possible incoming SELL-OFF'; sev = 'HIGH'; }
      else if (fromArk?.isCex && !toArk?.isCex) { dir = `${fName} \u2192 ${tName} (WITHDRAWAL)`; hint = 'coins leaving exchange \u2014 likely accumulation'; sev = 'MEDIUM'; }
      else { dir = `${fName} \u2192 ${tName}`; hint = 'named entity movement \u2014 higher signal than anonymous wallets'; if (sev === 'LOW') sev = 'MEDIUM'; }
    }
    const isWithdrawal = /WITHDRAWAL/.test(dir);
    if (isWithdrawal) {
      const exch = (dir.split('\u2192')[0] || '').trim() || 'exchange';
      noteWhale(key, { direction: dir, exchange: exch, usd, symbol: pair.baseToken.symbol, isWithdrawal: true });
    }
    await dispatch({
      source: 'CHAIN', type: 'WHALE', severity: sev, key, dedupeKey: `WHALE:${key}`, cooldownMin: RULES.tokenCooldownMin,
      // Reference price at alert time, from the SAME pair snapshot the threshold was
      // computed against. Without this the whole on-chain module is unscoreable and
      // step 10 would ship blind — 954 historical whale alerts produced zero outcome
      // rows for exactly this reason.
      track: { kind: 'dex', chainId, address: pair.baseToken.address, symbol: pair.baseToken.symbol, price },
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
