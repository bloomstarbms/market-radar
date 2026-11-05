// VESTING DISCOVERY — automates the EIGEN session's manual sequence:
// holders -> contracts -> selector battery -> bucket classification.
//
//   node discover-vesting.js EIGEN            one token
//   node discover-vesting.js EIGEN ARB INJ    several
//   node discover-vesting.js --watchlist      every EVM-resolvable token in unlocks.json
//
// DISCOVERY IS ALSO THE FILTER: run it wide and let it surface which tokens have
// READABLE vesting. The 12-token list it replaces was gate-passing ∩ has-schedule —
// a filter whose justification (unlocks as trade signals) expired with the FACT/CALL
// split. The real constraint is VERIFICATION COST, which this attacks.
//
// ETHEREUM-ONLY (v1). Non-EVM chains are out of scope and every report says so.
// READ-ONLY: writes only its own report file (data/vesting-discovery.json).
// Buckets: A = OZ VestingWallet/Timelock (schedule parsed) · B = Sablier/LlamaPay ·
// C = custom contract, unreadable selectors · D = custody/multisig · none = no
// significant contract-held supply (retirement candidate if schedule known complete).
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

const KEY = (() => {
  try { return readFileSync('.env', 'utf8').match(/ETHERSCAN_API_KEY=(\S+)/)?.[1] ?? ''; } catch { return ''; }
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 15s abort: one stalled connection must not eat a whole scan slice (the runtime
// kills any invocation at ~170s; an un-timed-out fetch turns that into lost work).
const jget = async (url) => { try { const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); return await r.json(); } catch { return null; } };

const SEL = {  // OZ VestingWallet + TokenTimelock view selectors
  start: '0xbe9a6555', duration: '0x0fb5a6b4', beneficiary: '0x38af3eed',
  releaseTime: '0xb91d4001', token: '0xfc0c546a',
};
const EXCHANGE_RX = /binance|okx|kraken|bybit|gate\.?io|bitget|upbit|bithumb|coinbase|kucoin|mexc|hot ?wallet|cold ?wallet|deposit/i;
// Validation-run lessons (27 Aug): pools, staking and bridges are NOT vesting and
// polluted every verdict; bridged tokens show their ESCROW as a 50% holder.
const POOL_RX = /uniswapv[23]|pancake|curve|balancer.*vault|sushiswap|pool$|pair$/i;
const STAKING_RX = /staked|staking|stEIGEN|sENA|escrowed|xToken/i;
// 2026-09-05: StakeStoneLayerZeroAdapter produced a false CADENCE hit (bridge flow
// read as custody emission) and ZetaConnectorEth read as a 10% custom holder. Bridge
// adapters/connectors are ESCROW, never locked supply — widened to the class.
const BRIDGE_RX = /oftadapter|layerzeroadapter|adapter$|connector|bridge|peggy|portal|wormhole|l1standard|anyswap|multichain|canonical/i;

// AUTHORITATIVE ADDRESSES for tokens we already know — DexScreener resolution sent
// EIGEN to a symbol-squatter on the validation run. Resolution by search is a
// FALLBACK for unknowns and is flagged as such in the report.
const KNOWN_TOKENS = {
  EIGEN: '0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83',
  ENA:   '0x57e114B691Db790C35207b2e685D4A43181e6061',
  ZRO:   '0x6985884C4392D348587B19cb9eAAf157F13271cd',
};
// Tokens whose vesting lives on ANOTHER chain: Ethereum discovery sees at most a
// bridge escrow, which must never be read as locked supply. Honest verdict, not a
// wrong one. (INJ's retirement came from public docs — no machine path from here.)
const NON_NATIVE = { INJ: 'injective', SUI: 'sui', SEI: 'sei', APT: 'aptos', JUP: 'solana',
  TIA: 'celestia', STRK: 'starknet', ARB: 'arbitrum-one', OP: 'optimism', ATOM: 'cosmos',
  NEAR: 'near', ICP: 'icp', ADA: 'cardano', SOL: 'solana', XRP: 'xrpl', TRX: 'tron',
  DOT: 'polkadot', AVAX: 'avalanche', TON: 'ton', KAS: 'kaspa', LTC: 'litecoin',
  BCH: 'bch', DOGE: 'dogecoin', XLM: 'stellar', ALGO: 'algorand' };
const CUSTODY_RX = /walletsimple|gnosissafe|safeproxy|^safe$|multisig/i;
const STREAM_RX = /sablier|llamapay|superfluid|hedgey|team ?finance|unicrypt|tokenvesting.*factory/i;

async function ethCall(to, data) {
  const j = await jget(`https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_call&to=${to}&data=${data}&tag=latest&apikey=${KEY}`);
  const r = j?.result;
  return (typeof r === 'string' && r !== '0x') ? r : null;
}
const asTs = (hex) => { if (!hex) return null; const n = parseInt(hex, 16); return (n > 1.4e9 && n < 2.6e9) ? n * 1000 : null; };
const asNum = (hex) => { if (!hex) return null; const n = parseInt(hex, 16); return Number.isFinite(n) ? n : null; };

async function resolveToken(sym) {
  const j = await jget(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`);
  const cands = (j?.pairs || [])
    .filter((p) => p.chainId === 'ethereum' && p.baseToken?.symbol?.toUpperCase() === sym.toUpperCase()
      && (p.liquidity?.usd || 0) > 500_000)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return cands[0]?.baseToken?.address ?? null;
}

async function classifyContract(addr, name) {
  // Name-based first (free): exchanges are custody-exchange, not vesting; skip.
  if (name && EXCHANGE_RX.test(name)) return { bucket: 'skip-exchange', name };
  if (name && POOL_RX.test(name)) return { bucket: 'skip-pool', name };
  if (name && STAKING_RX.test(name)) return { bucket: 'skip-staking', name };
  if (name && BRIDGE_RX.test(name)) return { bucket: 'skip-bridge', name };
  if (name && CUSTODY_RX.test(name)) return { bucket: 'D', why: 'custody: ' + name };
  if (name && STREAM_RX.test(name)) return { bucket: 'B', why: 'stream: ' + name };
  // 1167 clone? Classify by the IMPLEMENTATION's name if verified.
  const code = await jget(`https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getCode&address=${addr}&tag=latest&apikey=${KEY}`);
  const bc = code?.result || '';
  const m = bc.match(/363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/);
  let implName = null;
  if (m) {
    await sleep(220);
    const src = await jget(`https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getsourcecode&address=0x${m[1]}&apikey=${KEY}`);
    implName = (src?.result || [])[0]?.ContractName || null;
    if (implName && CUSTODY_RX.test(implName)) return { bucket: 'D', why: 'custody clone: ' + implName };
    if (implName && STREAM_RX.test(implName)) return { bucket: 'B', why: 'stream clone: ' + implName };
  }
  // Selector battery — schedule-shaped?
  await sleep(220); const start = asTs(await ethCall(addr, SEL.start));
  await sleep(220); const duration = asNum(await ethCall(addr, SEL.duration));
  await sleep(220); const releaseTime = asTs(await ethCall(addr, SEL.releaseTime));
  if (start && duration && duration > 86400 && duration < 15 * 365 * 86400) {
    await sleep(220);
    const bene = await ethCall(addr, SEL.beneficiary);
    return { bucket: 'A', why: 'OZ VestingWallet', schedule: {
      start: new Date(start).toISOString().slice(0, 10),
      end: new Date(start + duration * 1000).toISOString().slice(0, 10),
      durationDays: Math.round(duration / 86400),
      beneficiary: bene ? '0x' + bene.slice(-40) : null } };
  }
  if (releaseTime) {
    return { bucket: 'A', why: 'OZ TokenTimelock', schedule: { releaseAt: new Date(releaseTime).toISOString().slice(0, 10) } };
  }
  return { bucket: 'C', why: implName ? 'custom: ' + implName : (name ? 'custom: ' + name : 'custom, unverified') };
}

// opts.addr: pre-resolved address from an AUTHORITATIVE source (bulk scan resolves
// via CoinGecko mcap-rank, recorded in data/resolution-map.json) — bypasses the
// flagged DexScreener fallback. opts.addrSource labels the provenance in the report.
export async function discover(sym, opts = {}) {
  const out = { sym, chain: 'ethereum', at: new Date().toISOString().slice(0, 16), contracts: [], note: 'Ethereum-only v1 — non-EVM vesting invisible to this pass.' };
  if (NON_NATIVE[sym]) {
    out.verdict = 'NON-NATIVE';
    out.nativeChain = NON_NATIVE[sym];
    out.note = `Vesting lives on ${NON_NATIVE[sym]}; the Ethereum ERC-20 (if any) is a bridged representation whose escrow holder is NOT locked supply. v1 cannot read this token — do not mistake this for NO-LOCKED-SUPPLY.`;
    return out;
  }
  let addr = KNOWN_TOKENS[sym] ?? opts.addr ?? null;
  if (KNOWN_TOKENS[sym]) out.addressSource = 'authoritative map';
  else if (opts.addr) out.addressSource = opts.addrSource ?? 'caller-resolved';
  if (!addr) { addr = await resolveToken(sym); if (addr) out.resolutionWarning = 'address resolved by DEX search, not authoritative — verify before acting (EIGEN validation run resolved to a symbol-squatter this way)'; }
  if (!addr) { out.verdict = 'UNRESOLVED'; out.note += ' No canonical Ethereum ERC-20 with >$500k DEX liquidity found.'; return out; }
  out.token = addr;
  const info = await jget(`https://eth.blockscout.com/api/v2/tokens/${addr}`);
  const dec = Number(info?.decimals ?? 18);
  const supply = Number(info?.total_supply ?? 0) / 10 ** dec;
  // "We did not look" must never read as "nothing there" (windowObserved class): a
  // failed/empty info fetch would make THRESH=0 and cascade into a false verdict.
  if (!info || !(supply > 0)) { out.verdict = 'FETCH-FAILED'; out.note += ' Token info fetch failed or zero supply — RETRYABLE, not a vesting verdict.'; return out; }
  out.totalSupply = supply;
  const THRESH = supply * 0.003; // 0.3% of supply
  let next = '';
  for (let p = 0; p < 4; p++) {
    const j = await jget(`https://eth.blockscout.com/api/v2/tokens/${addr}/holders${next}`);
    let below = false;
    for (const it of (j?.items || [])) {
      const bal = Number(it.value) / 10 ** dec;
      if (bal < THRESH) { below = true; break; }
      const a = it.address || {};
      if (!a.is_contract || a.hash?.toLowerCase() === addr.toLowerCase()) continue;
      out.contracts.push({ addr: a.hash, name: a.name || null, bal: Math.round(bal), pctSupply: +(100 * bal / supply).toFixed(2) });
    }
    // PAGINATION-EXEMPT(discover-vesting.js): holder traversal is BALANCE-ordered, not date-bounded. It
    // stops at the first holder below THRESH, so there is no "oldest day" and no
    // boundary day that could land inside a scored window. What truncation costs
    // here is small holders, which are below the bucket threshold by construction.
    if (below || !j?.next_page_params) break;
    next = '?' + Object.entries(j.next_page_params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    await sleep(300);
  }
  for (const c of out.contracts) {
    await sleep(250);
    Object.assign(c, await classifyContract(c.addr, c.name));
  }
  const real = out.contracts.filter((c) => !String(c.bucket).startsWith('skip'));
  const buckets = {};
  for (const c of real) buckets[c.bucket] = (buckets[c.bucket] || 0) + 1;
  out.buckets = buckets;
  const lockedPct = real.reduce((s, c) => s + (c.pctSupply || 0), 0);
  out.contractHeldPctSupply = +lockedPct.toFixed(1);
  out.verdict = real.some((c) => c.bucket === 'A') ? 'A-READABLE'
    : real.some((c) => c.bucket === 'B') ? 'B-STREAM'
    : real.some((c) => c.bucket === 'D') ? 'D-CUSTODY'
    : real.some((c) => c.bucket === 'C') ? 'C-CUSTOM'
    : 'NO-LOCKED-SUPPLY';
  // AUTOMATIC RETIREMENT PROPOSAL — the INJ pattern, found by machine this time.
  if (out.verdict === 'NO-LOCKED-SUPPLY' && lockedPct < 2)
    out.proposal = 'retired: fully-unlocked? No vesting-shaped contract holds >=0.3% of supply on Ethereum. CONFIRM the schedule is known-complete before retiring — absence of readable locks is not proof of full unlock for tokens vesting off-chain or on another chain.';
  return out;
}

// ARBITRUM ONE (2026-11-04) — discovery by GENESIS TRACE, because no free holder list exists there:
// arbitrum.blockscout.com answers with a Cloudflare challenge (desktop and VPS), and Etherscan's
// tokenholderlist/tokeninfo are API Pro. What the free key DOES answer on chain 42161: tokentx,
// tokenbalance, tokensupply, getsourcecode, eth_getCode. So the wallets are found the way the
// tokens travelled: the token's first transfers (the genesis distribution) -> every recipient
// holding >= 0.3% of supply -> where each custody Safe or unverified contract among them sent its
// ARB (recipients >= 0.01%, one more hop for large custody/unverified ones) -> classified by
// VERIFIED contract name. No address is typed: the token comes from data/unlock-index.json.
// Buckets as on Ethereum, plus: a verified *VestingWallet* contract is 'A' (vesting, schedule in
// the contract), 'skip-eoa' for externally owned accounts (supply an EOA holds is not readable).
const ARB_CHAIN_ID = 42161;
async function esArb(q, key = KEY) {
  for (let i = 0; i < 4; i++) {
    const j = await jget(`https://api.etherscan.io/v2/api?chainid=${ARB_CHAIN_ID}&${q}&apikey=${key}`);
    if (j && /rate limit/i.test(String(j.result))) { await sleep(1500); continue; }
    if (j) return j;
    await sleep(1500);
  }
  return null;
}
async function arbTransfers(token, address, maxPages = 10, key = KEY) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const j = await esArb(`module=account&action=tokentx&contractaddress=${token}${address ? `&address=${address}` : ''}&page=${page}&offset=1000&sort=asc`, key);
    await sleep(350);
    if (!j) return { rows, complete: false };
    const xs = Array.isArray(j.result) ? j.result : [];
    rows.push(...xs);
    if (xs.length < 1000) return { rows, complete: true };
  }
  return { rows, complete: false };
}
async function arbClassify(addr, token, key = KEY) {
  const code = await esArb(`module=proxy&action=eth_getCode&address=${addr}&tag=latest`, key); await sleep(300);
  const bal = await esArb(`module=account&action=tokenbalance&contractaddress=${token}&address=${addr}&tag=latest`, key); await sleep(300);
  const balance = Number(bal?.result ?? 0) / 1e18;
  if (!code?.result || code.result === '0x') return { bucket: 'skip-eoa', why: 'externally owned account — its holdings are not readable as vesting', balance };
  const src = await esArb(`module=contract&action=getsourcecode&address=${addr}`, key); await sleep(300);
  const s = (src?.result || [])[0] || {};
  let name = s.ContractName || null;
  if (s.Proxy === '1' && s.Implementation) {
    const k = await esArb(`module=contract&action=getsourcecode&address=${s.Implementation}`, key); await sleep(300);
    name = ((k?.result || [])[0]?.ContractName || name || 'unverified') + ' (proxy)';
  }
  if (name && EXCHANGE_RX.test(name)) return { bucket: 'skip-exchange', name, balance };
  if (name && POOL_RX.test(name)) return { bucket: 'skip-pool', name, balance };
  if (name && BRIDGE_RX.test(name)) return { bucket: 'skip-bridge', name, balance };
  if (name && /vestingwallet/i.test(name)) return { bucket: 'A', why: 'vesting wallet: ' + name, name, balance };
  if (name && CUSTODY_RX.test(name)) return { bucket: 'D', why: 'custody: ' + name, name, balance };
  if (name && STREAM_RX.test(name)) return { bucket: 'B', why: 'stream: ' + name, name, balance };
  return { bucket: 'C', why: name ? 'custom: ' + name : 'custom, unverified', name, balance };
}
// opts.key: the Etherscan key (default: .env); opts.index: the unlock index object (default: data/unlock-index.json).
export async function discoverArbitrum(sym, opts = {}) {
  const key = opts.key ?? KEY;
  const out = { sym, chain: 'arbitrum-one', at: new Date().toISOString().slice(0, 16), contracts: [],
    method: 'genesis trace (Arbitrum One has no free holder list: Blockscout challenge-walled, Etherscan holder list is Pro)' };
  const ix = (opts.index ?? (existsSync('data/unlock-index.json') ? JSON.parse(readFileSync('data/unlock-index.json', 'utf8')) : { protocols: [] })).protocols.find((p) => p.symbol === sym);
  const token = ix?.token?.startsWith('arbitrum:') ? ix.token.slice('arbitrum:'.length) : null;
  if (!token) { out.verdict = 'UNRESOLVED'; out.note = `${sym} has no arbitrum: token in data/unlock-index.json — nothing to trace`; return out; }
  if (!key) { out.verdict = 'NO-KEY'; out.note = 'ETHERSCAN_API_KEY missing from .env'; return out; }
  out.token = token; out.addressSource = 'data/unlock-index.json (DefiLlama token field)';
  const sup = await esArb(`module=stats&action=tokensupply&contractaddress=${token}`, key);
  const supply = Number(sup?.result ?? 0) / 1e18;
  if (!(supply > 0)) { out.verdict = 'FETCH-FAILED'; out.note = 'token supply fetch failed — RETRYABLE, not a vesting verdict'; return out; }
  out.totalSupply = supply;
  const seen = new Map();
  const add = (to, amt, parent, depth) => { const k = to.toLowerCase(); const r = seen.get(k) || { addr: to, received: 0, parents: new Set(), depth }; r.received += amt; r.parents.add(parent); r.depth = Math.min(r.depth, depth); seen.set(k, r); return r; };
  const g = await arbTransfers(token, null, 10, key);
  out.genesisWindow = g.rows.length ? [new Date(+g.rows[0].timeStamp * 1000).toISOString().slice(0, 10), new Date(+g.rows.at(-1).timeStamp * 1000).toISOString().slice(0, 10)] : null;
  // Each transfer is counted once. The genesis window holds the minter's own sends, and the minter is
  // then traced as a depth-1 EOA, so the same transfer comes back as one of its outflows (2026-11-05:
  // ARB's team Safe read 5,387.9M received for one 2,694.0M transfer). A genesis row is marked counted
  // only when its recipient is admitted here, so a recipient too small for level 1 is still found as a hop.
  const txKey = (t) => `${t.hash}:${t.logIndex ?? ''}:${t.from}:${t.to}:${t.value}`.toLowerCase();
  const counted = new Set();
  const level1 = new Map();
  for (const t of g.rows) { const v = Number(t.value) / 1e18; const k = t.to.toLowerCase(); const e = level1.get(k) || { to: t.to, amt: 0, keys: [] }; e.amt += v; e.keys.push(txKey(t)); level1.set(k, e); }
  const frontier = [];
  for (const { to, amt, keys } of level1.values()) if (amt >= supply * 0.003) { frontier.push(add(to, amt, 'genesis', 1)); for (const k of keys) counted.add(k); }
  // Trace outward from custody / unverified contracts, at most three hops from genesis.
  const traced = new Set();
  while (frontier.length) {
    const r = frontier.shift();
    if (!r.cls) Object.assign(r, { cls: await arbClassify(r.addr, token, key) });
    const b = r.cls.bucket;
    if (traced.has(r.addr.toLowerCase()) || r.depth >= 3 || !(b === 'D' || b === 'C' || (b === 'skip-eoa' && r.depth === 1))) continue;
    traced.add(r.addr.toLowerCase());
    const o = await arbTransfers(token, r.addr, 10, key);
    r.outComplete = o.complete;
    const by = new Map();
    for (const t of o.rows) {
      if (t.from.toLowerCase() !== r.addr.toLowerCase() || counted.has(txKey(t))) continue;
      counted.add(txKey(t));
      const k = t.to.toLowerCase(); by.set(k, { to: t.to, amt: (by.get(k)?.amt ?? 0) + Number(t.value) / 1e18 });
    }
    for (const { to, amt } of by.values()) if (amt >= supply * 0.0001) frontier.push(add(to, amt, r.addr, r.depth + 1));
  }
  for (const r of seen.values()) {
    if (!r.cls) r.cls = await arbClassify(r.addr, token, key);
    out.contracts.push({ addr: r.addr, depth: r.depth, parents: [...r.parents], received: Math.round(r.received), bal: Math.round(r.cls.balance), pctSupply: +(100 * r.cls.balance / supply).toFixed(3),
      bucket: r.cls.bucket, why: r.cls.why ?? null, name: r.cls.name ?? null, ...(r.outComplete === false ? { outflowsTruncated: true } : {}) });
  }
  out.contracts.sort((a, b) => b.bal - a.bal);
  const real = out.contracts.filter((c) => !String(c.bucket).startsWith('skip'));
  const buckets = {};
  for (const c of out.contracts) buckets[c.bucket] = (buckets[c.bucket] || 0) + 1;
  out.buckets = buckets;
  out.contractHeldPctSupply = +real.reduce((s, c) => s + c.pctSupply, 0).toFixed(1);
  out.verdict = real.some((c) => c.bucket === 'A') ? 'A-READABLE' : real.some((c) => c.bucket === 'D') ? 'D-CUSTODY' : real.some((c) => c.bucket === 'C') ? 'C-CUSTOM' : 'NO-LOCKED-SUPPLY';
  out.note = 'Arbitrum One by genesis trace. EOAs that received genesis supply are listed (skip-eoa) because what they hold cannot be read as vesting.';
  return out;
}

// ---- CLI (guarded: importing this module must not execute the CLI — the bulk
// orchestrator imports discover() and an unguarded IIFE would exit(1) on its argv)
import { pathToFileURL } from 'node:url';
const IS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const args = IS_CLI ? process.argv.slice(2).filter((a) => !a.startsWith('--')) : [];
const useWatchlist = IS_CLI && process.argv.includes('--watchlist');
const chainArg = IS_CLI ? (process.argv[process.argv.indexOf('--chain') + 1] ?? null) : null;
const onArbitrum = IS_CLI && process.argv.includes('--chain') && chainArg === 'arbitrum';
if (IS_CLI && process.argv.includes('--chain') && !onArbitrum) { console.error(`--chain ${chainArg}: only 'arbitrum' is supported (Ethereum is the default)`); process.exit(1); }
if (IS_CLI) (async () => {
  let syms = args.filter((a) => a !== 'arbitrum').map((s) => s.toUpperCase());
  if (useWatchlist) {
    const j = JSON.parse(readFileSync('unlocks.json', 'utf8'));
    syms = j.tokens.filter((t) => !t.retired).map((t) => t.sym);
  }
  if (!syms.length) { console.log('usage: node discover-vesting.js SYM [SYM...] | --watchlist'); process.exit(1); }
  const reportPath = 'data/vesting-discovery.json';
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
  for (const sym of syms) {
    process.stdout.write(`\n== ${sym} == `);
    try {
      const r = onArbitrum ? await discoverArbitrum(sym) : await discover(sym);
      report[sym] = r;
      console.log(r.verdict + (r.token ? '' : ' (no eth token)'));
      for (const c of (r.contracts || []).filter((c) => !String(c.bucket).startsWith('skip')))
        console.log(`   [${c.bucket}] ${c.addr.slice(0, 10)} ${String(c.bal).padStart(12)} (${c.pctSupply}%) ${c.why || c.name || ''}${c.schedule ? ' ' + JSON.stringify(c.schedule) : ''}${c.depth ? ` · hop ${c.depth}, received ${c.received}` : ''}`);
      if (onArbitrum) console.log(`   buckets ${JSON.stringify(r.buckets ?? {})} · contract-held ${r.contractHeldPctSupply ?? '?'}% of supply · genesis ${JSON.stringify(r.genesisWindow ?? null)}`);
      if (r.proposal) console.log('   PROPOSAL: ' + r.proposal);
    } catch (e) { console.log('FAILED: ' + e.message); report[sym] = { sym, verdict: 'ERROR', error: e.message }; }
    await sleep(500);
  }
  writeFileSync(reportPath + '.tmp', JSON.stringify(report, null, 1));
  renameSync(reportPath + '.tmp', reportPath);
  const counts = {};
  for (const s of syms) counts[report[s]?.verdict || '?'] = (counts[report[s]?.verdict || '?'] || 0) + 1;
  console.log('\nSUMMARY:', JSON.stringify(counts), '-> data/vesting-discovery.json');
})();
