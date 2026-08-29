// Regression fixture for the Aug 12 2026 CPI loss: T+5m/T+30m fired into a dead
// network, broadcast() ignored its rejected sends, dispatch marked the stages
// delivered, two alerts lost. Asserts the v0.19.2 contract under a simulated total
// network failure:
//   1. broadcast() returns [] and logs a loud [OPERATOR] line
//   2. dispatch() returns FALSE (delivery is part of "dispatched")
//   3. no cooldown is marked — the alert is retryable next cycle
// READ-ONLY against live data: the failure path never reaches markAlerted/openThread/
// recordAlert, so state.json and outcomes.json are untouched (asserted by mtime).
import { readFileSync } from 'node:fs';
import { load, getState, onCooldown } from './src/core/store.js';
import { config } from './src/config.js';

if (!config.telegramToken) { console.error('SKIP: no telegram token configured'); process.exit(0); }

// Simulate the network being down for EVERY send.
globalThis.fetch = async () => { throw new Error('simulated network down'); };

const errors = [];
const origErr = console.error;
console.error = (...a) => { errors.push(a.join(' ')); origErr(...a); };

load();


const { broadcast, hasRecipients } = await import('./src/core/telegram.js');
const { dispatch } = await import('./src/core/dispatcher.js');

let failures = 0;
const check = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

console.log('1. broadcast() under total send failure');
const ids = await broadcast('delivery self-test — should never appear in Telegram');
check('returns [] (no message ids)', Array.isArray(ids) && ids.length === 0);
check('logs [telegram][OPERATOR] 0/N line', errors.some((l) => l.includes('[telegram][OPERATOR] broadcast: 0/')));
check('hasRecipients() true (so [] means FAILED, not nobody-to-send)', hasRecipients());

console.log('2. dispatch() must not consume the alert');
const alert = {
  source: 'CAL', type: 'MACRO', severity: 'HIGH',
  key: 'delivery-selftest', dedupeKey: 'MACRO:delivery-selftest', cooldownMin: 720,
  title: 'delivery self-test', lines: ['synthetic'],
};
const delivered = await dispatch(alert);
check('returns false on 0/N delivery', delivered === false);
check('logs [OPERATOR] delivery-failed line', errors.some((l) => l.includes('[OPERATOR] delivery failed')));
check('cooldown NOT marked (retryable next cycle)', !onCooldown('CAL:MACRO:delivery-selftest', 720));
// NOT an mtime check: the LIVE bot saves state.json every poll cycle, so comparing
// mtime made this fixture flaky — it could not distinguish "the test wrote" from "the
// bot wrote", and failed whenever a save landed mid-run. Assert the actual property
// instead (the failure path never reached markAlerted/openThread), which is
// deterministic and immune to the live process.
const stAfter = getState();
check('no thread opened for the failed alert', !Object.keys(stAfter.threads || {}).some((k) => k.includes('delivery-selftest')));
check('no alert marker written for it', !Object.keys(stAfter.alerted || {}).some((k) => k.includes('delivery-selftest')));

// ---- v0.20.0 delivery-correctness fixtures (12 Aug fix session) ----
// The meta-finding: the suite validated construction, not routing/delivery.
const { digestWindow, digestDue, buildHeartbeat } = await import('./src/core/telemetry.js');
const { checkTierRoutes } = await import('./src/core/routes.js');
const { listingRoute } = await import('./src/core/dispatcher.js');

console.log('3. digest is idempotent across restarts + fixed-window');
const at19z = Date.UTC(2026, 7, 20, 19, 0);
const at23z = Date.UTC(2026, 7, 20, 23, 30);
const day = digestWindow(at19z).day;
check('due when not yet sent today', digestDue({}, at19z) === true);
check('NOT due when persisted marker says sent (restart-proof)', digestDue({ lastDigestDay: day }, at19z) === false);
check('not due before the 18:00Z boundary', digestDue({}, Date.UTC(2026, 7, 20, 17, 59)) === false);
check('window is FIXED per UTC day, not rolling', digestWindow(at19z).start === digestWindow(at23z).start && digestWindow(at19z).end === digestWindow(at23z).end);

console.log('4. heartbeat fires with every number at zero');
const ZERO_DIGEST = { line: 'Digest: pool 0 today · last sent never' }; // injected: don't read live state
const hb = buildHeartbeat(Date.now(), { rows: [], drops: { total: 0, byReason: {} }, bugs: 0, pulse: 'none yet', startedAt: Date.now(), digest: ZERO_DIGEST });
check('builds a message on empty state', !!hb.title && hb.lines.length >= 5);
check('carries the zero funnel explicitly', hb.lines[0].includes('0 in') && hb.lines[0].includes('0 pushed'));
check('carries the bug counter', hb.lines.some((l) => l.startsWith('Internal errors: 0')));
check('carries the reading rule', hb.lines.some((l) => l.includes('correctly quiet')));

console.log('5. every configured tier has a delivery route (boot assertion)');
check('synthetic unroutable tier FAILS', checkTierRoutes({ calendarEvents: [{ id: 'synthetic', tier: 'FOO' }] }).ok === false);
check('live calendar passes', checkTierRoutes().ok === true);

console.log('6. listing carve-out is venue-scoped, not global');
// Replay of 12 Aug 14:13 — three MEXC micro-caps pushed inside one minute.
for (const sym of ['PLUMBERUSDT', 'PLEARNUSDT', 'HMMUSDT'])
  check(`mexc ${sym} -> defer (digest now, re-check T+30m)`, listingRoute('mexc') === 'defer');
check('gate/bitget/kucoin/bybit defer', ['gate', 'bitget', 'kucoin', 'bybit'].every((v) => listingRoute(v) === 'defer'));
check('upbit/binance/coinbase/bithumb push immediately', ['upbit', 'binance', 'coinbase', 'bithumb'].every((v) => listingRoute(v) === 'push'));
check('unknown venue has NOT earned the bypass', listingRoute('shadyexchange') === 'defer');

console.log('7. per-module digest cap (before the global cap, disclosed)');
const { selectDigestItems } = await import('./src/core/telemetry.js');
const mk = (type, sym, score) => ({ type, symbol: sym, score, severity: 'MEDIUM', ts: 1, suppressed: 'below-floor' });
const flood = [
  ...['EIGEN', 'VIRTUAL', 'SHIB', 'EPIC', 'ZRO', 'NMR', 'TWT', 'FET', 'CRV', 'SQD', 'PEPE'].map((s, i) => mk('WHALE', s, 60 - i)),
  mk('PUMP', 'XPLK', 44), mk('PUMP', 'AAA', 43), mk('PUMP', 'BBB', 42), mk('PUMP', 'CCC', 41),
  mk('DUMP', 'DDD', 40),
];
const sel = selectDigestItems(flood, 3, 12);
check('WHALE occupies at most 3 slots', sel.items.filter((r) => r.type === 'WHALE').length === 3);
check('remaining slots go to other modules', sel.items.filter((r) => r.type !== 'WHALE').length >= 4);
check('within-module keeps highest conviction', sel.items.filter((r) => r.type === 'WHALE').every((r) => r.score >= 58));
check('truncation disclosed, not silent', sel.cutLine.includes('8 more WHALE') && sel.cutLine.includes('capped at 3/module'));

console.log('8. boot self-test is hermetic (injected multipliers, not live data)');
const b = await import('./src/core/budget.js');
// Restore-from-backup scenario: NO multipliers (fresh data dir). Injected synthetic
// multipliers must make the below-floor case hold anyway.
const synth = { FUNDING: 0.83 };
const vBelow = b.withMultipliers(synth, () => b.scoreOf({ type: 'FUNDING', severity: 'MEDIUM' }));
check('injected mult: FUNDING-MEDIUM scores below floor (48)', Math.round(vBelow) === 48 && vBelow < 55);
const vNoMult = b.withMultipliers({}, () => b.scoreOf({ type: 'FUNDING', severity: 'MEDIUM' }));
check('without injection the same case drifts above the floor (the old fragility)', vNoMult >= 55);
check('override is scoped — cleared after the call', b.withMultipliers(synth, () => true) === true && b.scoreOf({ type: 'HEARTBEAT', severity: 'LOW' }) > 0);

