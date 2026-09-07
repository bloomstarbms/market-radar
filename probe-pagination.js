// PAGINATION PROBE — "does the paging parameter change the ANSWER, not just the trip?"
//
//   node probe-pagination.js
//
// CLASS, found on CryptoRank 2026-09-07: the same 382 rows came back at limit=20
// and limit=100, but only 19 of the limit=100 rows carried both a symbol and a date
// versus 81 at limit=20. A LARGER page returned FEWER USABLE ROWS. Invisible to a
// row-count check; it would have silently indexed a quarter of the calendar. Third
// pagination bite in this project (L3's 120-page proxy, the cadence bootstrap
// truncation, this), so it is a script rather than a memory.
//
// Addresses and tokens are resolved from unlocks.json, never typed.
//
// A SKIPPED OR EMPTY SIDE IS A FAILURE, NOT A PASS. The first version of this file
// printed "PAGE SIZE DOES NOT CHANGE THE ANSWER" while one side had returned zero
// rows and the other probe had been skipped for a missing key — the probe had the
// bug it was hunting.
import { readFileSync } from 'node:fs';

const KEY = (() => { try { return (readFileSync('.env', 'utf8').match(/ETHERSCAN_API_KEY=(.*)/) || [])[1]?.trim() || ''; } catch { return ''; } })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(25000) }); return { status: r.status, json: r.status === 200 ? await r.json() : null }; };
const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name} — ${detail}`); };

const tokens = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens;
const eigen = tokens.find((t) => t.sym === 'EIGEN');
const wallet = eigen?.cadence?.wallets?.[0]?.addr ?? eigen?.cadence?.wallet;
// Any tracked row whose token is a real ethereum address (EIGEN's is a coingecko id).
const ercRow = tokens.find((t) => String(t.token || '').startsWith('ethereum:0x'));
const erc = String(ercRow?.token || '').split(':')[1];

async function blockscoutDepth(addr, sym, pages) {
  const byDay = {}; let next = '', n = 0, truncated = true;
  for (let p = 0; p < pages; p++) {
    const { json: j } = await get(`https://eth.blockscout.com/api/v2/addresses/${addr}/token-transfers?filter=from${next}`);
    if (!j) return { byDay, n, truncated, failed: true };
    for (const t of j.items || []) {
      if (sym && (t.token?.symbol || '') !== sym) continue;
      const d = (t.timestamp || '').slice(0, 10);
      if (d) { byDay[d] = (byDay[d] || 0) + Number(t.total?.value || 0) / 10 ** Number(t.total?.decimals ?? 18); n++; }
    }
    if (!j.next_page_params) { truncated = false; break; }
    next = '&' + Object.entries(j.next_page_params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    await sleep(300);
  }
  return { byDay, n, truncated, failed: false };
}

console.log('— Blockscout token-transfers (feeds cadence AND cliff verdicts) —');
// 1. There is no page-size knob to get wrong: the API accepts only its default.
//    Establish that, so a future session does not "optimise" by raising it.
const sizes = {};
for (const ic of ['', '&items_count=50', '&items_count=100', '&items_count=200']) {
  const { status, json } = await get(`https://eth.blockscout.com/api/v2/addresses/${wallet}/token-transfers?filter=from${ic}`);
  sizes[ic || 'default'] = status === 200 ? (json.items || []).length : status;
  await sleep(300);
}
record('page size is FIXED at 50 — larger values are refused, not silently degraded',
  sizes.default === 50 && sizes['&items_count=50'] === 50 && sizes['&items_count=100'] === 422 && sizes['&items_count=200'] === 422,
  JSON.stringify(sizes));

// 2. What CAN vary is DEPTH. Deeper traversal must only extend the window backwards,
//    never revise a day already seen — cadence sums days, so a revision moves verdicts.
const shallow = await blockscoutDepth(wallet, 'EIGEN', 3);
await sleep(400);
const deep = await blockscoutDepth(wallet, 'EIGEN', 8);
const okRows = !shallow.failed && !deep.failed && shallow.n > 0 && deep.n >= shallow.n;
const oldestShallow = Math.min(...Object.keys(shallow.byDay).map((d) => Date.parse(d)));
// EXCLUDE THE BOUNDARY DAY. A truncated fetch stops mid-day, so its OLDEST day holds
// a partial sum by construction — the deeper fetch completing it is correct
// behaviour, not a revision. Comparing it anyway was the probe's own bug: it
// reported a defect on the one day where a difference is expected. Every reader
// keeps this day strictly outside the window it evaluates (fixture 54).
const revised = Object.entries(shallow.byDay)
  .filter(([d]) => Date.parse(d) > oldestShallow)
  .filter(([d, v]) => Math.round(v) !== Math.round(deep.byDay[d] ?? -1));
record('deeper traversal only EXTENDS backwards — no day already seen is revised',
  okRows && revised.length === 0,
  okRows ? `${shallow.n} vs ${deep.n} transfers · ${Object.keys(shallow.byDay).length} vs ${Object.keys(deep.byDay).length} days · ${revised.length} revised (${revised.slice(0, 3).map(([d]) => d).join(', ') || 'none'}) · shallow reaches ${new Date(oldestShallow).toISOString().slice(0, 10)}`
    : `EMPTY OR FAILED SIDE — not evidence (shallow n=${shallow.n} failed=${shallow.failed}, deep n=${deep.n} failed=${deep.failed})`);

console.log('— Etherscan v2 tokentx (feeds whale facts) —');
if (!KEY) record('etherscan probe ran', false, 'NO ETHERSCAN_API_KEY on file — SKIPPED, which is not a pass');
else if (!erc) record('etherscan probe ran', false, 'no tracked row carries an ethereum: token address — SKIPPED, not a pass');
else {
  const a = await get(`https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokentx&contractaddress=${erc}&page=1&offset=100&sort=desc&apikey=${KEY}`);
  await sleep(500);
  const b = await get(`https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokentx&contractaddress=${erc}&page=1&offset=1000&sort=desc&apikey=${KEY}`);
  const ra = Array.isArray(a.json?.result) ? a.json.result : [];
  const rb = Array.isArray(b.json?.result) ? b.json.result : [];
  const fa = [...new Set(ra.map((r) => Object.keys(r).sort().join(',')))];
  const fb = [...new Set(rb.map((r) => Object.keys(r).sort().join(',')))];
  const head = ra.length && rb.length && ra.slice(0, 50).every((r, i) => r.hash === rb[i]?.hash && r.value === rb[i]?.value);
  record('a larger offset does not change fields or the rows they share',
    ra.length > 0 && rb.length > 0 && fa.length === 1 && fb.length === 1 && fa[0] === fb[0] && head,
    `${ercRow.sym}: offset=100 -> ${ra.length} rows / ${fa.length} field-set(s), offset=1000 -> ${rb.length} rows / ${fb.length} field-set(s), first 50 identical: ${head}`);
}

const failed = results.filter((r) => !r.pass);
console.log(failed.length
  ? `\n⚠️ ${failed.length} of ${results.length} checks did not pass — a paginated reader may be page-dependent, or was not actually probed.`
  : `\nAll ${results.length} checks pass: page size and depth do not change the answer for the verdict-bearing readers.`);
process.exit(failed.length ? 1 : 0);
