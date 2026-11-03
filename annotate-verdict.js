// ANNOTATE-VERDICT — the sanctioned write path for corrections to data/cadence-watch.json.
//
//   node annotate-verdict.js <SYM> <CLIFF-DATE|YYYY-MM> --void --reason "why"
//   node annotate-verdict.js <SYM> <YYYY-MM> --exclude [--kind catch-up] --reason "why"
//   node annotate-verdict.js <SYM> <YYYY-MM> --rescore --reason "why"
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

// --exclude (2026-11-03): the verdict STANDS and stays stamped — the schedule paid on its
// day — but it is marked outside the statistics (drift, the spec mean, the tolerance band).
// For a real emission that is not the schedule's level: ENA's October window, where eleven
// regular recipients got exactly 18x their month. Not a void: nothing is re-scored.
export function excludeVerdict(state, sym, key, reason, kind = 'catch-up', at = new Date().toISOString().slice(0, 16)) {
  if (!sym || !/^\d{4}-\d\d$/.test(key || '')) return { error: 'exclude applies to a cadence month (SYM YYYY-MM)' };
  if (!reason || reason.trim().length < 20) return { error: 'a correction without a stated reason is tampering with extra steps' };
  const st = JSON.parse(JSON.stringify(state ?? {}));
  const target = st.months?.[sym]?.[key];
  if (!target) return { error: `no verdict at months['${sym}']['${key}']` };
  if (target.action !== 'CONFIRM') return { error: `months['${sym}']['${key}'] is ${target.action}: only a CONFIRM can be excluded from the mean (a miss is not a level to leave out)` };
  if (target.excluded) return { error: `months['${sym}']['${key}'] is already excluded (${target.excluded.kind}, ${target.excluded.at})` };
  st.months[sym][key] = { ...target, excluded: { kind, reason: reason.trim(), at } };
  return { state: st, entry: { sym, key, op: 'exclude', kind, reason: reason.trim(), original: target } };
}

// --rescore (2026-11-03): the window is scored again by the watch's own code (scoreWindow)
// under the current rule, and the stamp is REPLACED, keeping what the operator or the
// delivery path put on it (notified, excluded). The original goes to the log first. A
// re-score that would change the ACTION is refused: that is a different verdict, and the
// path for it is --void (the watch re-scores a cleared stamp and announces the result).
export function rescoreVerdict(state, sym, key, dec, reason, at = new Date().toISOString().slice(0, 16)) {
  if (!sym || !/^\d{4}-\d\d$/.test(key || '')) return { error: 'rescore applies to a cadence month (SYM YYYY-MM)' };
  if (!reason || reason.trim().length < 20) return { error: 'a correction without a stated reason is tampering with extra steps' };
  const st = JSON.parse(JSON.stringify(state ?? {}));
  const target = st.months?.[sym]?.[key];
  if (!target) return { error: `no verdict at months['${sym}']['${key}']` };
  if (!dec || !dec.action || dec.action === 'PENDING') return { error: 'no decision to record (window not scoreable)' };
  if (dec.action !== target.action) return { error: `re-score changes the verdict ${target.action} -> ${dec.action}: void it instead and let the watch re-score and announce` };
  const keep = {};
  for (const k of ['notified', 'excluded']) if (target[k] !== undefined) keep[k] = target[k];
  st.months[sym][key] = { ...dec, at: target.at, ...keep, rescored: { at, reason: reason.trim() } };
  return { state: st, entry: { sym, key, op: 'rescore', reason: reason.trim(), original: target, rescored: dec } };
}