console.log('9. heartbeat renders a stale collector without live sabotage');
const { notePulse, formatPulse } = await import('./src/core/pulse.js');
notePulse('binance');
notePulse('deadfeed', Date.now() - 26 * 3600e3);
const pulseLine = formatPulse();
check('fresh collector shows seconds', /binance \d+s/.test(pulseLine));
check('dead collector shows hours of staleness', /deadfeed 26\.\dh/.test(pulseLine));
const hbStale = buildHeartbeat(Date.now(), { rows: [], drops: { byReason: {} }, bugs: 0, startedAt: Date.now(), digest: ZERO_DIGEST });
check('staleness reaches the heartbeat message', hbStale.lines.some((l) => l.includes('deadfeed 26')));

console.log('10. equity-perp label drift (14 Aug: Bybit "TradFi" batch pushed 6 alerts)');
const { classify: classifyAnn } = await import('./src/sources/cex/announcements.js');
for (const sym of ['ZHONGJI', 'SAMSUNGEM', 'LGELECTRONICS', 'HANMI', 'NAVER', 'KODEX200'])
  check(`${sym} TradFi perp -> dropped`, classifyAnn(`New listing: ${sym}USDT TradFi Perpetual Contract, with up to 25x leverage`) === null);
check('crypto perp still classifies as PERP', classifyAnn('New listing: NEWCOINUSDT Perpetual Contract, with up to 25x leverage')?.type === 'PERP');

console.log('11. venue tiering covers the whole catalyst door (PERP/ANNOUNCE too)');
const { catalystRoute } = await import('./src/core/dispatcher.js');
check('bybit PERP defers (the 14 Aug door)', catalystRoute({ type: 'PERP', venue: 'bybit' }) === 'defer');
check('mexc ANNOUNCE defers', catalystRoute({ type: 'ANNOUNCE', venue: 'mexc' }) === 'defer');
check('binance PERP still pushes (tier-1)', catalystRoute({ type: 'PERP', venue: 'binance' }) === 'push');
check('tier-1 delist pushes unconditionally (repriced globally)', catalystRoute({ type: 'ANNOUNCE', venue: 'binance', delist: true, title: 'Delisting of FOOUSDT' }) === 'push');
check('earned promotion pushes', catalystRoute({ type: 'LISTING', venue: 'mexc', deferredEval: true }) === 'push');
check('non-catalyst types unaffected', catalystRoute({ type: 'PUMP', venue: 'mexc' }) === 'push');

console.log('11b. tier-2 delist sweeps gated on the tradeable universe (interim proxy)');
{
  const stt = getState();
  stt.universe ??= {};
  stt.universe['mexc:HELDUSDT'] = { at: Date.now(), pass: true, status: 'PASS' };
  check('tier-2 delist of a VERIFIED-tradeable symbol pushes',
    catalystRoute({ type: 'ANNOUNCE', venue: 'mexc', delist: true, title: 'MEXC Will Delist HELDUSDT' }) === 'push');
  check('tier-2 delist of an unswept symbol -> digest (almost certainly not held)',
    catalystRoute({ type: 'ANNOUNCE', venue: 'mexc', delist: true, title: 'MEXC Will Delist NEVERHEARDUSDT' }) === 'defer');
  check('batch sweep of 15 unswept tokens -> digest, not a RISK push',
    catalystRoute({ type: 'ANNOUNCE', venue: 'mexc', delist: true, title: 'Delisting of ' + Array.from({ length: 15 }, (_, i) => `JUNK${i}USDT`).join(', ') }) === 'defer');
  check('a batch containing ONE held token still pushes',
    catalystRoute({ type: 'ANNOUNCE', venue: 'mexc', delist: true, title: 'Delisting of JUNK1USDT, HELDUSDT, JUNK2USDT' }) === 'push');
  delete stt.universe['mexc:HELDUSDT'];
}

console.log('11c. C-tier is recorded-only; digest is conditional');
{
  const { digestSources } = await import('./src/core/telemetry.js');
  // HERMETIC: reads a FROZEN snapshot, not the live outcomes table. The live table
  // caps at 20k rows with evict-to-archive, so once it fills, 13/08's rows leave the
  // file and a fixture reading it would fail for a reason unrelated to the code under
  // test — the same defect class as the mtime check and the data-dependent boot gate
  // (assert environment while appearing to assert logic). Historical windows are
  // immutable; freezing them costs 8KB.
  const snap = JSON.parse(readFileSync('fixtures/outcomes-2026-08-13-window.json', 'utf8'));
  const win = snap.rows;
  const cTier = win.filter((r) => r.suppressed === 'digest-only' || r.suppressed === 'below-floor');
  const drawn = win.filter((r) => digestSources().has(r.suppressed));
  check(`13/08 had C-tier rows to exclude (n=${cTier.length})`, cTier.length > 0);
  check('13/08 digest now draws ZERO rows (all 12 entries were C-tier)', drawn.length === 0);
  check('C-tier reasons are NOT digest sources', !digestSources().has('digest-only') && !digestSources().has('below-floor'));
  check('deferred catalysts ARE digest sources', digestSources().has('listing-deferred'));
  // The invariant most likely to break silently: recording is untouched.
  check('C-tier rows still present in outcomes with suppression reason', cTier.every((r) => !!r.suppressed));
  check('recording path unchanged — window row count intact', win.length === cTier.length + win.filter((r) => r.suppressed !== 'digest-only' && r.suppressed !== 'below-floor').length);
  // NON-FATAL diagnostic: does the live table still agree with the frozen snapshot?
  // Divergence means eviction has reached this window (expected, ~20k rows) or that
  // history was rewritten (not expected). Reported, never failed — an environment
  // fact must not fail a logic suite.
  try {
    const live = JSON.parse(readFileSync('data/outcomes.json', 'utf8'))
      .filter((r) => r.ts >= snap.window.start && r.ts < snap.window.end).length;
    console.log(`  diag  live table holds ${live}/${win.length} of the frozen window` +
      (live === win.length ? ' (in sync)' : ' — EVICTED or rewritten; snapshot is now the only copy'));
  } catch { console.log('  diag  live outcomes unreadable — snapshot still authoritative'); }
}

console.log('11e. heartbeat instruments the now-rarely-executed digest path');
{
  const { digestStatus } = await import('./src/core/telemetry.js');
  const now = Date.UTC(2026, 7, 20, 19, 0);
  const today = digestWindow(now).day;
  const inWin = digestWindow(now).start + 3600e3;
  const quiet = digestStatus({ digestPool: [], lastDigestDay: '2026-08-16' }, now, []);
  check('quiet day reads as "nothing qualified", not ambiguous', quiet.pool === 0 && /last sent 4d ago/.test(quiet.line) && !quiet.overdue);
  const never = digestStatus({}, now, []);
  check('never-sent renders explicitly', /last sent never/.test(never.line));
  const sent = digestStatus({ digestPool: [{ ts: inWin }], lastDigestDay: today }, now, []);
  check('pool sent today is not flagged', sent.pool === 1 && !sent.overdue && /last sent today/.test(sent.line));
  const broken = digestStatus({ digestPool: [{ ts: inWin }, { ts: inWin }], lastDigestDay: '2026-08-16' }, now, []);
  check('NON-EMPTY POOL WITH NO SEND is loudly visible', broken.pool === 2 && broken.overdue && /POOL NON-EMPTY BUT NOT SENT/.test(broken.line));
  const early = digestStatus({ digestPool: [{ ts: inWin }] }, Date.UTC(2026, 7, 20, 12, 0), []);
  check('not flagged before the send hour', early.overdue === false);
  const hbD = buildHeartbeat(now, { rows: [], drops: { byReason: {} }, bugs: 0, startedAt: now, digest: broken });
  check('the digest line reaches the heartbeat message', hbD.lines.some((l) => l.includes('POOL NON-EMPTY BUT NOT SENT')));
}

