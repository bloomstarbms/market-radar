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
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { promoteRow } from './src/core/unlock-promote.js';

const [sym, ...kvs] = process.argv.slice(2);
if (!sym) {
  console.log('usage: node promote-unlock.js SYM [monthlyDay=N] [date=YYYY-MM-DD] source=... detail="..." [note="..."]');
  process.exit(1);
}
const args = Object.fromEntries(kvs.map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
if (!args.source || !args.detail) { console.error('source= and detail= are required — provenance is what "verified" means.'); process.exit(1); }

const j = JSON.parse(readFileSync('unlocks.json', 'utf8'));
const idx = j.tokens.findIndex((t) => t.sym === sym.toUpperCase());
if (idx < 0) { console.error(`${sym} not in unlocks.json — add the token first, then promote.`); process.exit(1); }

const eventDate = args.date ?? null;
const row = promoteRow(j.tokens[idx], {
  monthlyDay: args.monthlyDay ? Number(args.monthlyDay) : null,
  date: eventDate,
  note: args.note ?? j.tokens[idx].note ?? '',
  events: [{ date: eventDate ?? new Date().toISOString().slice(0, 10), source: args.source, detail: args.detail }],
});
const dropped = Object.keys(j.tokens[idx]).filter((k) => !(k in row));
j.tokens[idx] = row;
j.lastReviewed = new Date().toISOString().slice(0, 10) + ` (promoted ${row.sym} via promote-unlock.js)`;
writeFileSync('unlocks.json.tmp', JSON.stringify(j, null, 1));
renameSync('unlocks.json.tmp', 'unlocks.json');
console.log(`${row.sym} promoted (constructed, not patched).`);
if (dropped.length) console.log(`estimated-era fields dropped: ${dropped.join(', ')}`);
console.log('Boot assertion will verify no estimated-only fields remain on verified rows.');
