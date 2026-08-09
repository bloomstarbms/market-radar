// Contract-risk screen for DEX alerts — spec §3.5.
//
// This is a BLOCKING gate, not a score input. It runs before a DEX candidate is even
// scored, and any failure drops it permanently. The system previously surfaced
// low-float onchain tokens with no safety check at all, which is the one defect that
// can cost money rather than merely waste attention.
//
// Source: GoPlus Security — free, keyless, verified HTTP 200. Cached 24h per token.
//
// FAIL-CLOSED: if the screen cannot be completed (API down, chain unsupported, token
// unknown) the candidate is dropped. An unverified contract is treated exactly like a
// failed one — the whole point is that we do not point at unscreened tokens.
import { config } from '../../config.js';

const EVM_CHAIN = { ethereum: '1', bsc: '56', base: '8453', arbitrum: '42161', polygon: '137', optimism: '10', avalanche: '43114' };
const CACHE_MS = 24 * 3600e3;
const cache = new Map(); // chain:address -> { at, result }

// Thresholds. GoPlus returns percentages as FRACTIONS ("0.0855" = 8.55%), which is an
// easy way to be wrong by 100x — keep everything in fraction space here.
export const RULES = {
  maxTaxFraction: Number(process.env.RUG_MAX_TAX || 0.05),
  minLpLocked: Number(process.env.RUG_MIN_LP_LOCKED || 0.80),
  maxTop10: Number(process.env.RUG_MAX_TOP10 || 0.35),
  maxDeployer: Number(process.env.RUG_MAX_DEPLOYER || 0.05),
  minPoolAgeH: Number(process.env.RUG_MIN_POOL_AGE_H || 72),
  minLiquidityUsd: Number(process.env.RUG_MIN_LIQUIDITY || 500_000),
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const isTrue = (v) => String(v) === '1';

async function goplus(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`goplus ${res.status}`);
  const j = await res.json();
  if (String(j.code) !== '1') throw new Error(`goplus code ${j.code}`);
  return j.result || {};
}

// LP-lock and holder-concentration are LAUNCH-PHASE risks: they model "the deployer
// pulls the floor out". On a mature, deep pool the LP is distributed across many
// unlocked positions and the check is meaningless — applying it there blocks LINK and
// PEPE as rugs, which is a false positive that would destroy trust in the screen.
// So these two run only inside the risk window.
function inLaunchWindow(checks) {
  const youngPool = checks.poolAgeH === undefined || checks.poolAgeH < 180 * 24;
  const thinPool = (checks.liquidityUsd ?? 0) < 2_000_000;
  return youngPool || thinPool;
}

function screenEvm(d, fails, checks) {
  if (isTrue(d.is_honeypot) || isTrue(d.cannot_sell_all)) fails.push('honeypot');
  if (isTrue(d.is_mintable)) fails.push('mint-authority-live');
  if (isTrue(d.is_proxy)) fails.push('upgradeable-proxy');
  if (isTrue(d.can_take_back_ownership)) fails.push('ownership-reclaimable');
  if (isTrue(d.hidden_owner)) fails.push('hidden-owner');
  if (isTrue(d.selfdestruct)) fails.push('selfdestruct');

  // Blacklist is a CONTEXTUAL risk, not an inherent one. USDC and USDT both ship one as
  // a compliance requirement — the function existing has never been the hazard. Whether
  // anyone can still CALL it is. So: dormant code on a renounced contract passes; a live
  // or reclaimable owner blocks; an upgradeable proxy blocks unconditionally, because
  // the implementation can be swapped regardless of who owns it today.
  if (isTrue(d.is_blacklisted)) {
    const renounced = /^0x0{40}$/.test(d.owner_address || '') || !d.owner_address;
    if (isTrue(d.is_proxy)) fails.push('blacklist+upgradeable');
    else if (!renounced || isTrue(d.can_take_back_ownership) || isTrue(d.hidden_owner)) {
      fails.push('blacklist+live-owner');
    }
  }

  const buy = num(d.buy_tax), sell = num(d.sell_tax);
  checks.buyTax = buy; checks.sellTax = sell;
  if (buy !== null && buy > RULES.maxTaxFraction) fails.push(`buy-tax-${(buy * 100).toFixed(1)}%`);
  if (sell !== null && sell > RULES.maxTaxFraction) fails.push(`sell-tax-${(sell * 100).toFixed(1)}%`);

  const dep = num(d.creator_percent);
  checks.deployerPct = dep;
  if (dep !== null && dep > RULES.maxDeployer) fails.push(`deployer-holds-${(dep * 100).toFixed(1)}%`);

  if (inLaunchWindow(checks)) {
    // LP lock: burned LP counts as locked (dead address), which is the common pattern.
    const lps = Array.isArray(d.lp_holders) ? d.lp_holders : [];
    if (lps.length) {
      const locked = lps.reduce((s, h) => {
        const burned = /^0x0{40}$|dead$/i.test(h.address || '');
        return s + (isTrue(h.is_locked) || burned ? (num(h.percent) || 0) : 0);
      }, 0);
      checks.lpLocked = locked;
      if (locked < RULES.minLpLocked) fails.push(`lp-locked-${(locked * 100).toFixed(0)}%`);
    } else {
      fails.push('lp-holders-unknown');
    }

    // Top-10 concentration, excluding contracts and GoPlus-tagged entities — an
    // exchange hot wallet is custody, not a concentrated holder about to dump.
    const holders = (Array.isArray(d.holders) ? d.holders : [])
      .filter((h) => !isTrue(h.is_contract) && !h.tag);
    if (holders.length) {
      const top10 = holders.slice(0, 10).reduce((s, h) => s + (num(h.percent) || 0), 0);
      checks.top10 = top10;
      if (top10 > RULES.maxTop10) fails.push(`top10-holds-${(top10 * 100).toFixed(0)}%`);
    }
  }
  return { fails, checks };
}