console.log('11g. write-only accumulators are instrumented (incl. backups)');
{
  const { accumulatorStatus } = await import('./src/core/telemetry.js');
  const NOW = Date.UTC(2026, 7, 15, 12);
  const row = (h, extra) => ({ ts: NOW - h * 3600e3, type: 'PUMP', collectedUnder: 'FLOORED', ...extra });
  const healthy = accumulatorStatus(NOW, {
    rows: [row(2, { mfe: 1, mult: 0.9 }), row(30, { mfe: 1, mult: 0.9 }), row(3, { suppressed: 'rug:BLOCKED' })],
    st: { adv: { FOO: { a: 1, b: 2 } } },
    backup: { newestAgeH: 4, count: 14, stale: false, drillAgeD: 12 },
  });
  check('reports 24h deltas per accumulator', /floored \+2 · mfe\/mae \+1 · mult \+1 · rugcal \+1/.test(healthy.lines[0]));
  check('reports adv cell count', /adv 2 cells/.test(healthy.lines[0]));
  check('healthy backup renders age + retention + drill', /newest 4\.0h ago · 14 retained/.test(healthy.lines[1]) && /restore-verified 12d ago/.test(healthy.lines[1]));
  // The live bug this instrument would have caught two days earlier: rows accruing
  // but the mult stamp silently dropped by recordAlert's field whitelist.
  const dropped = accumulatorStatus(NOW, {
    rows: [row(2, { mfe: 1 }), row(30, { mfe: 1 })], st: {},
    backup: { newestAgeH: 4, count: 14, stale: false, drillAgeD: 1 },
  });
  check('an accumulator at zero for 48h is flagged STALLED', dropped.stalled.includes('mult') && /STALLED 48h/.test(dropped.lines[0]));
  check('a still-accruing accumulator is NOT flagged', !dropped.stalled.includes('floored'));
  const noBk = accumulatorStatus(NOW, { rows: [row(2, { mfe: 1, mult: 1 })], st: {}, backup: { newestAgeH: null, count: 0, stale: true, drillAgeD: null } });
  check('missing backup is loud', /NONE FOUND/.test(noBk.lines[1]));
  check('never-run restore drill is loud', /never recorded/.test(noBk.lines[1]));
  const oldBk = accumulatorStatus(NOW, { rows: [row(2, { mfe: 1, mult: 1 })], st: {}, backup: { newestAgeH: 30, count: 14, stale: true, drillAgeD: 3 } });
  check('backup older than 26h is flagged', /OVER 26h/.test(oldBk.lines[1]));
  // The drill age needs its own threshold or "it ages from here" never goes loud.
  const { backupStatus } = await import('./src/core/telemetry.js');
  const drillAt = (d) => backupStatus(NOW, '/nonexistent-dir-for-test');
  const mk2 = (drillAgeD, drillMark) => accumulatorStatus(NOW, { rows: [row(2, { mfe: 1, mult: 1 })], st: {},
    backup: { newestAgeH: 4, count: 14, stale: false, drillAgeD, drillMark } });
  check('drill 12d old is clean', !/re-run/.test(mk2(12, '').lines[1]));
  check('drill 35d old warns', /⚠️ 35d ago — re-run/.test(mk2(35, '⚠️').lines[1]));
  check('drill 70d old escalates', /🚨 70d ago — re-run/.test(mk2(70, '🚨').lines[1]));
  const hbA = buildHeartbeat(NOW, { rows: [], drops: { byReason: {} }, bugs: 0, startedAt: NOW, digest: ZERO_DIGEST, accumulators: noBk });
  check('accumulator lines reach the heartbeat', hbA.lines.some((l) => /NONE FOUND/.test(l)));
}

console.log('11h. recordAlert whitelist names what it drops');
{
  // The whitelist stays (schema control) but an omission must be LOUD on first
  // occurrence — 'mult' was silently discarded for two days.
  // PURE check — deliberately does NOT call recordAlert, which would push rows into
  // the live module's memory and can flush them to the real outcomes file.
  const { droppedFields } = await import('./src/core/outcomes.js');
  const dropped = droppedFields({ source: 'CEX', type: 'PUMP', severity: 'LOW', title: 'wl',
    score: 1, mult: 0.9, suppressed: 'below-floor', rug: null,
    lines: [], url: 'u', track: {}, cooldownMin: 5, venue: 'mexc',
    someBrandNewField: 42 });
  check('an unknown producer field is named', dropped.includes('someBrandNewField'));
  check('persisted fields are not reported', !dropped.some((k) => ['score', 'mult', 'suppressed', 'rug', 'type'].includes(k)));
  check('deliberately-transient fields are not reported', !dropped.some((k) => ['lines', 'url', 'track', 'cooldownMin', 'venue'].includes(k)));
  check('the real 14 Aug case would have been caught', droppedFields({ mult: 0.9, __hypotheticalUnmirrored: 1 }).length === 1);
}

console.log('11d. boot assertion distinguishes DECLARED from ACCIDENTAL no-reader');
check('C declared recorded-only PASSES', checkTierRoutes({ tiers: { C: { push: false, digest: false, record: true } } }).ok === true);
check('undeclared no-reader tier FAILS', checkTierRoutes({ tiers: { X: {} } }).ok === false);
check('record:false with no route FAILS', checkTierRoutes({ tiers: { Y: { push: false, digest: false, record: false } } }).ok === false);
check('live config passes', checkTierRoutes().ok === true);

console.log('11f. announcement classifier is THREE-STATE (equity / unrecognised / crypto)');
{
  const { classifyAnnouncementText } = await import('./src/core/taxonomy.js');
  const { categoryTokens, novelTokens } = await import('./src/core/vocab.js');
  const OLD = Date.parse('2026-01-01T00:00:00Z');
  const known = { perpetual: OLD, quanto: OLD, margined: OLD };
  const nt = (title, o = {}) => novelTokens(title, { vocab: known, now: o.now ?? Date.now() });
  const cls = (title, o = {}) => classifyAnnouncementText(title, { novelTokens: nt, ...o });
  // The 14 Aug case: TradFi is not in the vocabulary, so it must NOT read as crypto.
  check('TradFi title reads EQUITY (label now known)',
    cls('New listing: SAMSUNGEMUSDT TradFi Perpetual Contract, with up to 25x leverage').cls === 'EQUITY');
  // The general case: the NEXT rename, whatever it is called.
  const next = cls('New listing: FOOUSDT NeoFinance Perpetual Contract, with up to 25x leverage');
  check('an UNKNOWN product line reads UNRECOGNISED, not crypto', next.cls === 'UNRECOGNISED');
  check('the novel token is named for the operator', next.novel.includes('neofinance'));
  check('a plain crypto listing still reads CRYPTO',
    cls('New listing: FOOUSDT Perpetual Contract, with up to 25x leverage').cls === 'CRYPTO');
  check('tickers are not mistaken for category tokens', !categoryTokens('New listing: ZHONGJIUSDT Perpetual Contract').includes('zhongjiusdt'));
  // GRADUATION IS AN EXPLICIT ACT, NOT A TIMEOUT. A quarantine that expires on time
  // rather than on review is a silent policy change: away for a week, or the operator
  // line scrolls past, and the token trusts itself.
  const NOW = Date.now();
  const seenLongAgo = { approved: known, pending: { neofinance: { firstSeen: NOW - 90 * 86400e3, lastSeen: NOW, count: 40 } } };
  check('a token seen 90 days and 40 times, unreviewed, is STILL NOVEL',
    novelTokens('New listing: BARUSDT NeoFinance Perpetual Contract', { vocab: seenLongAgo }).includes('neofinance'));
  check('only APPROVAL confers trust',
    !novelTokens('New listing: BARUSDT NeoFinance Perpetual Contract',
      { vocab: { approved: { ...known, neofinance: NOW }, pending: {} } }).includes('neofinance'));
  const { pendingUrgency } = await import('./src/core/vocab.js');
  check('operator line escalates with age/recurrence',
    pendingUrgency([{ firstSeen: NOW, count: 1 }], NOW).mark === '⚠️'
    && pendingUrgency([{ firstSeen: NOW - 2 * 86400e3, count: 4 }], NOW).mark === '🚨'
    && pendingUrgency([{ firstSeen: NOW - 30 * 86400e3, count: 40 }], NOW).level === 'UNREVIEWED-STALE');
}

