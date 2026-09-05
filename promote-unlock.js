// Promote an unlock token estimated -> verified. CONSTRUCTS the row (whitelist copy);
// never edits in place, so nothing from the estimated era survives except identity.
//
//   node promote-unlock.js ZRO monthlyDay=20 date=2026-09-20 \
//        source=announcement detail="4.4% of circ monthly, 20th, per LayerZero docs" \
//        note="GnosisSafe-held; announcement path"
//
// Use this for the five pending confirmations (ZRO/OP/ENA/SUI/SEI) instead of hand
// editing unlocks.json — the 23 Aug milestone message carried a stale pctOfMcap
// precisely because promotion was done by hand-patching.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { promoteRow, resolveWalletRef } from './src/core/unlock-promote.js';
import { deriveTolerance } from './src/sources/calendar/cadence-watch.js';

// Every address a tool has actually written. wallet= is resolved against THIS set —
// a prefix is enough, a fabricated full address is refused. Never type addresses.
function reportAddresses() {
  const out = [];
  try {
    if (existsSync('data/vesting-discovery.json')) {
      for (const rep of Object.values(JSON.parse(readFileSync('data/vesting-discovery.json', 'utf8'))))
        for (const c of rep.contracts || []) if (c.addr) out.push(c.addr);
    }
    if (existsSync('data/cadence-report.json')) {
      for (const rep of Object.values(JSON.parse(readFileSync('data/cadence-report.json', 'utf8'))))
        for (const p of rep.perWallet || []) if (p.addr) out.push(p.addr);
    }
  } catch (e) { console.error('report read failed:', e.message); }
  return out;
}

