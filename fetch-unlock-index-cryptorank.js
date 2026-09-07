// SECOND UNLOCK INDEX — CryptoRank. This is an INDEX, not evidence.
//
//   node fetch-unlock-index-cryptorank.js          refresh data/unlock-index-cryptorank.json
//
// WHY A SECOND ONE: one Cloudflare rule at DefiLlama silences 29 sourced rows. A
// second, independently-reachable source is the fix. It does NOT make a date more
// true — two aggregators concurring is still not chain evidence — it makes the
// tier survive one source going away, and it makes DISAGREEMENT visible.
//
// THE PAID API IS NOT THE PATH. CryptoRank's /v3 unlock endpoints
// (currencies/upcoming-token-unlocks, vesting/events, vesting/schedule) are Pro
// tier, $4,750/year; the free Sandbox key's 33 endpoints carry no unlock data. The
// 401s logged in August were plan-gating, not a broken key. DO NOT RETRY THE KEY.
//
// The route used here is the one the public page uses for its own table:
// api.cryptorank.io/v0/app/consolidated-vesting — keyless, no account, and (unlike
// defillama.com) reachable from the sandbox AND the desktop, so this one can run
// unattended. Found by loading the page in the browser pane and watching what it
// requested, rather than guessing endpoint names.
//
// UNITS DIFFER FROM DEFILLAMA, deliberately preserved rather than converted:
// CryptoRank states the next unlock as a percentage of CIRCULATING supply; the
// DefiLlama index is in tokens against maxSupply. Converting here would invent
// precision, so both are carried as the source states them and the comparison
// (Part 4) is done on DATES, which both express the same way.
//
// FAILS LOUD. A silently empty second source is worse than none: it looks like
// coverage. Exit 2, nothing written, on any of — non-200, unparseable body,
// implausible row count, or zero usable symbols.
import { writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const OUT = 'data/unlock-index-cryptorank.json';
const API = 'https://api.cryptorank.io/v0/app/consolidated-vesting';
const HEADERS = { 'user-agent': 'Mozilla/5.0 Chrome/128.0', accept: 'application/json', referer: 'https://cryptorank.io/token-unlock' };
// PAGE SIZE IS LOAD-BEARING, not a tuning knob. The same 382 rows come back either
// way, but at limit=100 only 19 carry BOTH a symbol and a date, and at limit=20 that
// is 81 — the server returns fuller records for smaller pages. Measured, not
// assumed; the first version of this file used 100 and quietly saw a quarter of the
// calendar. Changing this number changes what the index CONTAINS.
const PAGE = 20;
const MIN_ROWS = 50;              // plausibility floor, same idea as the DefiLlama gate

export async function fetchCryptorank({ maxPages = 25, fetchImpl = fetch } = {}) {
  const rows = [];
  let total = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `${API}?limit=${PAGE}&skip=${page * PAGE}&sortingColumn=date&sortingDirection=ASC`;
    const r = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (r.status !== 200) throw new Error(`${API} HTTP ${r.status} on page ${page} — index NOT refreshed`);
    let j;
    try { j = JSON.parse(await r.text()); } catch { throw new Error(`unparseable JSON on page ${page} — index NOT refreshed`); }
    if (!Array.isArray(j?.data)) throw new Error(`page ${page} has no data[] — the response shape moved; index NOT refreshed`);
    total = j.total ?? total;
    rows.push(...j.data);
    if (!j.data.length || (total != null && rows.length >= total)) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  if (rows.length < MIN_ROWS) throw new Error(`only ${rows.length} rows (total says ${total}) — implausible; index NOT refreshed`);
  return { rows, total };
}

// Pure. One entry per symbol: the next unlock CryptoRank lists, with its allocation
// breakdown. Rows with no dated next unlock are dropped — an undated row cannot be
// compared against anything and would only pad the count.
export function shape(rows, total) {
  const protocols = [];
  for (const r of rows || []) {
    const sym = String(r.symbol || '').toUpperCase();
    const ups = Array.isArray(r.nextUnlocks) ? r.nextUnlocks.filter((u) => u?.date) : [];
    const date = (r.date || ups[0]?.date || '').slice(0, 10);
    if (!sym || !/^\d{4}-\d\d-\d\d$/.test(date)) continue;
    const tokens = ups.reduce((s, u) => s + Number(u.tokens || 0), 0);
    protocols.push({ symbol: sym, name: r.name, key: r.key, nextDate: date,
      nextTokens: Math.round(tokens) || null,
      nextPctOfCirculating: r.nextUnlockPercent != null ? +Number(r.nextUnlockPercent).toFixed(4) : null,
      circSupply: r.circulatingSupply ?? null, lockedTokens: r.lockedTokens ?? null,
      allocations: ups.map((u) => ({ name: u.allocationName, tokens: Math.round(Number(u.tokens || 0)) })) });
  }
  // Rows the free surface withholds identity for (isHidden: true — CryptoRank's Pro
  // boundary). Counted so "we saw N of M" is on the record: a shrinking identified
  // set must be visible, not inferred from a smaller file.
  const withheld = (rows || []).filter((r) => r?.isHidden).length;
  const undated = (rows || []).filter((r) => String(r?.symbol || '').length && !/^\d{4}-\d\d-\d\d/.test(String(r?.date || ''))).length;
  return { fetchedAt: new Date().toISOString().slice(0, 16), total: total ?? protocols.length, withheld, undated,
    source: 'api.cryptorank.io/v0/app/consolidated-vesting (keyless, the public token-unlock table\'s own endpoint) — INDEX ONLY: every field is a CLAIM attributed to CryptoRank, never a verified fact',
    note: 'ONE next-unlock per symbol, as CryptoRank lists it. nextPctOfCirculating is CryptoRank\'s percentage of CIRCULATING supply — NOT comparable to the DefiLlama index\'s tokens-against-maxSupply without a conversion that is deliberately not made here. Dates are comparable; amounts are not.',
    protocols };
}

const IS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_CLI) {
  try {
    const { rows, total } = await fetchCryptorank();
    const out = shape(rows, total);
    if (!out.protocols.length) throw new Error('zero usable symbols after shaping — index NOT refreshed');
    if (existsSync(OUT)) copyFileSync(OUT, OUT.replace('.json', `.${new Date().toISOString().slice(0, 10)}.bak.json`));
    writeFileSync(OUT + '.tmp', JSON.stringify(out));
    renameSync(OUT + '.tmp', OUT);
    console.log(`cryptorank index refreshed: ${out.protocols.length} dated+identified symbols of ${total} rows (${out.withheld} identity withheld by the source, ${out.undated} listed without a next date) → ${OUT}`);
  } catch (e) {
    console.error('[OPERATOR] fetch-unlock-index-cryptorank FAILED — index NOT refreshed:', e.message);
    process.exit(2);
  }
}