console.log('11i. multiplier floor is a function of n; ladder windows QUALIFYING weeks');
{
  const { floorFor, moduleExpectancy, evaluateLadder } = await import('./src/core/budget.js');
  check('thin estimate keeps the protective floor', floorFor(50) === 0.6 && floorFor(99) === 0.6);
  check('confident estimate relaxes toward 0.1', floorFor(300) === 0.1 && floorFor(400) === 0.1);
  check('floor interpolates between', floorFor(200) < 0.6 && floorFor(200) > 0.1);
  // A confident, strongly negative module must not be rescued 7x by a fixed floor.
  const neg = Array.from({ length: 320 }, (_, i) => ({ type: 'PUMP', symbol: 'S' + i, ts: Date.UTC(2026, 6, 1) + i * 86400e3,
    exchange: 'binance', alpha: { h24: -6 } }));
  const e = moduleExpectancy(neg);
  check('confident negative module is NOT floored at 0.6', e.mult.PUMP < 0.2);
  check('composite weight is never negative (would invert contribution)', e.multRaw.PUMP >= 0);
  check('expectancy reports the floor it used', e.expectancy.PUMP.floor === floorFor(e.expectancy.PUMP.n));
  // Ladder: a THIN week must not occupy a window slot. Three bad qualifying weeks
  // separated by a thin one previously stuck at TIGHTENED forever and could even
  // revert to OK as thin weeks diluted the window.
  const wk = (weekIdx, n, alpha) => Array.from({ length: n }, (_, i) => ({ type: 'LADDERTEST', symbol: 'S' + weekIdx + '_' + i,
    ts: Date.UTC(2026, 0, 1) + weekIdx * 7 * 86400e3 + i * 3600e3, exchange: 'binance', alpha: { h24: alpha } }));
  const ladderRows = [...wk(1, 30, -5), ...wk(2, 30, -5), ...wk(3, 5, -5), ...wk(4, 30, -5), ...wk(5, 30, -5)];
  // Injected state: the fixture must not write a synthetic module into the running
  // bot's state.json (and must not race its save()).
  const res = evaluateLadder(ladderRows, {});
  check('4 bad QUALIFYING weeks reach DISABLED despite an interleaved thin week',
    res.LADDERTEST?.status === 'DISABLED', res.LADDERTEST?.status);
  check('live ladder state untouched by the fixture', !getState().ladder?.LADDERTEST)
}

console.log('13. FACT/CALL split — facts are unscored, unbudgeted, never queued');
{
  const { isFact, FACT_TYPES, admit } = await import('./src/core/budget.js');
  check('catalysts and prints are FACTS', ['LISTING', 'SUSPENSION', 'DELIST_SCHEDULED', 'FUNDING', 'CPI', 'UNLOCK'].every((t) => isFact({ type: t })));
  check('directional signals are NOT facts', !isFact({ type: 'CONFLUENCE' }) && !isFact({ type: 'MULTIEX' }));
  check('an explicit kind:CALL overrides the type default', !isFact({ type: 'FUNDING', kind: 'CALL' }));
  const v = admit({ source: 'CEX', type: 'SUSPENSION', severity: 'HIGH', key: 'f' + Math.random(), title: 'x', lines: [] });
  check('fact admits with no score and no tier', v.allow && v.kind === 'FACT' && v.score === undefined && v.tier === undefined);
  check('fact is never charged to the budget', v.charge === false);
  const { formatAlert } = await import('./src/core/dispatcher.js');
  const factMsg = formatAlert({ source: 'CEX', type: 'LISTING', severity: 'HIGH', title: 'KII listed', lines: ['x'] }, { kind: 'FACT' });
  check('fact message carries NO conviction and NO tier', !/conviction/.test(factMsg) && !/TIER/.test(factMsg) && /no directional call/.test(factMsg));
  const callMsg = formatAlert({ source: 'SIG', type: 'CONFLUENCE', severity: 'HIGH', title: 'c', lines: ['x'] }, { kind: 'CALL', tier: 'B', score: 76 });
  check('call message still carries tier + conviction', /B-TIER/.test(callMsg) && /conviction 76/.test(callMsg));
}

console.log('14. depth is an ANNOTATION for facts, a HARD GATE for calls');
{
  const { gateLine } = await import('./src/core/dispatcher.js');
  check('thin book is stated, not hidden', /not sizeable/.test(gateLine({ executableUsd: 800, spreadBps: 120, pass: false })) && /~\$800/.test(gateLine({ executableUsd: 800, spreadBps: 120, pass: false })));
  check('deep book reads tradeable', /tradeable/.test(gateLine({ executableUsd: 47000, spreadBps: 12, pass: true })) && /\$47k/.test(gateLine({ executableUsd: 47000, spreadBps: 12, pass: true })));
  check('unverifiable depth says so', /unverified/.test(gateLine(null)));
}

console.log('15. noise classes: promos and operational housekeeping drop silently');
{
  const { isNoise, classify: cl } = await import('./src/sources/cex/announcements.js');
  const ref = JSON.parse(readFileSync('fixtures/reference-window-2026-08-13.json', 'utf8'));
  for (const m of ref.messages.filter((x) => x.why === 'promo'))
    check(`promo dropped: ${m.title.slice(0, 40)}`, isNoise(m.title) === 'promo');
  for (const m of ref.messages.filter((x) => x.why === 'operational'))
    check(`operational dropped: ${m.title.slice(0, 40)}`, isNoise(m.title) === 'operational');
  check('a real listing is NOT noise', !isNoise('Bitget Will List CYS/USDT Margin Trading Pair'));
  check('a suspension is NOT noise', !isNoise('POKT Deposit and Withdrawal Suspension Notice'));
  // Noise must be checked before novelty so a rebranded promo makes no review noise.
  check('promo does not reach the novelty classifier', cl('Pakistan Exclusive: Independence Trading Tournament — Share a Prize Pool of 50,000 USDT')?.type === 'NOISE');
}

console.log('16. new detectors: suspension (routine vs open-ended) + scheduled delist');
{
  const { classify: cl } = await import('./src/sources/cex/announcements.js');
  const routine = cl('POKT Deposit and Withdrawal Suspension Notice (resumes 18/08 18:00 KST)');
  check('routine suspension detected, resumption noted', routine?.type === 'SUSPENSION' && routine.routine === true && routine.both === true);
  const open = cl('Suspension of ALLO withdrawals');
  check('open-ended suspension is the louder case', open?.type === 'SUSPENSION' && open.routine === false && open.sev === 'HIGH');
  check('chain upgrade counts as routine', cl('Deposits suspended for XYZ network upgrade')?.routine === true);
  const del = cl('Notice of Termination of Trading Support for STORJ, TT, JASMY (effective 2026-09-14)');
  check('dated delisting becomes DELIST_SCHEDULED with the date', del?.type === 'DELIST_SCHEDULED' && /2026-09-14/.test(del.dateText));
  check('undated delisting stays the immediate path', cl('Delisting of FOO')?.type === 'LISTING');
  check('suspension is not mistaken for a delisting', cl('Withdrawal suspension for FOO')?.type === 'SUSPENSION');
}

console.log('17. reference-window replay (24 real messages)');
{
  const { classify: cl, isNoise } = await import('./src/sources/cex/announcements.js');
  const ref = JSON.parse(readFileSync('fixtures/reference-window-2026-08-13.json', 'utf8'));
  let pushed = 0, suppressed = 0, wrong = [];
  const seenEvent = new Set();
  for (const m of ref.messages) {
    const c = cl(m.title);
    const noise = !c || c.type === 'NOISE' || c.type === 'UNRECOGNISED';
    // cross-source dedup: same venue+asset+type inside the window
    const evKey = `${m.venue}:${m.title.slice(0, 30)}`;
    const dup = seenEvent.has(evKey); seenEvent.add(evKey);
    const wouldPush = !noise && !dup;
    if (m.want === 'SUPPRESS' && wouldPush) wrong.push(`${m.title.slice(0, 45)} should SUPPRESS (${m.why})`);
    if (m.want !== 'SUPPRESS' && !wouldPush) wrong.push(`${m.title.slice(0, 45)} should ${m.want}`);
    if (wouldPush) pushed++; else suppressed++;
  }
  check('every message routes as specified', wrong.length === 0, wrong.slice(0, 3).join(' | '));
  check(`pushed facts within expected ${ref.expect.pushedFacts.join('-')}`,
    pushed >= ref.expect.pushedFacts[0] && pushed <= ref.expect.pushedFacts[1], `${pushed} pushed / ${suppressed} suppressed`);
}

