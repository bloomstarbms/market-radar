// ANNOTATE-VERDICT — the sanctioned write path for corrections to data/cadence-watch.json.
//
//   node annotate-verdict.js <SYM> <CLIFF-DATE|YYYY-MM> --void --reason "why"
//
// WHY THIS EXISTS. On 2026-09-12 a correction was attempted by hand-editing the state
// file. The edit dropped one closing brace; loadWatchState caught the parse error and
// returned the empty default; every verdict in the file was re-derived from scratch
// and ENA's already-delivered demote DM was sent a second time. Third instance of the
// hazard (regime tags v0.13.1, the outcomes.json tear v0.17, this). promote-unlock.js
// exists so nobody hand-edits unlocks.json; verdicts needed the same thing.
//
// WHAT IT GUARANTEES
//   - refuses to run without a --reason (a correction with no stated reason is
//     indistinguishable from tampering; same discipline as clusterSpec.basis)
//   - the ORIGINAL verdict is APPENDED to data/verdict-annotations.json before
//     anything is removed — a correction is recorded AS a correction, never as an
//     absence
//   - the new state is round-tripped through JSON.parse BEFORE it touches the live
//     path (the outcomes.js discipline), then renamed atomically
//   - it RE-READS after writing and reports loudly if the poller raced it, because
//     this file is rewritten every cycle and a lost correction must not look applied
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadWatchState } from './src/sources/calendar/cadence-watch.js';

const STATE = 'data/cadence-watch.json';
const LOG = 'data/verdict-annotations.json';

// PURE CORE, exported so the guarantees above are fixture-checkable without a CLI,
// a temp state file, or a network. Returns either { error } or the new state plus the
// audit entry to append. It NEVER mutates the state it is given.
export function voidVerdict(state, sym, key, reason) {
  if (!sym || !key) return { error: 'sym and key are required' };
  if (!reason || reason.trim().length < 20) return { error: 'a correction without a stated reason is tampering with extra steps' };
  const st = JSON.parse(JSON.stringify(state ?? {}));
  const isCliff = /^\d{4}-\d\d-\d\d$/.test(key);
  const cliffKey = `${sym}:${key}`;
  const target = isCliff ? st.cliffs?.[cliffKey] : st.months?.[sym]?.[key];
  if (!target) return { error: `no verdict at ${isCliff ? `cliffs['${cliffKey}']` : `months['${sym}']['${key}']`}` };
  const demotion = st.demotions?.[sym];
  const demotionMatches = !!demotion && (isCliff ? demotion.cliff === key : demotion.month === key);
  if (isCliff) delete st.cliffs[cliffKey]; else delete st.months[sym][key];
  if (demotionMatches) delete st.demotions[sym];
  return {
    state: st,
    entry: { sym, key, op: 'void', reason: reason.trim(), original: target,
      clearedDemotion: demotionMatches ? demotion : null },
    clearedDemotion: demotionMatches,
  };
}

// CLI GUARDED (the lesson detect-cadence.js and discover-vesting.js already learned):
// importing this module must not execute it, or the fixture that tests voidVerdict
// would run the tool against the live state file on every suite run.
const IS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_CLI) {
  const args = process.argv.slice(2);
  const [sym, key] = args.filter((a) => !a.startsWith('--'));
  const flag = (n) => args.includes(`--${n}`);
  const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
  const reason = val('reason');

  if (!sym || !key) { console.error('usage: node annotate-verdict.js <SYM> <CLIFF-DATE|YYYY-MM> --void --reason "why"'); process.exit(2); }
  if (!flag('void')) { console.error('--void is the only operation this path supports today'); process.exit(2); }
  if (!reason || reason.trim().length < 20) {
    console.error('--reason is REQUIRED and must say something (>=20 chars). A correction without a stated reason is tampering with extra steps.');
    process.exit(2);
  }

  const st = loadWatchState();
  const isCliff = /^\d{4}-\d\d-\d\d$/.test(key);
  const cliffKey = `${sym}:${key}`;
  const target = isCliff ? st.cliffs?.[cliffKey] : st.months?.[sym]?.[key];
  if (!target) { console.error(`no verdict found at ${isCliff ? `cliffs['${cliffKey}']` : `months['${sym}']['${key}']`} — nothing to void`); process.exit(2); }

  const res = voidVerdict(st, sym, key, reason);
  if (res.error) { console.error(res.error); process.exit(2); }

  // 1. RECORD FIRST. The evidence is written before the state is touched, so a crash
  //    between the two loses the correction, never the original.
  const log = existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf8')) : { annotations: [] };
  log.annotations.push({ at: new Date().toISOString().slice(0, 16), ...res.entry,
    note: 'The stamp was CLEARED so the window can be scored again — a voided verdict that stays stamped is never re-evaluated (due filters on !st.cliffs[key]).' });
  writeFileSync(LOG + '.tmp', JSON.stringify(log, null, 1));
  renameSync(LOG + '.tmp', LOG);

  // 2. VALIDATE BEFORE IT TOUCHES THE LIVE PATH.
  const demotionMatches = res.clearedDemotion;
  const out = JSON.stringify(res.state, null, 1);
  try { JSON.parse(out); } catch (e) { console.error('[OPERATOR] refusing to write: the state this produced does not parse —', e.message); process.exit(2); }
  writeFileSync(STATE + '.tmp', out);
  renameSync(STATE + '.tmp', STATE);

  // 4. RE-READ. The poller rewrites this file every cycle; a correction it overwrote
  //    must not be reported as applied.
  const after = loadWatchState();
  const stillThere = isCliff ? after.cliffs?.[cliffKey] : after.months?.[sym]?.[key];
  if (stillThere) {
    console.error(`[OPERATOR] the annotation did NOT survive — the poller rewrote ${STATE} between read and write. Stop the bot and re-run. The audit entry in ${LOG} stands and is NOT duplicated on retry.`);
    process.exit(1);
  }
  console.log(`${sym} ${key}: verdict VOIDED and its stamp cleared${demotionMatches ? ', demotion removed' : ''}.`);
  console.log(`  original: ${JSON.stringify(target)}`);
  console.log(`  recorded in ${LOG} (${log.annotations.length} annotation(s) total)`);
  console.log('  the window is now re-scorable; the next poll will fetch it properly.');
}
