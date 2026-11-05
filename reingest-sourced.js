// REFRESH CHORE, STEP 5 (NEXT-SESSION.md, "RECURRING CHORE — refresh the unlock index").
// Re-ingests every SOURCED row in unlocks.json from data/unlock-index.json through the write path
// (promote-unlock.js provenance=sourced source=defillama), one row at a time. It replaces the
// inline `node -e` loop the chore used to carry (CLAUDE.md: write the file, run the file), and
// builds in the two rules learned 2026-10-01, when a re-ingest rebuilt ORDER, dropped its
// tierHistory, and a six-field diff called it "23 changes, all expected":
//   1. unlocks.json is copied aside first (data/chore/unlocks.pre-<stamp>.json): the way back.
//   2. afterwards every row's KEYS are diffed, not just stages and dates.
//
//   node reingest-sourced.js            every sourced row
//   node reingest-sourced.js SYM ...    only these (each must be sourced)
//
// Exit 1 if any row lost a key or disappeared, or a promote-unlock.js run failed. Stage flips and
// "[OPERATOR] ... index dates MOVED" lines are printed for the operator; they do not fail the run.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Pure: compare two unlocks.json token lists row by row, by KEY. Values are expected to change on
// a re-ingest (sourceEvents, sourceFetchedAt); a key that disappears is the ORDER-class loss.
export function rowKeyDiff(pre, post) {
  const out = { lost: [], added: [], missingRows: [], stageFlips: [], firstEventMoved: [] };
  const by = new Map(post.map((t) => [t.sym, t]));
  for (const a of pre) {
    const b = by.get(a.sym);
    if (!b) { out.missingRows.push(a.sym); continue; }
    const lost = Object.keys(a).filter((k) => !(k in b)), added = Object.keys(b).filter((k) => !(k in a));
    if (lost.length) out.lost.push({ sym: a.sym, keys: lost });
    if (added.length) out.added.push({ sym: a.sym, keys: added });
    if (a.stage !== b.stage) out.stageFlips.push({ sym: a.sym, from: a.stage, to: b.stage });
    const d = (t) => (t.sourceEvents?.[0] ? new Date(t.sourceEvents[0].t * 1000).toISOString().slice(0, 10) : null);
    if (a.provenance === 'sourced' && d(a) !== d(b)) out.firstEventMoved.push({ sym: a.sym, from: d(a), to: d(b) });
  }
  return out;
}

const IS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_CLI) {
  const asked = process.argv.slice(2).map((s) => s.toUpperCase());
  const before = JSON.parse(readFileSync('unlocks.json', 'utf8'));
  const sourced = before.tokens.filter((t) => t.provenance === 'sourced' && !t.retired).map((t) => t.sym);
  const syms = asked.length ? asked : sourced;
  const notSourced = syms.filter((s) => !sourced.includes(s));
  if (notSourced.length) { console.error(`not sourced rows (refused): ${notSourced.join(', ')}`); process.exit(1); }
  if (!existsSync('data/unlock-index.json')) { console.error('data/unlock-index.json missing — build the index first (chore steps 1–4)'); process.exit(1); }
  const ix = JSON.parse(readFileSync('data/unlock-index.json', 'utf8'));
  mkdirSync('data/chore', { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/:/g, '');
  const aside = `data/chore/unlocks.pre-${stamp}.json`;
  writeFileSync(aside, readFileSync('unlocks.json'));
  console.log(`copied aside: ${aside} · index fetchedAt ${ix.fetchedAt} · ${syms.length} rows to re-ingest`);
  const operatorLines = [], failed = [];
  syms.forEach((sym, i) => {
    console.log(`  … ${new Date().toISOString().slice(11, 19)}Z re-ingest ${i + 1}/${syms.length} ${sym}`);
    try {
      const out = execFileSync(process.execPath, ['promote-unlock.js', sym, 'provenance=sourced', 'source=defillama'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (out.trim()) process.stdout.write(out.trimEnd().replace(/^/gm, '      ') + '\n');
      operatorLines.push(...out.split('\n').filter((l) => /\[OPERATOR\]/.test(l)));
    } catch (e) { failed.push(sym); console.log(`      FAILED: ${String(e.stderr || e.message).trim()}`); }
  });
  const after = JSON.parse(readFileSync('unlocks.json', 'utf8'));
  const d = rowKeyDiff(before.tokens, after.tokens);
  console.log(`\nKEY DIFF per row (${before.tokens.length} rows before, ${after.tokens.length} after):`);
  console.log(`  lost keys: ${d.lost.length ? d.lost.map((x) => `${x.sym} [${x.keys.join(', ')}]`).join(' · ') : 'none'}`);
  console.log(`  added keys: ${d.added.length ? d.added.map((x) => `${x.sym} [${x.keys.join(', ')}]`).join(' · ') : 'none'}`);
  console.log(`  missing rows: ${d.missingRows.join(', ') || 'none'}`);
  console.log(`  stage flips: ${d.stageFlips.length ? d.stageFlips.map((x) => `${x.sym} ${x.from}->${x.to}`).join(' · ') : 'none'} (expected ones are fine; an unexpected one is a question for the operator)`);
  console.log(`  first sourced event moved: ${d.firstEventMoved.length ? d.firstEventMoved.map((x) => `${x.sym} ${x.from}->${x.to}`).join(' · ') : 'none'}`);
  if (operatorLines.length) console.log(`\n[OPERATOR] lines (re-run detect-cliff-cluster.js and CHECK its pages before re-stamping):\n${operatorLines.join('\n')}`);
  const bad = d.lost.length || d.missingRows.length || failed.length;
  console.log(bad ? `\nNOT CLEAN: ${failed.length ? `promote-unlock failed for ${failed.join(', ')}; ` : ''}restore with: copy ${aside} over unlocks.json, then find out why` : '\nCLEAN: no row lost a key. Next: node derive-pressure-floor.js (step 7).');
  process.exit(bad ? 1 : 0);
}