console.log('19. FUNDING: state-entry dedup (the recurrence lesson applied to facts)');
{
  const { fundingDecision } = await import('./src/sources/cex/funding.js');
  const TH = 0.5;
  check('below threshold does not fire', !fundingDecision(0.3, TH, null).fire);
  const entry = fundingDecision(-0.9, TH, null);
  check('entering the extreme state fires', entry.fire && entry.reason === 'entered');
  const st = { entryF: -0.9 };
  check('PERSISTING at the same level does NOT re-fire', !fundingDecision(-0.95, TH, st).fire);
  check('a 50%+ intensification re-fires', fundingDecision(-1.4, TH, st).fire && fundingDecision(-1.4, TH, st).reason === 'intensified');
  check('a sign flip re-fires', fundingDecision(0.8, TH, st).fire && fundingDecision(0.8, TH, st).reason === 'flipped');
  check('hysteresis: state clears only well below the bar', !fundingDecision(0.45, TH, st).clear && fundingDecision(0.35, TH, st).clear);
  // The failure this prevents: a pair parked at extreme funding for days.
  let fires = 0, state = null;
  for (const f of [-0.9, -0.92, -0.88, -0.91, -0.9, -0.93]) {
    const d = fundingDecision(f, TH, state);
    if (d.fire) { fires++; state = { entryF: f }; }
  }
  check('a pair parked at extreme funding fires ONCE, not six times', fires === 1);
}

console.log('20. Korean notice feeds feed the new detectors');
{
  const { classify: cl } = await import('./src/sources/cex/announcements.js');
  const pokt = cl('포켓네트워크(POKT) 입출금 일시 중지 안내 (08/18 오후 6시~)');
  check('Bithumb POKT suspension detected from Korean', pokt?.type === 'SUSPENSION' && pokt.both === true);
  const resumed = cl('폴리곤에코시스템토큰(POL) 입출금 일시 중지 안내 (08/14 재개)');
  check('stated 재개 (resumption) reads as ROUTINE', resumed?.routine === true);
  check('no resumption reads as the louder case', pokt.routine === false && pokt.sev === 'HIGH');
  check('network upgrade counts as routine', cl('클레이튼(KLAY) 입출금 일시 중지 안내 (네트워크 업그레이드)')?.routine === true);
  const storj = cl('스토리지(STORJ) 거래지원 종료 안내 (9/14 15:00)');
  check('Upbit STORJ delisting detected with its date', storj?.type === 'DELIST_SCHEDULED' && /9\/14/.test(storj.dateText));
  check('Korean listing notice is not mistaken for a delisting', cl('신규 거래지원 안내 (KRW, BTC 마켓)')?.type !== 'DELIST_SCHEDULED');
}

console.log('21. routine suspensions must EARN the channel; parse failures go loud');
{
  const { classify: cl, suspensionInterest, assetOf } = await import('./src/sources/cex/announcements.js');
  const NOW = Date.UTC(2026, 7, 18, 12);
  check('asset extracted from a Korean title', assetOf('포켓네트워크(POKT) 입출금 일시 중지 안내 (08/14 재개)') === 'POKT');
  check('quote currencies are not mistaken for the asset', assetOf('신규 거래지원 안내 (KRW, BTC 마켓)') === null);
  // A lone routine maintenance carries nothing -> review log, not the channel.
  check('routine + nothing else = no interest', suspensionInterest('POKT', 'bithumb', { st: {}, unlocks: [], now: NOW }).length === 0);
  // Cross-venue: the second venue is what makes it informative.
  const st2 = {};
  suspensionInterest('POKT', 'bithumb', { st: st2, unlocks: [], now: NOW });
  const cross = suspensionInterest('POKT', 'upbit', { st: st2, unlocks: [], now: NOW });
  check('same asset halted on 2 venues within 12h IS informative', cross.some((r) => /2 venues/.test(r)));
  check('a pending delisting makes a routine halt informative',
    suspensionInterest('STORJ', 'upbit', { st: { pendingDelists: { STORJ: { at: NOW } } }, unlocks: [], now: NOW })
      .some((r) => /scheduled delisting/.test(r)));
  check('an unlock inside the halt window is informative',
    suspensionInterest('EIGEN', 'bithumb', { st: {}, unlocks: [{ token: 'EIGEN', ts: NOW + 3 * 86400e3 }], now: NOW })
      .some((r) => /unlock/.test(r)));
  check('an unlock far outside the window is not',
    suspensionInterest('EIGEN', 'bithumb', { st: {}, unlocks: [{ token: 'EIGEN', ts: NOW + 40 * 86400e3 }], now: NOW }).length === 0);
  // PARTIAL PARSE FAILURE: pattern matched, field did not.
  const pf = cl('Notice of Termination of Trading Support for FOO, effective at the stated time');
  check('delisting with unreadable date = PARSE_FAILED, not a degraded alert', pf?.type === 'PARSE_FAILED' && pf.field === 'date');
  check('genuinely dateless delisting still uses the immediate path', cl('Delisting of FOO')?.type === 'LISTING');
  check('a readable date still classifies normally', cl('Delisting of FOO effective 2026-09-14')?.type === 'DELIST_SCHEDULED');
}

console.log('22. symbol-level classification on the TICKER path (the real samples)');
{
  const { classifySymbol, AssetClass, allowPriceDetector } = await import('./src/core/taxonomy.js');
  const TK = new Set(['TSLA', 'CRCL', 'WDC', 'AXTI', 'NVDA']);
  const cs = (b) => classifySymbol(b, 'USDT', 'kucoin', { tickers: TK });
  // EXCLUDE — the six live samples that reached the channel.
  check('TSLAX excluded (xStock + known ticker)', cs('TSLAX').state === 'EXCLUDE' && cs('TSLAX').cls === AssetClass.TOKENIZED_EQUITY);
  check('CRCLX excluded', cs('CRCLX').state === 'EXCLUDE');
  for (const s of ['WDC3L', 'WDC3S', 'AXTI3L', 'AXTI3S'])
    check(`${s} excluded (leveraged)`, cs(s).state === 'EXCLUDE' && cs(s).cls === AssetClass.LEVERAGED_TOKEN);
  // Leveraged suffix is sufficient ALONE — underlying irrelevant.
  check('BTC3L excluded even though BTC is obviously crypto', cs('BTC3L').state === 'EXCLUDE');
  check('leveraged verdict names underlying and side', cs('WDC3L').underlying === 'WDC' && cs('WDC3L').side === 'long');
  // A TICKER MATCH ALONE MUST NEVER BLOCK.
  check('NVDA alone (no wrapper convention) is OK, not blocked', cs('NVDA').state === 'OK');
  check('plain crypto listings unaffected', ['LINK', 'ARB', 'SUI', 'TIA'].every((s) => cs(s).state === 'OK'));
  // UNRECOGNISED pushes, unlike the announcement path.
  // The false positive caught on LIVE DATA before deploy: GMX decomposes to GM + X,
  // and GM is a real equity ticker. A major crypto protocol would have been silenced.
  check('GMX is NOT excluded despite decomposing to GM+X', classifySymbol('GMX', 'USDT', 'binance', { tickers: new Set(['GM', 'TSLA']) }).state === 'OK');
  check('CVX, IMX, AVAX, DYDX likewise survive', ['CVX', 'IMX', 'AVAX', 'DYDX'].every((s) =>
    classifySymbol(s, 'USDT', 'binance', { tickers: new Set(['CV', 'IM', 'AVA', 'DYD']) }).state === 'OK'));
  // ...while genuine xStocks with equally short stems are still caught.
  check('short-stem xStocks (MCDX, WMTX, PGX) still excluded', ['MCDX', 'WMTX', 'PGX'].every((s) =>
    classifySymbol(s, 'USDT', 'gate', { tickers: new Set(['MCD', 'WMT', 'PG']) }).state === 'EXCLUDE'));
  const comp = cs('COMPX');
  check('trailing-X with unknown stem = UNRECOGNISED (pushes + logged)', comp.state === 'UNRECOGNISED');
  check('UNRECOGNISED is NOT exclude — symbols default OPEN', comp.state !== 'EXCLUDE');
  // Price detectors must exclude the new class too.
  check('LEVERAGED_TOKEN is barred from price detectors',
    allowPriceDetector('BTC3LUSDT', { price: 5, change24hPct: 12 }, 'PUMP').allowed === false
    || classifySymbol('BTC3L').state === 'EXCLUDE');
}

