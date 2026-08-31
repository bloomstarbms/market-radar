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
if (!args.keepEvents && (!args.source || !args.detail)) { console.error('source= and detail= are required — provenance is what "verified" means. (keepEvents=1 reuses existing provenance.)'); process.exit(1); }

const j = JSON.parse(readFileSync('unlocks.json', 'utf8'));
const idx = j.tokens.findIndex((t) => t.sym === sym.toUpperCase());
if (idx < 0) { console.error(`${sym} not in unlocks.json — add the token first, then promote.`); process.exit(1); }

const eventDate = args.date ?? null;
// onchain-cadence promotions must carry the machine-checkable spec that lets
// cadence-watch.js demote them automatically — promoteRow refuses them without it:
//   wallet=0x... expectDay=6 meanAmount=12069436 monthsObserved=13 [roll=nextBusinessDay] [monthEnd=1] [graceDays=3]
// FAMILY spec: wallets=0xaaa:7822556,0xbbb:1364336 (ref:mean pairs, refs resolved
// against report files exactly like single wallets). Use this whenever the message
// claims a family total — the falsifier must cover what the alert asserts.
const famSpec = args.wallets ? {
  wallets: args.wallets.split(',').map((pair) => {
    const [ref, mean] = pair.split(':');
    return { addr: resolveWalletRef(ref, reportAddresses()), meanAmount: Number(mean) };
  }),
  ...(args.familyMean ? { familyMean: Number(args.familyMean) } : {}),
  ...(args.tolerance ? { tolerance: Number(args.tolerance) } : {}),
} : null;
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