function screenSolana(d, fails, checks) {
  // Solana shape differs: authorities are objects with a status field.
  if (String(d.mintable?.status) === '1') fails.push('mint-authority-live');
  if (String(d.freezable?.status) === '1') fails.push('freeze-authority-live');
  if (String(d.closable?.status) === '1') fails.push('closable');
  if (String(d.non_transferable) === '1') fails.push('non-transferable');
  const fee = num(d.transfer_fee?.current_fee_rate ?? d.transfer_fee);
  if (fee !== null && fee > RULES.maxTaxFraction * 100) fails.push(`transfer-fee-${fee}%`);
  const holders = (Array.isArray(d.holders) ? d.holders : []);
  if (holders.length) {
    const top10 = holders.slice(0, 10).reduce((s, h) => s + (num(h.percent) || 0), 0);
    checks.top10 = top10;
    if (top10 > RULES.maxTop10) fails.push(`top10-holds-${(top10 * 100).toFixed(0)}%`);
  }
  return { fails, checks };
}

// pair = DexScreener pair object (chainId, baseToken.address, liquidity.usd, pairCreatedAt)
export async function screen(pair) {
  const chain = pair.chainId;
  const addr = pair.baseToken?.address;
  if (!addr) return { pass: false, applicable: false, status: 'NOT_APPLICABLE', failures: ['no-address'], checks: {} };

  const fails = [], checks = {};

  // Liquidity and pool age come from the pair itself — no API call needed, and they
  // are the two cheapest disqualifiers, so check them first.
  const liq = pair.liquidity?.usd ?? 0;
  checks.liquidityUsd = liq;
  if (liq < RULES.minLiquidityUsd) fails.push(`liquidity-$${Math.round(liq / 1000)}k`);
  if (pair.pairCreatedAt) {
    const ageH = (Date.now() - pair.pairCreatedAt) / 3600e3;
    checks.poolAgeH = Math.round(ageH);
    if (ageH < RULES.minPoolAgeH) fails.push(`pool-age-${Math.round(ageH)}h`);
  }

  const key = `${chain}:${addr.toLowerCase()}`;
  const hit = cache.get(key);
  let contract = hit && Date.now() - hit.at < CACHE_MS ? hit.result : null;

  if (!contract) {
    try {
      if (chain === 'solana') {
        const r = await goplus(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${addr}`);
        contract = Object.values(r)[0] || null;
      } else if (EVM_CHAIN[chain]) {
        const r = await goplus(`https://api.gopluslabs.io/api/v1/token_security/${EVM_CHAIN[chain]}?contract_addresses=${addr.toLowerCase()}`);
        contract = Object.values(r)[0] || null;
      } else {
        // NOT_APPLICABLE, not a risk finding. The asset has no DEX presence we screen
        // for — a CEX-only listing, typically. Conflating this with a block would read
        // structural absence as danger and make the step-3 funnel log meaningless.
        return { pass: false, applicable: false, status: 'NOT_APPLICABLE',
          failures: [...fails, `no-dex-coverage-${chain}`], checks };
      }
      if (!contract || !Object.keys(contract).length) {
        // A pair exists but the security provider has no record — genuinely unverifiable,
        // so fail closed.
        return { pass: false, applicable: true, status: 'UNVERIFIABLE',
          failures: [...fails, 'not-indexed'], checks };
      }
      cache.set(key, { at: Date.now(), result: contract });
    } catch (e) {
      return { pass: false, applicable: true, status: 'UNVERIFIABLE',
        failures: [...fails, `screen-unavailable(${e.message})`], checks };
    }
  }

  if (chain === 'solana') screenSolana(contract, fails, checks);
  else screenEvm(contract, fails, checks);

  const pass = fails.length === 0;
  if (config.debug && !pass) console.log(`  [rug] ${pair.baseToken?.symbol} (${chain}) BLOCKED: ${fails.join(', ')}`);
  return { pass, applicable: true, status: pass ? 'PASS' : 'BLOCKED', failures: fails, checks };
}