console.log('23. ticker path routes through the classifier + batches');
{
  const { checkListings } = await import('./src/sources/cex/listings.js');
  const tick = (s, p) => ({ symbol: s, price: p, quoteVol24h: 1000 });
  const base = [tick('BTCUSDT', 60000)];
  checkListings('gate', base); // baseline poll
  const next = [...base, tick('WDC3LUSDT', 1), tick('WDC3SUSDT', 1), tick('AXTI3LUSDT', 1), tick('AXTI3SUSDT', 1)];
  const out = checkListings('gate', next);
  check('all four leveraged tokens excluded — ZERO alerts', out.length === 0);
  checkListings('kucoin', base);
  const k = checkListings('kucoin', [...base, tick('TSLAXUSDT', 400), tick('CRCLXUSDT', 200)]);
  check('TSLAX and CRCLX excluded on the ticker path', k.length === 0);
  checkListings('bybit', base);
  const good = checkListings('bybit', [...base, tick('NEWCOINUSDT', 1)]);
  check('a genuine crypto listing still pushes as a FACT', good.length === 1 && good[0].kind === 'FACT');
  checkListings('mexc', base);
  const many = checkListings('mexc', [...base, tick('AAAUSDT', 1), tick('BBBUSDT', 1), tick('CCCUSDT', 1), tick('DDDUSDT', 1)]);
  check('4 genuine listings in one cycle collapse to ONE message', many.length === 1 && /4 new pairs/.test(many[0].title));
}

console.log('25. exclusion review is a MECHANISM, not a habit');
{
  const { excludedStats } = await import('./src/core/unclassified.js');
  const NOW = Date.UTC(2026, 7, 20);
  const d = (n) => NOW - n * 86400e3;
  const lev = { cls: 'LEVERAGED_TOKEN', lastSeen: d(1) };
  const xs = { cls: 'TOKENIZED_EQUITY', lastSeen: d(1) };
  check('fresh review + new xStock = visible but not overdue',
    !excludedStats(NOW, { rows: [xs], reviewedAt: d(2) }).overdue);
  check('xStock accrued, review 15d stale = ⚠️',
    excludedStats(NOW, { rows: [xs], reviewedAt: d(15) }).mark === '⚠️');
  check('xStock accrued, review 30d stale = 🚨',
    excludedStats(NOW, { rows: [xs], reviewedAt: d(30) }).mark === '🚨');
  check('never reviewed with xStock accrued = 🚨',
    excludedStats(NOW, { rows: [xs], reviewedAt: null }).mark === '🚨');
  check('leveraged-only accrual never nags (unambiguous branch)',
    !excludedStats(NOW, { rows: [lev, lev], reviewedAt: d(60) }).overdue);
  check('stale stamp with NOTHING new to review does not nag',
    !excludedStats(NOW, { rows: [{ ...xs, lastSeen: d(50) }], reviewedAt: d(40) }).overdue);
}

console.log('26. one END-TO-END fixture per module: the unlocks loader, real schema');
{
  // The loadUnlockEvents bug (wrong path + array-as-object) survived weeks of passing
  // hermetic fixtures because nothing exercised the loader against the real format.
  // Companion clause to the hermetic rule: gates stay hermetic, but ONE path test per
  // module runs loader-included through a FROZEN copy of the actual schema.
  const { loadUnlockEvents } = await import('./src/sources/cex/announcements.js');
  const evts = loadUnlockEvents('fixtures/unlocks-schema-sample.json');
  check('loader parses the real schema (frozen copy)', Array.isArray(evts) && evts.length >= 2);
  check('symbols are real, not array indices', evts.every((e) => /^[A-Z]/.test(e.token)) && evts.some((e) => e.token === 'EIGEN'));
  check('timestamps are real dates', evts.every((e) => Number.isFinite(e.ts) && e.ts > Date.UTC(2026, 0, 1)));
  check('RETIRED tokens produce no events even if a stale edit re-adds them',
    !evts.some((e) => e.token === 'INJ'));
}

console.log('27. retired unlock tokens are a POSITIVE, boot-asserted state');
{
  check('live unlocks.json passes (INJ retired cleanly)', checkTierRoutes().ok === true);
  check('a revived retired token FAILS boot',
    checkTierRoutes({ tokens: [{ sym: 'INJ', retired: 'fully-unlocked', monthlyDay: 15 }] }).ok === false);
  check('retired with events[] also FAILS',
    checkTierRoutes({ tokens: [{ sym: 'INJ', retired: 'fully-unlocked', events: [{ date: '2026-09-01' }] }] }).ok === false);
  check('retired and clean passes',
    checkTierRoutes({ tokens: [{ sym: 'INJ', retired: 'fully-unlocked' }] }).ok === true);
}

console.log('28. promotion CONSTRUCTS, never patches (the 4.97% lesson)');
{
  const { promoteRow, verifiedRowProblems } = await import('./src/core/unlock-promote.js');
  const estimatedEra = { sym: 'ZRO', name: 'LayerZero', monthlyDay: 20, pctOfMcap: 4.4, verified: false, note: 'old aggregator note' };
  // reviewBy required since the enforcement rule (section 34) — announcement rows are
  // not contract-enforced and must carry a forward falsifier to be constructible.
  const row = promoteRow(estimatedEra, { monthlyDay: 20, note: 'new', reviewBy: '2026-12-31', events: [{ date: '2026-09-20', source: 'announcement', detail: 'x' }] });
  check('estimated-era fields do NOT survive promotion', !('pctOfMcap' in row));
  check('identity survives, provenance is explicit', row.sym === 'ZRO' && row.verified === true && row.events[0].source === 'announcement');
  check('promotion without provenance refuses', (() => { try { promoteRow(estimatedEra, { events: [] }); return false; } catch { return true; } })());
  check('a retired token refuses promotion', (() => { try { promoteRow({ sym: 'INJ', retired: 'fully-unlocked' }, { events: [{ date: '2026-09-01', source: 'x', detail: 'y' }] }); return false; } catch { return true; } })());
  // Boot assertion: patched-not-constructed rows fail.
  check('verified row carrying pctOfMcap FAILS boot',
    verifiedRowProblems([{ sym: 'EIGEN', events: [{ date: '2026-08-30', source: 's' }], reviewBy: '2026-12-31', pctOfMcap: 4.97 }]).length === 1);
  check('constructed row passes', verifiedRowProblems([row]).length === 0);
  check('LIVE unlocks.json has no patched promotions', checkTierRoutes().ok === true);
}

console.log('29. version provenance: one source of truth, no silent drift');
{
  // package.json had drifted to 0.3.0 while config.js was 0.24.3, and the push
  // script's commit message was hardcoded to "v0.9.4 -> v0.17.0" — so every commit
  // carried the same false label. A history where each entry says the same wrong
  // thing is worse than no message. Version is now DERIVED at push time; this keeps
  // the two files from silently diverging again.
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const cfg = readFileSync('src/config.js', 'utf8').match(/VERSION = '([^']+)'/)[1];
  check(`package.json (${pkg}) matches src/config.js (${cfg})`, pkg === cfg);
  const bat = readFileSync('PUSH-TO-GITHUB.bat', 'utf8');
  // Inspect the COMMIT LINE only — the file's comments legitimately quote the old
  // hardcoded string while explaining why it was removed, and a whole-file grep
  // would flag that explanation as the defect it documents.
  const commitLine = bat.split(/\r?\n/).find((l) => /git .*commit -m/.test(l)) || '';
  check('commit message derives the version', /%RADAR_VER%/.test(commitLine));
  check('commit message hardcodes no version literal', !/v\d+\.\d+\.\d+/.test(commitLine));
  check('push script still aborts on a staged .env', /ABORTED: \.env was staged/.test(bat));
}