const [sym, ...kvs] = process.argv.slice(2);
if (!sym) {
  console.log('usage: node promote-unlock.js SYM [monthlyDay=N] [date=YYYY-MM-DD] source=... detail="..." [note="..."]');
  process.exit(1);
}
const args = Object.fromEntries(kvs.map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
if (!args.keepEvents && args.provenance !== 'sourced' && (!args.source || !args.detail)) { console.error('source= and detail= are required — provenance is what "verified" means. (keepEvents=1 reuses existing provenance.)'); process.exit(1); }

const j = JSON.parse(readFileSync('unlocks.json', 'utf8'));
let idx = j.tokens.findIndex((t) => t.sym === sym.toUpperCase());
// SOURCED path: provenance=sourced source=defillama — the row is constructed from
// data/unlock-index.json (the named source's own file, dated), same-day events
// merged, chain taken from the token prefix or data/chain-resolution.json, else
// 'unconfirmed'. REFUSED without a source name; the fetch timestamp comes from the
// index file itself so it cannot be typed.
if (args.provenance === 'sourced') {
  if (!args.source) { console.error('provenance=sourced requires source=<name> — a sourced row without a named source is an estimate wearing a label.'); process.exit(1); }
  const indexFile = JSON.parse(readFileSync('data/unlock-index.json', 'utf8'));
  const p = indexFile.protocols.find((x) => x.symbol === sym.toUpperCase());
  if (!p) { console.error(`${sym} is not in data/unlock-index.json — refresh the index (node fetch-unlock-index.js) or add it there first.`); process.exit(1); }
  const byDay = {};
  for (const e of p.events) { const d = new Date(e.t * 1000).toISOString().slice(0, 10); const k = d + '|' + e.type; if (!byDay[k]) byDay[k] = { ...e, cats: new Set(String(e.cats).split('+')) }; else { byDay[k].n += e.n; String(e.cats).split('+').forEach((c) => byDay[k].cats.add(c)); } }
  const sourceEvents = Object.values(byDay).sort((a, b) => a.t - b.t).map((e) => ({ t: e.t, type: e.type, n: Math.round(e.n), cats: [...e.cats].join('+'), ...(e.rd ? { rd: e.rd } : {}) }));
  let chain = 'unconfirmed', token = null;
  if (p.token && !p.token.startsWith('coingecko:')) { chain = p.token.split(':')[0]; token = p.token; }
  else if (existsSync('data/chain-resolution.json')) {
    const res = JSON.parse(readFileSync('data/chain-resolution.json', 'utf8'))[sym.toUpperCase()];
    if (res?.asset_platform_id) { chain = res.asset_platform_id === 'binance-smart-chain' ? 'bsc' : res.asset_platform_id; const a = res.platforms?.[res.asset_platform_id]; if (a) token = `${chain}:${a}`; }
  }
  const { sourceRow } = await import('./src/core/unlock-promote.js');
  const row = sourceRow(j.tokens[idx] ?? { sym: sym.toUpperCase(), name: args.name ?? p.name }, {
    source: args.source, sourceFetchedAt: indexFile.fetchedAt, sourceEvents, chain, token,
    stage: args.stage ?? 'STANDARD', note: args.note ?? `Sourced from ${args.source}'s unlock schedule; ${sourceEvents.filter((e) => e.t * 1000 > Date.now()).length} upcoming batch events at ingest. Not independently verified.`,
    circSupply: p.circSupply ?? null, totalLocked: p.totalLocked ?? null, maxSupply: p.maxSupply ?? null,
  });
  if (idx < 0) j.tokens.push(row); else j.tokens[idx] = row;
  j.lastReviewed = new Date().toISOString().slice(0, 10) + ` (sourced ${row.sym} via promote-unlock.js)`;
  writeFileSync('unlocks.json.tmp', JSON.stringify(j, null, 1));
  renameSync('unlocks.json.tmp', 'unlocks.json');
  console.log(`${row.sym} SOURCED (${args.source}, ${sourceEvents.length} batch events, chain ${chain}, stage ${row.stage}).`);
  process.exit(0);
}

// A token discovered by the scan has no row yet. The identity row (sym + name) is
// constructed HERE, through the one sanctioned path, so promotion still never
// hand-edits unlocks.json. name= is required for a new row: identity is explicit.
if (idx < 0) {
  if (!args.name) { console.error(`${sym} not in unlocks.json — pass name="..." to create its identity row through this path (never hand-edit).`); process.exit(1); }
  j.tokens.push({ sym: sym.toUpperCase(), name: args.name });
  idx = j.tokens.length - 1;
  console.log(`identity row created for ${sym.toUpperCase()} (${args.name})`);
}

const eventDate = args.date ?? null;
// onchain-cadence promotions must carry the machine-checkable spec that lets
// cadence-watch.js demote them automatically — promoteRow refuses them without it:
//   wallet=0x... expectDay=6 meanAmount=12069436 monthsObserved=13 [roll=nextBusinessDay] [monthEnd=1] [graceDays=3]
// FAMILY spec: wallets=0xaaa:7822556,0xbbb:1364336 (ref:mean pairs, refs resolved
// against report files exactly like single wallets). Use this whenever the message
// claims a family total — the falsifier must cover what the alert asserts.
// tolerance=auto derives the band from the ROW'S OWN observed history (3x MAD),
// because a global constant fits whichever row it was written for. Ratios come from
// the cadence report's emission series, summed per month across the watched wallets.
function autoTolerance(sym, walletAddrs, mean) {
  const rep = JSON.parse(readFileSync('data/cadence-report.json', 'utf8'))[sym];
  const watched = new Set(walletAddrs.map((a) => a.toLowerCase()));
  const byMonth = {};
  for (const p of rep?.perWallet || []) {
    if (typeof p.solo !== 'object' || !watched.has(p.addr.toLowerCase())) continue;
    for (const e of p.solo.emissions) { const m = e.d.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + e.amt; }
  }
  const ratios = Object.values(byMonth).map((v) => v / mean);
  return deriveTolerance(ratios);
}

const famSpec = args.wallets ? {
  wallets: args.wallets.split(',').map((pair) => {
    const [ref, mean] = pair.split(':');
    return { addr: resolveWalletRef(ref, reportAddresses()), meanAmount: Number(mean) };
  }),
  ...(args.familyMean ? { familyMean: Number(args.familyMean) } : {}),
} : null;
if (famSpec && args.tolerance) {
  if (args.tolerance === 'auto') {
    const mean = famSpec.familyMean ?? famSpec.wallets.reduce((s, w) => s + w.meanAmount, 0);
    const d = autoTolerance(sym.toUpperCase(), famSpec.wallets.map((w) => w.addr), mean);
    famSpec.tolerance = d.tolerance;
    famSpec.toleranceBasis = d.basis;   // the derivation travels with the number
    famSpec.toleranceN = d.n;           // n=11 is visibly weaker evidence than n=30
    famSpec.toleranceAt = new Date().toISOString().slice(0, 10); // STATIC from here:
    // re-derived only by an explicit re-promotion, never by the watch as windows
    // accrue (that would let a drifting schedule widen its own band).
    console.log(`tolerance derived: ±${Math.round(d.tolerance * 100)}% — ${d.basis}`);
  } else famSpec.tolerance = Number(args.tolerance);
}
const alsoObserve = args.alsoObserve ? args.alsoObserve.split(',').map((r) => resolveWalletRef(r, reportAddresses())) : null;
const cadence = famSpec ? {
  ...famSpec,
  ...(args.expectDay ? { expectDay: Number(args.expectDay) } : {}),
  ...(args.monthEnd ? { monthEnd: true, expectDay: Number(args.expectDay ?? 31) } : {}),
  monthsObserved: Number(args.monthsObserved),
  ...(args.roll ? { roll: args.roll } : {}),
  ...(args.graceDays ? { graceDays: Number(args.graceDays) } : {}),
} : args.wallet ? {
  wallet: resolveWalletRef(args.wallet, reportAddresses()),
  ...(args.expectDay ? { expectDay: Number(args.expectDay) } : {}),
  ...(args.monthEnd ? { monthEnd: true, expectDay: Number(args.expectDay ?? 31) } : {}),
  meanAmount: Number(args.meanAmount),
  monthsObserved: Number(args.monthsObserved),
  ...(args.roll ? { roll: args.roll } : {}),
  ...(args.graceDays ? { graceDays: Number(args.graceDays) } : {}),
} : null;
// Event construction: default REPLACES provenance; addEvent=1 PREPENDS the new event
// (events[0] drives the message's confidence line) keeping history; keepEvents=1
// reuses existing events untouched — for attaching a falsifier (cadence/reviewBy/
// enforcement) without fabricating a new provenance event.
const newEvent = { date: eventDate ?? new Date().toISOString().slice(0, 10), source: args.source, detail: args.detail };
const oldEvents = j.tokens[idx].events ?? [];
const events = args.keepEvents ? oldEvents : args.addEvent ? [newEvent, ...oldEvents] : [newEvent];
const row = promoteRow(j.tokens[idx], {
  monthlyDay: args.monthlyDay ? Number(args.monthlyDay) : null,
  date: eventDate,
  note: args.note ?? j.tokens[idx].note ?? '',
  events,
  cadence,
  enforcement: args.enforcement ?? null,
  reviewBy: args.reviewBy ?? null,
  stage: args.stage ?? null,
  alsoObserve,
});
const dropped = Object.keys(j.tokens[idx]).filter((k) => !(k in row));
j.tokens[idx] = row;
j.lastReviewed = new Date().toISOString().slice(0, 10) + ` (promoted ${row.sym} via promote-unlock.js)`;
writeFileSync('unlocks.json.tmp', JSON.stringify(j, null, 1));
renameSync('unlocks.json.tmp', 'unlocks.json');
console.log(`${row.sym} promoted (constructed, not patched).`);
if (dropped.length) console.log(`estimated-era fields dropped: ${dropped.join(', ')}`);
console.log('Boot assertion will verify no estimated-only fields remain on verified rows.');
