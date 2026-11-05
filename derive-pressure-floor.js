// REFRESH CHORE, STEP 7 (NEXT-SESSION.md, "RECURRING CHORE — refresh the unlock index").
// Re-derives the sourced pressure floor from unlocks.json and compares it with the recorded
// SOURCED_PRESSURE_FLOOR in src/core/unlock-promote.js. READ-ONLY. It replaces the inline
// `node -e` the chore used to carry (CLAUDE.md: write the file, run the file).
// Recording stays a hand edit of SOURCED_PRESSURE_FLOOR (value, n, and a basis sentence saying
// why it moved). Fixture 47 fails until the recorded value matches; that is the point of it.
//
//   node derive-pressure-floor.js     exit 0 = unchanged · exit 2 = moved, re-record it
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SOURCED_PRESSURE_FLOOR, derivePressureFloor, pressureStage } from './src/core/unlock-promote.js';

// Pure: the derived floor against the recorded one, the rows sitting nearest it, and every sourced
// row whose pressure stage would flip if the derived value were recorded.
export function floorReport(tokens, recorded = SOURCED_PRESSURE_FLOOR) {
  const d = derivePressureFloor(tokens, recorded.percentile);
  if (!d) return { derived: null, moved: false, flips: [], nearest: [] };
  const moved = d.n !== recorded.n || Math.abs(d.pctOfMaxSupply - recorded.pctOfMaxSupply) >= 0.0005;
  const next = { ...recorded, pctOfMaxSupply: d.pctOfMaxSupply };
  const flips = tokens.filter((t) => t.provenance === 'sourced' && !t.retired)
    .map((t) => ({ sym: t.sym, now: pressureStage(t, recorded), then: pressureStage(t, next) }))
    .filter((x) => x.now !== x.then);
  const nearest = tokens.filter((t) => t.maxSupply && (t.sourceEvents || t.sourceHistory?.sourceEvents)?.length)
    .map((t) => { const ps = (t.sourceEvents || t.sourceHistory.sourceEvents).filter((e) => e.n > 0).map((e) => 100 * e.n / t.maxSupply).sort((a, b) => a - b); return { sym: t.sym, median: +ps[Math.floor(ps.length / 2)].toFixed(4) }; })
    .sort((a, b) => Math.abs(a.median - d.pctOfMaxSupply) - Math.abs(b.median - d.pctOfMaxSupply)).slice(0, 4);
  return { derived: d, moved, flips, nearest };
}

const IS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_CLI) {
  const tokens = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens;
  const r = floorReport(tokens);
  const F = SOURCED_PRESSURE_FLOOR;
  if (!r.derived) { console.error('no sourced row with maxSupply and events — nothing to derive from'); process.exit(1); }
  console.log(`recorded: ${F.pctOfMaxSupply} (p${F.percentile}, n ${F.n})`);
  console.log(`derived:  ${r.derived.pctOfMaxSupply} (p${r.derived.percentile}, n ${r.derived.n})`);
  console.log(`rows nearest the derived floor (median tranche % of max supply): ${r.nearest.map((x) => `${x.sym} ${x.median}`).join(' · ')}`);
  console.log(`stage flips if recorded: ${r.flips.length ? r.flips.map((x) => `${x.sym} ${x.now}->${x.then}`).join(' · ') : 'none'}`);
  if (!r.moved) { console.log('UNCHANGED: nothing to record.'); process.exit(0); }
  console.log(`MOVED: record pctOfMaxSupply ${r.derived.pctOfMaxSupply}, n ${r.derived.n} in SOURCED_PRESSURE_FLOOR (src/core/unlock-promote.js), with a basis sentence saying why. Fixture 47 fails until then.`);
  process.exit(2);
}