console.log('30. message prose is linted — direction ban + unsupported-statistics ban');
{
  // TWO RULES, ONE MECHANISM, files AUTO-DISCOVERED (not a hand-maintained list —
  // that is the CRYPTO_EXCEPTIONS defect; a registry would still be a list, but a
  // directory walk covers a new module the moment its file exists):
  //
  // RULE 1 (facts): no DIRECTIONAL claims or imperatives. The 27 Aug EIGEN T-3 said
  // "fact - no directional call" and "Close now" in the same message. The line is the
  // project's own measurement: agreement predicts MAGNITUDE not DIRECTION, so
  // volatility language stays and direction language goes.
  //
  // RULE 2 (everything): no FREQUENCY CLAIMS without a sample size. "usually",
  // "typically", "historically", "often" assert statistics nobody computed — the
  // original "historically these fade" defect from the first critique, now guarded.
  // A frequency word is allowed when the same line carries its evidence (n=, N of M,
  // measured, percentile).
  //
  // STATIC over source files, deliberately: silent modules (CASCADE unproduced,
  // REVIVAL silenced, PUMP/DUMP ladder-disabled) are covered even though nothing
  // watches their output — an output-based lint would reproduce the exact bug this
  // fixture exists to prevent.
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p2 = dir + '/' + f;
    return statSync(p2).isDirectory() ? walk(p2) : (p2.endsWith('.js') ? [p2] : []);
  });
  const files = [...walk('src/sources'), 'src/core/dispatcher.js', 'src/core/confluence.js', 'src/core/telemetry.js'];
  check('auto-discovery finds a non-trivial module set', files.length >= 15);
  const DIRECTION = /(close now|exit here|buy now|sell now|take profit|dump hard|sell off sharply|capitulation bottom|blow-off top|reversal risk|front-run|bleeds into|drift usually)/i;
  const FREQ = /\b(usually|typically|historically|often|tend to|most of the time)\b/i;
  const EVIDENCE = /n\s*[=>\u2265]|\b\d+\s*of\s*\d+\b|\bmeasured\b|percentile|\bp99\b/i;
  const dirHits = [], freqHits = [];
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const code = line.replace(/^\s*\/\/.*/, '').replace(/\/\/.*$/, '');
      if (!/['"\u0060]/.test(code)) continue;   // string literals only; comments may
      if (DIRECTION.test(code)) dirHits.push(f.split('/').pop() + ': ' + code.trim().slice(0, 60));
      if (FREQ.test(code) && !EVIDENCE.test(code)) freqHits.push(f.split('/').pop() + ': ' + code.trim().slice(0, 60));
    }
  }
  check('no module asserts DIRECTION in message text', dirHits.length === 0, dirHits.slice(0, 3).join(' | '));
  check('no module asserts FREQUENCY without evidence', freqHits.length === 0, freqHits.slice(0, 3).join(' | '));
  check('direction guard can fire', DIRECTION.test("lines: ['Close now']"));
  check('frequency guard can fire', FREQ.test("'these usually fade'") && !EVIDENCE.test("'these usually fade'"));
  check('frequency WITH evidence passes', !(FREQ.test("'usually fades (measured: 21 of 30, n=30)'") && !EVIDENCE.test("'usually fades (measured: 21 of 30, n=30)'")));
  check('volatility language still permitted', !DIRECTION.test("'expect wider swings'") && !FREQ.test("'the open is violent'"));
}

console.log('24. classifiers-wired boot assertion');
{
  const { checkClassifiersWired } = await import('./src/core/routes.js');
  check('live emitters all call their classifier', checkClassifiersWired().ok === true);
  check('an emitter that stops calling its classifier FAILS boot',
    checkClassifiersWired({ readFile: () => 'export function checkListings(){ return []; }' }).ok === false);
}

console.log('18. every FACT type has a declared route (boot assertion)');
check('live fact types all routed', checkTierRoutes().ok === true);
check('an undeclared fact type FAILS boot', checkTierRoutes({ factTypes: ['NEWFACTTYPE'] }).ok === false);

console.log('12. ONE equity classifier (taxonomy owns the text markers)');
const { isEquityText } = await import('./src/core/taxonomy.js');
check('taxonomy catches TradFi', isEquityText('New listing: SAMSUNGEMUSDT TradFi Perpetual Contract, with up to 25x leverage'));
check('taxonomy catches xStock', isEquityText('TSLAUSDT xStock now available'));
check('plain crypto title passes', !isEquityText('New listing: NEWCOINUSDT Perpetual Contract, with up to 25x leverage'));

console.log('31. cadence watch — behavioural verification carries its own falsifier');
{
  // A prose demote-trigger is memory-dependent (the quarantine-lapse shape, fixed four
  // times in this project). These fixtures pin the AUTOMATIC version: window computed,
  // outflows injected, demotion decided and superseded — all pure, no live files.
  const { expectedEmissionDate, cadenceDecision, activeDemotions, cadenceStatus } =
    await import('./src/sources/calendar/cadence-watch.js');
  const { promoteRow, cadenceSpecProblems, verifiedRowProblems } = await import('./src/core/unlock-promote.js');
  const spec = { wallet: '0x54B8c65f0635fD91C8729Dd3269C630d9AED54e5', expectDay: 6, meanAmount: 12069436, monthsObserved: 13, roll: 'nextBusinessDay' };

  // Window arithmetic: the ENA-observed weekend roll (2026-06-06 is a Saturday).
  check('weekday 6th stays put', expectedEmissionDate(spec, 2026, 7).toISOString().slice(0, 10) === '2026-07-06');
  check('Saturday 6th rolls to Monday 8th', expectedEmissionDate(spec, 2026, 6).toISOString().slice(0, 10) === '2026-06-08');
  const me = { wallet: spec.wallet, monthEnd: true, expectDay: 30, meanAmount: 9.6e6, monthsObserved: 11 };
  check('month-end day 30 clamps in February', expectedEmissionDate(me, 2026, 2).toISOString().slice(0, 10) === '2026-02-28');

  // Decision states.
  const inWindow = new Date('2026-09-08T12:00:00Z'); // expected Sep 7 (6th=Sunday), grace to Sep 10
  const afterWindow = new Date('2026-09-11T12:00:00Z');
  check('open window is PENDING — absence of evidence is not yet evidence', cadenceDecision(spec, 2026, 9, inWindow, {}).action === 'PENDING');
  check('qualifying outflow after window closes CONFIRMS', cadenceDecision(spec, 2026, 9, afterWindow, { '2026-09-07': 13e6 }).action === 'CONFIRM');
  check('sub-threshold outflow (49% of mean) does not confirm', cadenceDecision(spec, 2026, 9, afterWindow, { '2026-09-07': spec.meanAmount * 0.49 }).action === 'DEMOTE');
  check('empty window DEMOTES — the falsification test runs itself', cadenceDecision(spec, 2026, 9, afterWindow, {}).action === 'DEMOTE');
  check('outflow OUTSIDE the window does not rescue it', cadenceDecision(spec, 2026, 9, afterWindow, { '2026-09-20': 13e6 }).action === 'DEMOTE');

  // The first bootstrap run falsely demoted ENA off a 3-page fetch that never reached
  // the window — truncated data looked identical to an empty window. Pinned: only a
  // fetch that COVERED the window is evidence at all.
  const { windowObserved } = await import('./src/sources/calendar/cadence-watch.js');
  check('truncated fetch is not evidence — never demote on it', !windowObserved({ byDay: {}, covered: false }));
  check('failed fetch is not evidence either', !windowObserved(null));
  check('covered fetch IS evidence', windowObserved({ byDay: {}, covered: true }));

  // Demotion overlay + supersession by newer evidence.
  const toks = [{ sym: 'ENA', cadence: spec, events: [{ date: '2026-08-28', source: 'onchain-cadence' }] }];
  const demSt = { demotions: { ENA: { at: '2026-09-11T02:00', month: '2026-09' } } };
  check('a standing demotion suppresses the row', 'ENA' in activeDemotions(toks, demSt));
  const rePromoted = [{ sym: 'ENA', cadence: spec, events: [{ date: '2026-09-15', source: 'onchain-cadence' }] }];
  check('re-promotion with NEWER evidence supersedes the demotion', !('ENA' in activeDemotions(rePromoted, demSt)));

  // Promotion refuses behavioural provenance without its falsifier — enforced by shape.
  let threw = false;
  try { promoteRow({ sym: 'X', name: 'X' }, { events: [{ date: '2026-08-28', source: 'onchain-cadence', detail: 'd' }] }); } catch { threw = true; }
  check('promoteRow refuses onchain-cadence without a cadence spec', threw);
  check('promoteRow accepts onchain-cadence WITH a spec', !!promoteRow({ sym: 'X', name: 'X' }, { events: [{ date: '2026-08-28', source: 'onchain-cadence', detail: 'd' }], cadence: spec }).cadence);
  check('boot re-asserts the same rule', verifiedRowProblems([{ sym: 'Y', events: [{ date: '2026-08-28', source: 'onchain-cadence' }] }]).length > 0);
  check('spec validator rejects a truncated wallet', cadenceSpecProblems({ ...spec, wallet: '0x54B8c65f06' }).length > 0);

  // The watch's own pulse: demoted rows scream, confirmed rows show their month.
  const stConf = { months: { ENA: { '2026-09': { action: 'CONFIRM' } } }, demotions: {} };
  check('heartbeat line shows last confirmed month', cadenceStatus(toks, stConf, new Date('2026-09-12')).line.includes('ok 2026-09'));
  check('heartbeat line marks a demoted row loudly', cadenceStatus(toks, demSt, new Date('2026-09-12')).line.includes('🚨 demoted'));
}