// CLI GUARDED (the lesson detect-cadence.js and discover-vesting.js already learned):
// importing this module must not execute it, or the fixture that tests voidVerdict
// would run the tool against the live state file on every suite run.
const IS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_CLI) {
  const args = process.argv.slice(2);
  const positional = args.filter((a, i) => !a.startsWith('--') && !['--reason', '--kind'].includes(args[i - 1]));
  const [sym, key] = positional;
  const flag = (n) => args.includes(`--${n}`);
  const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
  const reason = val('reason');
  const ops = ['void', 'exclude', 'rescore'].filter(flag);

  if (!sym || !key || ops.length !== 1) {
    console.error('usage: node annotate-verdict.js <SYM> <CLIFF-DATE|YYYY-MM> --void|--exclude [--kind catch-up]|--rescore --reason "why"  (exactly one operation)');
    process.exit(2);
  }
  const op = ops[0];
  if (!reason || reason.trim().length < 20) {
    console.error('--reason is REQUIRED and must say something (>=20 chars). A correction without a stated reason is tampering with extra steps.');
    process.exit(2);
  }

  const st = loadWatchState();
  const isCliff = /^\d{4}-\d\d-\d\d$/.test(key);
  const cliffKey = `${sym}:${key}`;
  const target = isCliff ? st.cliffs?.[cliffKey] : st.months?.[sym]?.[key];
  if (!target) { console.error(`no verdict found at ${isCliff ? `cliffs['${cliffKey}']` : `months['${sym}']['${key}']`} — nothing to ${op}`); process.exit(2); }

  let res;
  if (op === 'void') res = voidVerdict(st, sym, key, reason);
  else if (op === 'exclude') res = excludeVerdict(st, sym, key, reason, val('kind') || 'catch-up');
  else {
    // The re-score is made by the watch's own fetch and decision, under the rule in force now.
    const row = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens.find((t) => t.sym === sym);
    if (!row?.cadence) { console.error(`${sym}: no cadence spec on the row — nothing to re-score against`); process.exit(2); }
    const { scoreWindow } = await import('./src/sources/calendar/cadence-watch.js');
    const [y, m] = key.split('-').map(Number);
    const scored = await scoreWindow(row, y, m, new Date());
    if (!scored.dec) { console.error(`${sym} ${key}: ${scored.pending ? `window not scoreable until ${scored.pending.scoreAt}` : `fetch for ${scored.unobserved} did not reach the window`} — not evidence, nothing recorded`); process.exit(2); }
    res = rescoreVerdict(st, sym, key, scored.dec, reason);
  }
  if (res.error) { console.error(res.error); process.exit(2); }

  // 1. RECORD FIRST. The evidence is written before the state is touched, so a crash
  //    between the two loses the correction, never the original.
  const NOTES = {
    void: 'The stamp was CLEARED so the window can be scored again — a voided verdict that stays stamped is never re-evaluated (due filters on !st.cliffs[key]).',
    exclude: 'The verdict STANDS and stays stamped; it is marked outside drift, the spec mean and the tolerance band.',
    rescore: 'The stamp was REPLACED by a re-score under the current rule; notified/excluded carried; original above.',
  };
  const log = existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf8')) : { annotations: [] };
  log.annotations.push({ at: new Date().toISOString().slice(0, 16), ...res.entry, note: NOTES[op] });
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
  const now = isCliff ? after.cliffs?.[cliffKey] : after.months?.[sym]?.[key];
  const survived = op === 'void' ? !now : op === 'exclude' ? !!now?.excluded : !!now?.rescored;
  if (!survived) {
    console.error(`[OPERATOR] the annotation did NOT survive — the poller rewrote ${STATE} between read and write. Stop the bot and re-run. The audit entry in ${LOG} stands and is NOT duplicated on retry.`);
    process.exit(1);
  }
  if (op === 'void') console.log(`${sym} ${key}: verdict VOIDED and its stamp cleared${demotionMatches ? ', demotion removed' : ''}.`);
  if (op === 'exclude') console.log(`${sym} ${key}: verdict kept, EXCLUDED from the mean (${now.excluded.kind}).`);
  if (op === 'rescore') console.log(`${sym} ${key}: RE-SCORED under the current rule: ${JSON.stringify(res.entry.rescored)}`);
  console.log(`  original: ${JSON.stringify(target)}`);
  console.log(`  recorded in ${LOG} (${log.annotations.length} annotation(s) total)`);
  if (op === 'void') console.log('  the window is now re-scorable; the next poll will fetch it properly.');
}
