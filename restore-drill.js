// RESTORE DRILL — proves the newest backup is actually restorable, then STAMPS ITSELF.
//
// A backup that has never been restored is a BELIEF, not a safeguard, and the moment
// you discover otherwise is a recovery. The heartbeat reports `restore-verified Nd
// ago`; that number must be EARNED, not remembered — a hand-set timestamp gets set
// once and decays into a stale reassurance that says "verified" about August. So this
// script writes the timestamp itself, only on success.
//
//   node restore-drill.js
//
// SAFETY: operates entirely on COPIES in a temp dir. It never writes to data/ except
// the drill stamp, and the stamp lives in its OWN file (data/restore-drill.json)
// rather than state.json — a separate process writing state.json would be clobbered
// by the running bot's next save (the lost-update class fixed in v0.17).
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DATA = join(process.cwd(), 'data');
const BACKUPS = join(DATA, 'backups');
const STAMP = join(DATA, 'restore-drill.json');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
  return cond;
};

if (!existsSync(BACKUPS)) { console.error('FAIL: no backups directory — nothing to drill.'); process.exit(1); }

const newestOf = (prefix) => readdirSync(BACKUPS).filter((f) => f.startsWith(prefix)).sort().pop();
const oc = newestOf('outcomes-'), stf = newestOf('state-');
console.log(`Restore drill · newest snapshots: ${oc || 'NONE'} / ${stf || 'NONE'}\n`);
if (!oc || !stf) { console.error('FAIL: missing an outcomes or state snapshot.'); process.exit(1); }

// Restore into a scratch dir, exactly as a real recovery would.
const tmp = mkdtempSync(join(tmpdir(), 'radar-restore-'));
copyFileSync(join(BACKUPS, oc), join(tmp, 'outcomes.json'));
copyFileSync(join(BACKUPS, stf), join(tmp, 'state.json'));

console.log('1. snapshots parse and carry the expected shape');
let rows, st;
try { rows = JSON.parse(readFileSync(join(tmp, 'outcomes.json'), 'utf8')); } catch (e) { rows = null; }
try { st = JSON.parse(readFileSync(join(tmp, 'state.json'), 'utf8')); } catch (e) { st = null; }
check('outcomes snapshot parses as an array', Array.isArray(rows), rows ? `${rows.length} rows` : 'parse failed');
check('state snapshot parses as an object', !!st && typeof st === 'object');
check('rows carry the fields the analyses depend on',
  !!rows?.length && rows.every((r) => r.ts && r.type) && rows.some((r) => 'collectedUnder' in r));
check('state carries the accumulators (adv/universe)', !!st && ('adv' in st || 'universe' in st));

console.log('2. the restored data is usable, not merely parseable');
const day = 86400e3;
const spanD = rows?.length ? (Math.max(...rows.map((r) => r.ts)) - Math.min(...rows.map((r) => r.ts))) / day : 0;
check('history spans more than a day', spanD > 1, `${spanD.toFixed(1)}d`);
const freshest = rows?.length ? (Date.now() - Math.max(...rows.map((r) => r.ts))) / 3600e3 : Infinity;
check('newest row is recent (backup is not stale)', freshest < 48, `${freshest.toFixed(1)}h old`);
const suppressed = rows?.filter((r) => r.suppressed).length ?? 0;
check('suppressed candidates survived the round trip', suppressed > 0, `${suppressed} rows`);

// The check that actually matters, and the standard set by the FIRST hand-run drill:
// not "the file parses" but "the analyses still work off it". A backup can pass every
// structural check above and still be subtly unusable — a field present but empty, a
// schema drift the parser tolerates, rows retained but carrying the wrong
// collectedUnder. Structural checks prove the file LOADS; this proves the SYSTEM RUNS
// on it. Downstream code is executed against the restored rows and its output is
// compared to live.
console.log('3. FUNCTIONAL: downstream analyses run off the restored rows');
const { modulePrecision, moduleExpectancy } = await import('./src/core/budget.js');
const live = JSON.parse(readFileSync(join(DATA, 'outcomes.json'), 'utf8'));
const TOL = 0.02; // multipliers are shrunk + capped; a backup ~1 day behind live moves them slightly