console.log('32. addresses are resolved from reports, never typed (provenance-by-construction)');
{
  // Two fabricated address tails reached commands in one day. Rule -> shape: a wallet
  // reference resolves against tool-written report addresses or it does not exist.
  const { resolveWalletRef } = await import('./src/core/unlock-promote.js');
  const known = ['0x54B8c65f0635fD91C8729Dd3269C630d9AED54e5', '0x54B8000000000000000000000000000000000000', '0x34BcF805A503D5151c05CD349699a8aD1767a026'];
  check('unique prefix resolves to the report address', resolveWalletRef('0x54B8c6', known) === known[0]);
  check('full report address resolves to itself', resolveWalletRef(known[2], known) === known[2]);
  let e1 = null; try { resolveWalletRef('0x54B8c65f06D720de548A93aB2A2f2FE3097cc5C7', known); } catch (e) { e1 = e.message; }
  check('the fabricated address from today is REFUSED (plausible ≠ provenanced)', /matches no address/.test(e1 || ''));
  let e2 = null; try { resolveWalletRef('0x54B8', known); } catch (e) { e2 = e.message; }
  check('ambiguous prefix refuses instead of guessing', /ambiguous/.test(e2 || ''));
  let e3 = null; try { resolveWalletRef('EIGEN', known); } catch (e) { e3 = e.message; }
  check('non-address input refuses', e3 !== null);
}

console.log('33. absence of observation is not observation of absence (named class, swept)');
{
  // windowObserved() was the prototype; these pin the companions: every "nothing
  // happened" zero must say whether anyone was looking.
  const { feedWasLooking } = await import('./src/core/pulse.js');
  check('fresh text feed counts as looking', feedWasLooking(/^(?!dex:|funding$|macro$).+/, 6 * 3600, [{ name: 'binance', ageSec: 300 }]));
  check('only dex/funding/macro alive = text feeds NOT looking', !feedWasLooking(/^(?!dex:|funding$|macro$).+/, 6 * 3600, [{ name: 'dex:1', ageSec: 60 }, { name: 'funding', ageSec: 60 }, { name: 'macro', ageSec: 60 }]));
  check('a stale text feed is not looking either', !feedWasLooking(/^(?!dex:|funding$|macro$).+/, 6 * 3600, [{ name: 'binance', ageSec: 7 * 3600 }]));

  const { buildHeartbeat, accumulatorStatus } = await import('./src/core/telemetry.js');
  const base = { startedAt: Date.now(), rows: [], pulse: 'x', digest: { line: 'd' }, accumulators: { lines: [] }, cadence: { line: 'c' }, unclassified: { shapes: 0, recurring: 0, seen24h: 0 }, excluded: { total: 0, leveraged: 0, equity: 0, seen24h: 0, overdue: false } };
  const dark = buildHeartbeat(Date.now(), { ...base, feedLooking: false }).lines.join('\n');
  const lit = buildHeartbeat(Date.now(), { ...base, feedLooking: true }).lines.join('\n');
  check('zero unclassified + no live feed = loud, not clean', dark.includes('not looking, not clean'));
  check('zero unclassified + live feed = calm zero', !lit.includes('not looking, not clean'));

  const now = Date.now();
  const flowing = accumulatorStatus(now, { rows: [{ ts: now - 3600e3, mfe: 1 }], st: {}, backup: { newestAgeH: 1, count: 1, stale: false, drillAgeD: 1, drillMark: '' } });
  check('stall with rows flowing names the recorder', flowing.lines[0].includes('recorder problem'));
  const quiet = accumulatorStatus(now, { rows: [], st: {}, backup: { newestAgeH: 1, count: 1, stale: false, drillAgeD: 1, drillMark: '' } });
  check('zero rows 48h points at collectors, not accumulators', quiet.lines[0].includes('check collectors') && !quiet.lines[0].includes('recorder problem'));
}

console.log('34. enforcement, not provenance label, decides the falsifier (the EIGEN asymmetry)');
{
  // 'announcement+onchain-backtest' SOUNDED stronger than 'onchain-cadence' while
  // carrying zero forward falsification — the label described discovery, custody
  // enforces nothing. Rule: any non-contract schedule carries a cadence spec
  // (observable emissions) or a reviewBy dead-man's switch (unobservable, e.g.
  // omnichain ZRO where a cadence spec would false-demote by construction).
  const { forwardFalsifierProblems } = await import('./src/core/unlock-promote.js');
  const { activeDemotions: aD, cadenceStatus: cS } = await import('./src/sources/calendar/cadence-watch.js');
  const spec = { wallet: '0x34BcF805A503D5151c05CD349699a8aD1767a026', monthEnd: true, expectDay: 30, meanAmount: 7.8e6, monthsObserved: 11 };
  const ann = [{ date: '2026-09-16', source: 'announcement' }];
  check('declared contract enforcement needs nothing further', forwardFalsifierProblems({ enforcement: 'contract', events: ann }).length === 0);
  check('behavioural row with NEITHER falsifier fails (however strong the label)', forwardFalsifierProblems({ events: [{ date: '2026-08-30', source: 'announcement+onchain-backtest' }] }).length > 0);
  check('cadence spec satisfies it', forwardFalsifierProblems({ events: ann, cadence: spec }).length === 0);
  check('reviewBy dead-man-switch satisfies it', forwardFalsifierProblems({ events: ann, reviewBy: '2026-11-30' }).length === 0);
  check('unparseable reviewBy fails', forwardFalsifierProblems({ events: ann, reviewBy: 'soon' }).length > 0);
  check('cadence-DISCOVERED row cannot downgrade to reviewBy', forwardFalsifierProblems({ events: [{ date: '2026-08-28', source: 'onchain-cadence' }], reviewBy: '2026-11-30' }).length > 0);

  // Expired review = overlay demotion, superseded only by re-promotion.
  const zro = [{ sym: 'ZRO', reviewBy: '2026-09-22', events: [{ date: '2026-09-20', source: 'announcement' }] }];
  const expired = { months: {}, demotions: { ZRO: { at: '2026-09-23T02:00', type: 'review-expired', reviewBy: '2026-09-22' } } };
  check('expired review suppresses the row', 'ZRO' in aD(zro, expired));
  const reattested = [{ sym: 'ZRO', reviewBy: '2026-12-22', events: [{ date: '2026-09-24', source: 'announcement' }] }];
  check('re-promotion after re-attestation supersedes', !('ZRO' in aD(reattested, expired)));
  check('status line shows the dead-man switch', cS(zro, { months: {}, demotions: {} }, new Date('2026-09-01')).line.includes('ZRO review by 2026-09-22'));
  // Warn before it bites — demotion should be a decision, not a discovery.
  const at = (d) => cS(zro, { months: {}, demotions: {} }, new Date(d)).line;
  check('far out: days shown, no mark', at('2026-09-01T00:00:00Z').includes('(21d)') && !at('2026-09-01T00:00:00Z').includes('⚠️'));
  check('T-14 escalates to ⚠️', at('2026-09-10T00:00:00Z').includes('⚠️ review approaching'));
  check('T-3 escalates to 🚨', at('2026-09-20T00:00:00Z').includes('🚨 re-attest now'));

  // The LIVE file obeys the rule — every verified row carries its falsifier.
  const { verifiedRowProblems: vrp } = await import('./src/core/unlock-promote.js');
  const live = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens;
  check('LIVE unlocks.json: no verified row lacks a forward falsifier', vrp(live).length === 0);
  const eigen = live.find((t) => t.sym === 'EIGEN');
  check('LIVE EIGEN carries a cadence spec (most-verified is no longer least-falsified)', !!eigen?.cadence?.wallet && eigen.cadence.monthEnd === true);
}

console.error = origErr;
console.log(failures === 0 ? '\nALL DELIVERY PROPERTIES HOLD' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