const pRestored = modulePrecision(rows), pLive = modulePrecision(live);
const mods = Object.keys(pLive).filter((m) => pRestored[m] !== undefined);
let worstP = 0, worstPm = '';
for (const m of mods) {
  const d = Math.abs((pRestored[m] ?? 1) - (pLive[m] ?? 1));
  if (d > worstP) { worstP = d; worstPm = m; }
}
check('modulePrecision computes off the backup', mods.length > 0, `${mods.length} modules`);
check(`precision multipliers match live within ${TOL}`, mods.length > 0 && worstP <= TOL,
  `worst drift ${worstP.toFixed(4)}${worstPm ? ' (' + worstPm + ')' : ''}`);

const eRestored = moduleExpectancy(rows), eLive = moduleExpectancy(live);
const eMods = Object.keys(eLive.mult || {}).filter((m) => eRestored.mult?.[m] !== undefined);
let worstE = 0, worstEm = '';
for (const m of eMods) {
  const d = Math.abs(eRestored.mult[m] - eLive.mult[m]);
  if (d > worstE) { worstE = d; worstEm = m; }
}
check('moduleExpectancy computes off the backup', eMods.length > 0, `${eMods.length} modules`);
check(`expectancy multipliers match live within ${TOL}`, eMods.length > 0 && worstE <= TOL,
  `worst drift ${worstE.toFixed(4)}${worstEm ? ' (' + worstEm + ')' : ''}`);

// INDEPENDENCE + REAL TOLERANCE. The newest snapshot can be minutes old, so comparing
// it to live is close to comparing a file to itself: it would return ~0 drift even if
// the restore path silently fell through to the LIVE file, which is the one failure
// this drill most needs to exclude. The OLDEST retained snapshot is the honest test —
// there the drift must be NON-ZERO (proving the numbers came from the archive, not
// from live) and BOUNDED (proving an old backup is still usable, which is what the
// tolerance was written for in the first place).
console.log('4. INDEPENDENCE: oldest retained snapshot produces real, bounded drift');
const oldestOc = readdirSync(BACKUPS).filter((f) => f.startsWith('outcomes-')).sort()[0];
const ageD = (f) => (Date.now() - Date.parse(f.match(/(\d{4}-\d{2}-\d{2})/)[1])) / day;
let oldWorstP = null, oldWorstE = null;
if (!oldestOc || oldestOc === oc) {
  check('more than one retained snapshot to compare', false, 'only one snapshot on disk — independence untested');
} else {
  copyFileSync(join(BACKUPS, oldestOc), join(tmp, 'oldest.json'));
  const oldRows = JSON.parse(readFileSync(join(tmp, 'oldest.json'), 'utf8'));
  check(`oldest snapshot (${oldestOc}, ~${ageD(oldestOc).toFixed(0)}d) is genuinely a different dataset`,
    oldRows.length !== rows.length, `${oldRows.length} vs ${rows.length} rows`);
  const pOld = modulePrecision(oldRows), eOld = moduleExpectancy(oldRows);
  oldWorstP = Math.max(0, ...Object.keys(pLive).filter((m) => pOld[m] !== undefined)
    .map((m) => Math.abs(pOld[m] - pLive[m])));
  oldWorstE = Math.max(0, ...Object.keys(eLive.mult || {}).filter((m) => eOld.mult?.[m] !== undefined)
    .map((m) => Math.abs(eOld.mult[m] - eLive.mult[m])));
  // NON-ZERO is the assertion that matters: identical numbers from a week-old file
  // means something read live data.
  check('drift vs live is NON-ZERO (numbers really came from the archive)',
    oldWorstP > 0 || oldWorstE > 0, `precision ${oldWorstP.toFixed(4)} · expectancy ${oldWorstE.toFixed(4)}`);
  // Clamp range is 0.6-1.4, so 0.8 is the theoretical max; 0.4 means a module's
  // multiplier moved half its whole range in a fortnight, which needs a human.
  check('drift is BOUNDED (an old backup is still usable)',
    oldWorstP < 0.4 && oldWorstE < 0.4, `worst ${Math.max(oldWorstP, oldWorstE).toFixed(4)} of 0.8 possible`);
}

console.log('5. live data untouched by this drill');
const liveBefore = existsSync(join(DATA, 'outcomes.json'));
check('live outcomes.json still present and parseable', liveBefore && (() => {
  try { return Array.isArray(JSON.parse(readFileSync(join(DATA, 'outcomes.json'), 'utf8'))); } catch { return false; }
})());

rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED — backup is NOT proven restorable. Stamp NOT written; the heartbeat will keep flagging this.`);
  process.exit(1);
}
// Deduped sample count per module — the SAME (type, symbol, UTC day) key the
// multipliers use, so n is comparable to the estimator's own denominator. Needed to
// test whether drift decays like 1/sqrt(n); without n the series is uninterpretable.
function samplesPerModule(rs) {
  const seen = new Set(), n = {};
  for (const r of rs) {
    if (r.alpha?.h24 === undefined || r.alpha?.h24 === null) continue;
    const k = r.type + ':' + (r.symbol || r.address || '?') + ':' + new Date(r.ts).toISOString().slice(0, 10);
    if (seen.has(k)) continue;
    seen.add(k);
    n[r.type] = (n[r.type] || 0) + 1;
  }
  return n;
}

const prev = existsSync(STAMP) ? JSON.parse(readFileSync(STAMP, 'utf8')) : null;
// CONVERGENCE SERIES. The week-over-week drift is not just a staleness bound — it
// measures whether the multipliers have SETTLED. With n in the 300s and Beta(10,10)
// shrinkage a stabilising estimate should move well under 0.10/week; if it is still
// swinging that much, a module near the 55 floor flips push/no-push about weekly
// (the quantified form of the 35/48/58 spread the boot diagnostic showed). Step 8's
// conjunction weights INHERIT these multipliers, so unstable multipliers mean
// unstable weights — worth knowing BEFORE step 8 builds on them.
// Expect drift to decay ~1/sqrt(n). Still ~0.10 at n>500 means the estimator is
// misbehaving, not merely young.
const nNow = samplesPerModule(live);
const entry = {
  at: Date.now(),
  gapDays: oldWorstP === null ? null : Number(ageD(oldestOc).toFixed(1)),
  precisionDrift: oldWorstP === null ? null : Number(oldWorstP.toFixed(4)),
  expectancyDrift: oldWorstE === null ? null : Number(oldWorstE.toFixed(4)),
  // per-week rate, so entries with different gaps stay comparable
  precisionDriftPerWeek: oldWorstP === null ? null : Number((oldWorstP / (ageD(oldestOc) / 7)).toFixed(4)),
  n: nNow, nTotal: Object.values(nNow).reduce((a, b) => a + b, 0),
};
const history = [...(prev?.history || []), entry].slice(-60);
writeFileSync(STAMP, JSON.stringify({
  at: Date.now(), snapshots: { outcomes: oc, state: stf },
  rows: rows.length, spanDays: Number(spanD.toFixed(1)),
  // Recorded so a future session can see the drill was FUNCTIONAL, not just structural.
  functional: {
    newest: { ageH: Number(freshest.toFixed(1)), precisionDrift: Number(worstP.toFixed(4)), expectancyDrift: Number(worstE.toFixed(4)), tolerance: TOL },
    // Independence evidence: near-zero here would mean the restore read live data.
    oldest: oldWorstP === null ? null
      : { file: oldestOc, ageD: Number(ageD(oldestOc).toFixed(1)), precisionDrift: Number(oldWorstP.toFixed(4)), expectancyDrift: Number(oldWorstE.toFixed(4)) },
  },
  previousDrill: prev?.at ?? null,
  history,
}, null, 1));

// Report the series so the trend is visible without opening the file.
if (history.length > 1) {
  console.log('\nCONVERGENCE SERIES (drift/week vs deduped n — expect ~1/sqrt(n) decay):');
  for (const h of history.slice(-6)) {
    console.log(`  ${new Date(h.at).toISOString().slice(0, 10)}  drift/wk ${String(h.precisionDriftPerWeek ?? '?').padEnd(7)} · n=${h.nTotal}`);
  }
  const first = history[0], last = history[history.length - 1];
  if (first.nTotal && last.nTotal > first.nTotal && first.precisionDriftPerWeek && last.precisionDriftPerWeek) {
    const expected = first.precisionDriftPerWeek * Math.sqrt(first.nTotal / last.nTotal);
    const verdict = last.precisionDriftPerWeek <= expected * 1.5 ? 'consistent with 1/sqrt(n)' : '⚠️ NOT decaying as expected — estimator may not be converging';
    console.log(`  expected now ~${expected.toFixed(4)} · actual ${last.precisionDriftPerWeek.toFixed(4)} — ${verdict}`);
  }
} else {
  console.log('\nCONVERGENCE SERIES: first data point recorded. Re-run weekly; drift/week should decay ~1/sqrt(n).');
}
console.log(`\nALL CHECKS PASSED — restore verified against ${oc}. Stamp written to data/restore-drill.json.`);
console.log('The heartbeat will now report restore-verified 0d ago; it ages from here, so re-run periodically.');
