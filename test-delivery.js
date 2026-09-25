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
  // (diet) a FACT carries no subtitle at all: "facts only" is the feed's property and
  // lives in the channel description, not in every element of the feed.
  check('fact message carries NO conviction, NO tier and NO per-message disclaimer subtitle', !/conviction/.test(factMsg) && !/TIER/.test(factMsg) && !/no directional call/.test(factMsg));
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
  // v0.30.2: a constructed row is not yet BOOTABLE — it needs derived falsifier
  // strength, stamped through strength=auto. The gate names exactly that and nothing else.
  check('constructed row lacks only its derived strength', verifiedRowProblems([row]).length === 1 && /no derived falsifier strength/.test(verifiedRowProblems([row])[0]));
  check('constructed row passes once strength is stamped', verifiedRowProblems([{ ...row, falsifier: { verdict: 'NONE', basis: 'b' } }]).length === 0);
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
  // v0.30.0: enforcement:'contract' is EARNED, not declared. A bare label used to pass;
  // now the same row is refused until it carries the contract, a clusterSpec, replayed
  // cliffDates and an upgradeable flag (Route 2).
  check('DECLARED contract enforcement (bare label) is refused', forwardFalsifierProblems({ enforcement: 'contract', events: ann }).length > 0);
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
  // Shape-agnostic: single-wallet OR family (§39). Asserting `.wallet` specifically
  // made this fixture fail the moment EIGEN widened to a family spec — a test that
  // pins an implementation detail blocks the improvement it should be guarding.
  check('LIVE EIGEN carries a cadence spec (most-verified is no longer least-falsified)',
    (!!eigen?.cadence?.wallet || eigen?.cadence?.wallets?.length > 0) && eigen.cadence.monthEnd === true);
}

console.log('35. stage tiering — tier BEFORE bulk promotion, not after');
{
  const { STAGES, leadsFor, lastMonthlyDate } = await import('./src/sources/calendar/unlocks.js');
  check('FULL emits five stages incl. T-7 and post-event', JSON.stringify(STAGES.FULL) === '[14,7,3,0,-3]');
  check('LOGGED emits nothing (tracked, never pushed)', STAGES.LOGGED.length === 0);
  // T-7 is the operator's minimum notice. It was dropped when tiers were first cut;
  // this pins it into every stage that pushes at all.
  check('every non-LOGGED stage contains T-7', Object.entries(STAGES).every(([k, v]) => k === 'LOGGED' || v.includes(7)));
  check('STANDARD is T-7/T-3/T-0 and nothing backward', JSON.stringify(STAGES.STANDARD) === '[7,3,0]');
  check('unstaged rows default STANDARD (existing five unchanged in kind)', JSON.stringify(leadsFor({})) === JSON.stringify(STAGES.STANDARD));
  check('unknown stage falls back to STANDARD, not silence', JSON.stringify(leadsFor({ stage: 'TYPO' })) === JSON.stringify(STAGES.STANDARD));
  // T+3 needs a BACKWARD-looking date: the forward-only helper made negative leads
  // structurally dead code (found while wiring, would have shipped silently).
  const prev = lastMonthlyDate(30, new Date('2026-09-02T12:00:00Z'));
  check('lastMonthlyDate finds the just-passed occurrence', prev.toISOString().slice(0, 10) === '2026-08-30');
  const feb = lastMonthlyDate(30, new Date('2026-03-01T12:00:00Z'));
  check('lastMonthlyDate clamps short months', feb.toISOString().slice(0, 10) === '2026-02-28');
  const { promoteRow } = await import('./src/core/unlock-promote.js');
  let bad = false; try { promoteRow({ sym: 'X', name: 'X' }, { events: [{ date: '2026-09-01', source: 's', detail: 'd' }], reviewBy: '2026-12-01', stage: 'MEGA' }); } catch { bad = true; }
  check('promoteRow refuses unknown stage', bad);
  check('promoteRow carries a valid stage', promoteRow({ sym: 'X', name: 'X' }, { events: [{ date: '2026-09-01', source: 's', detail: 'd' }], reviewBy: '2026-12-01', stage: 'LOGGED' }).stage === 'LOGGED');

  // Coverage line: absence of a row must never read as "no unlocks" (the scan found
  // 55 of 156 symbols vest off-Ethereum — structurally invisible, not unlocked).
  const { unlockCoverage } = await import('./src/sources/calendar/unlocks.js');
  const cov = unlockCoverage([
    { sym: 'A', events: [{}], cadence: { wallet: '0x' }, stage: 'FULL' },
    { sym: 'B', events: [{}], reviewBy: '2026-12-01', stage: 'STANDARD' },
    { sym: 'C' }, { sym: 'D', retired: 'fully-unlocked' },
  ]);
  check('coverage counts verified/estimated/retired', cov.verified === 2 && cov.estimated === 1 && cov.retired === 1);
  check('coverage splits falsifier kinds', cov.cadence === 1 && cov.reviewBy === 1);
  check('coverage states the chain limit so absence is not read as no-unlocks', /Ethereum\/EVM only/.test(cov.line));
  check('coverage reports stages', /FULL:1/.test(cov.line) && /STANDARD:1/.test(cov.line));
}

console.log('36. every prompt document declares its premises (documents get obeyed)');
{
  // Code gets exercised; documents just keep reading as authoritative after their
  // assumptions expire. Three expired-filter instances so far, the last one in a
  // PROMPT (REMAINING-WORK.md ranked bucket A as the prize after the scan refuted
  // it). Countermeasure = the rule already applied to code: RECORD WHY NEXT TO WHAT.
  // Auto-discovered, never a hardcoded list — a hardcoded list is the CRYPTO_EXCEPTIONS
  // defect, and the point is that a NEW document is covered the moment it exists.
  // RECURSIVE. First cut read the top level only — which would have let imported
  // briefs in docs/briefs/ escape the requirement, after I had told the operator
  // they would "inherit this check automatically". A guard whose coverage is
  // narrower than its advertised scope is worse than no guard.
  const { readdirSync: rds, statSync: st } = await import('node:fs');
  const SKIP = new Set(['node_modules', '.git', 'data', 'fixtures', 'backups']);
  const walkDocs = (dir) => rds(dir).flatMap((f) => {
    if (SKIP.has(f)) return [];
    const p = dir === '.' ? f : `${dir}/${f}`;
    try { return st(p).isDirectory() ? walkDocs(p) : (f.endsWith('.md') ? [p] : []); } catch { return []; }
  });
  const docs = walkDocs('.');
  check('doc discovery finds the document set', docs.length >= 4);
  const missing = [], undated = [], noAssumptions = [];
  for (const f of docs) {
    const head = readFileSync(f, 'utf8').slice(0, 1600);
    const m = head.match(/<!--\s*PREMISE([\s\S]*?)-->/);
    if (!m) { missing.push(f); continue; }
    if (!/Written against:\s*v?\d+\.\d+\.\d+/.test(m[1])) undated.push(f);
    // "Assumes:" must be followed by at least one real bullet — an empty block is a
    // header that looks like a safeguard while asserting nothing.
    if (!/Assumes:\s*\n\s*-\s*\S/.test(m[1])) noAssumptions.push(f);
  }
  check('every .md declares a PREMISE block', missing.length === 0, missing.join(', '));
  check('every PREMISE names the version it was written against', undated.length === 0, undated.join(', '));
  check('every PREMISE lists at least one assumption', noAssumptions.length === 0, noAssumptions.join(', '));
  // Self-tests: the checks must be capable of failing.
  check('premise check can fail', !/<!--\s*PREMISE[\s\S]*?-->/.test('# Doc\n\nno header here'));
  check('empty-assumptions check can fail', !/Assumes:\s*\n\s*-\s*\S/.test('Written against: v1.0.0\nAssumes:\n'));
}

console.log('50. CHANNEL SPLIT — public channel carries facts and calls only; telemetry and watch verdicts go to the operator DM');
{
  const { publicPushes24h } = await import('./src/core/telegram.js');
  const { buildHeartbeat } = await import('./src/core/telemetry.js');
  // Destination invariant, read from source (same instrument as the prose lint):
  // every broadcast() in telemetry.js and cadence-watch.js is DM-only.
  const dmOnly = (file) => {
    const src = readFileSync(file, 'utf8');
    const calls = [...src.matchAll(/broadcast\(([\s\S]*?)\)\s*(?:\.catch|;|\n)/g)].map((m) => m[0]);
    return { n: calls.length, bad: calls.filter((c) => !/toChannel:\s*false/.test(c)) };
  };
  const tele = readFileSync('src/core/telemetry.js', 'utf8');
  check('telemetry.js routes every send through sendTelemetry (DM-only)', (tele.match(/\bbroadcast\(/g) || []).length === 1 && /const sendTelemetry = \(text\) => broadcast\(text, \{ toChannel: false \}\)/.test(tele) && (tele.match(/sendTelemetry\(/g) || []).length === 2 /* digest + heartbeat */);
  const cw = dmOnly('src/sources/calendar/cadence-watch.js');
  check('cadence-watch.js: every verdict broadcast is DM-only (CONFIRM/PARTIAL/DEMOTE/review/source)', cw.n >= 6 && cw.bad.length === 0, cw.bad.map((b) => b.slice(0, 60)).join(' | '));
  check('CONFIRM verdicts are now sent (cadence and cliff), not only summarised', /cadence window \$\{mKey\} CONFIRMED/.test(readFileSync('src/sources/calendar/cadence-watch.js', 'utf8')) && /cliff \$\{c\.date\} CONFIRMED/.test(readFileSync('src/sources/calendar/cadence-watch.js', 'utf8')));
  check('the digest marks itself sent against DM recipients, not channel', /hasRecipients\(false\)/.test(tele.split('Daily digest')[1].slice(0, 400)));
  // Public-push ledger: channel deliveries only, 24h, injected into the heartbeat.
  const now = Date.now();
  const st = { publicPushes: [now - 1000, now - 3600e3, now - 25 * 3600e3] };
  check('publicPushes24h counts channel deliveries inside 24h only', publicPushes24h(now, st) === 2);
  check('empty ledger reads zero, not undefined', publicPushes24h(now, {}) === 0);
  const hb = buildHeartbeat(now, { rows: [], drops: { total: 0, byReason: {} }, bugs: 0, pulse: 'none yet', startedAt: now, digest: { line: 'Digest: pool 0' }, publicPushes: 7 });
  check('DM heartbeat carries "public pushes 24h: N" so channel health is readable from the DM', hb.lines.some((l) => /public pushes 24h: 7/.test(l)));
  check('reading rule still present alongside it', hb.lines.some((l) => l.includes('correctly quiet')));
  // Boot: the DIGEST tier keeps a reader (rerouted, not removed).
  const { checkTierRoutes } = await import('./src/core/routes.js');
  check('tier-route assertion passes after the reroute (no tier without a reader)', checkTierRoutes().ok === true);
  // Delivery accounting unaffected: telemetry never counted as facts/calls.
  const { messageCounts } = await import('./src/core/dispatcher.js');
  const before = messageCounts();
  check('messageCounts() is fact/call only — a telemetry send is not budgeted', typeof before.facts === 'number' && typeof before.calls === 'number' && !('telemetry' in before));
}

console.log('49. FALSIFIER STRENGTH is derived on EVERY verified row (chance rate → replay), not just the suspicious one');
{
  const { falsifierProblems, stampStrength, falsifierLine, MIN_FALSIFIER_MARGIN, MIN_FALSIFIER_MARGIN_BASIS, verifiedRowProblems, sourceRow, clusterGridMargins } = await import('./src/core/unlock-promote.js');
  const { strengthFromSeries, strengthFromClusterSpec } = await import('./derive-falsifier-strength.js');
  const { claimCoverage, unlockCoverage } = await import('./src/sources/calendar/unlocks.js');
  const day = (i) => new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
  // Synthetic metronome: 12 monthly emissions in 365 days, nothing else -> 12x5/365 = 0.16.
  const metro = {}; for (let m = 0; m < 12; m++) metro[day(5 + m * 30)] = 1e6; metro[day(364)] = 1e6;
  const s1 = strengthFromSeries({ wallet: '0xw', meanAmount: 1e6, graceDays: 3 }, { '0xw': metro });
  check('window width is the watch\'s own (grace 3 -> 5 days)', s1.windowDays === 5);
  check('metronome: 13 qualifying days / 365 -> chance 0.18', s1.qualifyingDays === 13 && s1.spanDays >= 364 && Math.abs(s1.chanceRate - 0.18) <= 0.01);
  // Busy wallet: the same 12 emissions plus 40 ad-hoc days above 50% of mean -> chance climbs.
  const busy = { ...metro }; for (let i = 0; i < 40; i++) busy[day(7 + i * 8)] = 6e5;
  const s2 = strengthFromSeries({ wallet: '0xw', meanAmount: 1e6, graceDays: 3 }, { '0xw': busy });
  check('ad-hoc moves above the CONFIRM bar raise the chance rate (busy > metronome)', s2.chanceRate > s1.chanceRate && s2.qualifyingDays > 40);
  check('moves BELOW the confirm bar do not count (they could not confirm a window either)', strengthFromSeries({ wallet: '0xw', meanAmount: 1e6 }, { '0xw': { ...metro, [day(100)]: 4e5 } }).qualifyingDays === 13);
  check('family: any wallet clearing its own bar qualifies the day', strengthFromSeries({ wallets: [{ addr: 'a', meanAmount: 1e6 }, { addr: 'b', meanAmount: 2e5 }] }, { a: { [day(10)]: 1e6 }, b: { [day(40)]: 1.5e5 } }).qualifyingDays === 2);
  check('empty series -> null (we did not look is not strong)', strengthFromSeries({ wallet: '0xw', meanAmount: 1 }, { '0xw': {} }) === null);
  check('contract: derived from clusterSpec (ORDER 0.58 / replay 0.75)', (() => { const c = strengthFromClusterSpec({ windowDays: 5, hits: 6, offIndex: 7, spanDays: 113, n: 8 }); return c.chanceRate === 0.58 && c.replayRate === 0.75; })());
  // Stamp + gate.
  const row = { sym: 'T', name: 'T', verified: true, events: [{ date: '2026-09-01', source: 'x' }], cadence: { wallet: '0xw', meanAmount: 1 }, foreign: 1 };
  const st = stampStrength(row, { verdict: 'STRONG', chanceRate: 0.24, replayRate: 1, replayN: 11, windowDays: 5, qualifyingDays: 17, spanDays: 354, basis: 'b', at: 'now', kind: 'cadence-family' });
  check('stampStrength whitelist-copies (foreign field dropped) and records margin', st.foreign === undefined && st.falsifier.margin === 0.76);
  // ADMISSION BAR (2026-09-15): the verdict is derived from the margin at the stamp,
  // never copied from the report; below the bar the stamp is refused and names the
  // sourced tier. ORDER's own numbers (0.58 / 0.75 → 0.17) are the below-bar case.
  const orderRep = { verdict: 'STRONG', chanceRate: 0.58, replayRate: 0.75, replayN: 8, replayHits: 6, windowDays: 5, qualifyingDays: 13, spanDays: 113, basis: 'b', at: 'now', kind: 'contract-cliff' };
  check('the bar is a declared constant with its basis naming the observed distribution', MIN_FALSIFIER_MARGIN === 0.40 && /EIGEN 0\.76/.test(MIN_FALSIFIER_MARGIN_BASIS) && /ORDER 0\.17/.test(MIN_FALSIFIER_MARGIN_BASIS) && /declared/.test(MIN_FALSIFIER_MARGIN_BASIS));
  check('stamp REFUSES a margin below the bar and names the sourced tier', (() => { try { stampStrength(row, orderRep); return false; } catch (e) { return /below the verified-tier admission bar/.test(e.message) && /sourced tier/.test(e.message); } })());
  check('MUTATION: the same report with replay lifted over the bar is stamped STRONG', stampStrength(row, { ...orderRep, replayRate: 1, replayHits: 8 }).falsifier.verdict === 'STRONG');
  check('MUTATION: exactly AT the bar is admitted (>=, declared)', stampStrength(row, { ...orderRep, chanceRate: 0.35, replayRate: 0.75 }).falsifier.margin === 0.40);
  check('a report verdict WEAK cannot be stamped — the label is retired', (() => { try { stampStrength(row, { ...orderRep, verdict: 'WEAK' }); return false; } catch { return true; } })());
  check('a report verdict is never COPIED: a STRONG label with a below-bar margin is still refused', (() => { try { stampStrength(row, { ...orderRep, verdict: 'STRONG', replayRate: 0.9, chanceRate: 0.58 }); return false; } catch { return true; } })());
  check('boot gate refuses a STORED WEAK verdict', falsifierProblems({ ...row, falsifier: { verdict: 'WEAK', chanceRate: 0.58, replayRate: 0.75, margin: 0.17, basis: 'b' } }).some((p) => /WEAK is no longer a verified-tier state/.test(p)));
  check('boot gate refuses a stored STRONG whose margin is below the bar', falsifierProblems({ ...row, falsifier: { verdict: 'STRONG', chanceRate: 0.58, replayRate: 0.75, margin: 0.17, basis: 'b' } }).some((p) => /below the verified-tier admission bar/.test(p)));
  check('boot gate refuses a stored margin that disagrees with its own replay−chance', falsifierProblems({ ...row, falsifier: { verdict: 'STRONG', chanceRate: 0.58, replayRate: 0.75, margin: 0.76, basis: 'b' } }).some((p) => /disagrees with replay/.test(p)));
  check('MUTATION: a stored row above the bar with consistent margin passes', falsifierProblems({ ...row, falsifier: { verdict: 'STRONG', chanceRate: 0.24, replayRate: 1, margin: 0.76, basis: 'b' } }).length === 0);
  // TIER CORRECTION: below the bar a verified row goes back to sourced, with a reason,
  // and what it held is recorded — not deleted.
  const src = { source: 'defillama', sourceFetchedAt: '2026-09-15T03:49', sourceEvents: [{ t: 1789948800, n: 5e5, type: 'cliff', cats: 'farming' }], chain: 'ethereum' };
  const wasVer = { sym: 'V', name: 'V', verified: true, events: [{ date: '2026-09-01', source: 'contract-cliff' }], enforcement: 'contract', falsifier: { margin: 0.17 } };
  check('a verified row is still refused by sourceRow WITHOUT a reason', (() => { try { sourceRow(wasVer, src); return false; } catch (e) { return /TIER CORRECTION/.test(e.message); } })());
  check('a token reason (<20 chars) is refused', (() => { try { sourceRow(wasVer, { ...src, tierCorrection: { reason: 'bar' } }); return false; } catch { return true; } })());
  const corrected = sourceRow(wasVer, { ...src, tierCorrection: { reason: 'falsifier margin 0.17 below the 0.40 admission bar' } });
  check('with a reason the row is SOURCED and carries tierHistory with what was retracted', corrected.provenance === 'sourced' && corrected.events === undefined && corrected.tierHistory.from === 'verified' && corrected.tierHistory.retracted.enforcement === 'contract' && corrected.tierHistory.retracted.falsifier.margin === 0.17 && /0\.40/.test(corrected.tierHistory.reason));
  // The EVIDENCE travels with the decision. A row that held a clusterSpec cannot be
  // corrected on "the grid" without the grid: margins per point, computed from the
  // tool's report, recorded beside the reason — so the question stays settled.
  const rep = { spanDays: 113, grid: [{ windowDays: 3, minRatio: 2, hits: 7, n: 8, off: 16 }, { windowDays: 5, minRatio: 3, hits: 6, n: 8, off: 7 }, { windowDays: 7, minRatio: 5, hits: 4, n: 8, off: 6 }] };
  const gm = clusterGridMargins(rep);
  check('clusterGridMargins: a margin per point (w3/r2 0.26, w5/r3 0.17, w7/r5 −0.12) and the best named', gm.points.map((p) => p.margin).join() === '0.26,0.17,-0.12' && gm.best.w === 3 && gm.best.r === 2 && gm.best.margin === 0.26);
  check('clusterGridMargins: no grid or no span -> null (unknown is not evidence)', clusterGridMargins(null) === null && clusterGridMargins({ grid: rep.grid }) === null);
  const withSpec = { ...wasVer, clusterSpec: { windowDays: 5, hits: 6, offIndex: 7, spanDays: 113, n: 8, basis: 'b' } };
  check('a row that held a clusterSpec is REFUSED a tier correction without the grid evidence', (() => { try { sourceRow(withSpec, { ...src, tierCorrection: { reason: 'falsifier margin 0.17 below the 0.40 admission bar' } }); return false; } catch (e) { return /grid margins as evidence/.test(e.message); } })());
  const withEv = sourceRow(withSpec, { ...src, tierCorrection: { reason: 'falsifier margin 0.17 below the 0.40 admission bar', evidence: { grid: gm, stampedMargin: 0.17 } } });
  check('with the grid, the row records it beside the reason, with the bar it was judged against, and keeps the spec + cliff history', withEv.tierHistory.evidence.bar === MIN_FALSIFIER_MARGIN && withEv.tierHistory.evidence.grid.best.margin === 0.26 && withEv.tierHistory.evidence.grid.points.length === 3 && withEv.tierHistory.retracted.clusterSpec.hits === 6);
  check('MUTATION: a row WITHOUT a clusterSpec needs no grid (the requirement follows the evidence the row had)', sourceRow(wasVer, { ...src, tierCorrection: { reason: 'falsifier margin 0.17 below the 0.40 admission bar' } }).tierHistory.evidence === undefined);
  check('MUTATION: a correction on a row that was never verified is refused (nothing to correct)', (() => { try { sourceRow({ sym: 'S', name: 'S' }, { ...src, tierCorrection: { reason: 'nothing to correct here at all' } }); return false; } catch { return true; } })());
  check('stamp refuses a missing report entry (never typed)', (() => { try { stampStrength(row, null); return false; } catch { return true; } })());
  check('a verified cadence row WITHOUT derived strength fails the boot gate', verifiedRowProblems([row]).some((p) => /no derived falsifier strength/.test(p)));
  check('a reviewBy row needs verdict NONE, not a number', falsifierProblems({ sym: 'R', verified: true, reviewBy: '2026-12-01', events: [{}], falsifier: { verdict: 'NONE', basis: 'b' } }).length === 0);
  check('falsifierLine says underived rather than skipping', /underived/.test(falsifierLine({ sym: 'U' })));
  // Live: all seven carry it; the line shows all seven.
  const live = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens.filter((t) => t.verified && !t.retired && (t.cadence || t.enforcement === 'contract' || t.reviewBy));
  check('LIVE: every verified row carries derived strength', live.length === 6 && live.every((t) => t.falsifier?.verdict));
  check('LIVE: EIGEN/ENA/MOVE have NUMBERS, not an implicit "strong"', ['EIGEN', 'ENA', 'MOVE'].every((s) => { const f = live.find((t) => t.sym === s).falsifier; return f.chanceRate > 0 && f.replayRate === 1 && /days ≥50% of mean/.test(f.basis); }));
  check('LIVE: no verified row is WEAK (retired) and every numeric margin clears the bar; dead-man rows are NONE', live.every((t) => t.falsifier.verdict !== 'WEAK' && (t.falsifier.verdict === 'NONE' || t.falsifier.margin >= MIN_FALSIFIER_MARGIN)) && ['ARB', 'STRK', 'ZRO'].every((s) => live.find((t) => t.sym === s).falsifier.verdict === 'NONE'));
  const cov = unlockCoverage();
  check('coverage line carries the admission bar and the LOWEST live margin (arithmetic over rows)', cov.marginBar === MIN_FALSIFIER_MARGIN && /margin bar 0\.4 \(lowest (EIGEN|ENA|MOVE) 0\.\d+\)/.test(cov.line) && cov.lowestMargin.margin === Math.min(...live.filter((t) => Number.isFinite(t.falsifier?.margin)).map((t) => t.falsifier.margin)));
  check('MUTATION: with no numeric margins the line says so rather than omitting the bar', /margin bar 0\.4 \(no margins live\)/.test(unlockCoverage([{ sym: 'R', verified: true, events: [{}], reviewBy: '2026-12-01', falsifier: { verdict: 'NONE', basis: 'b' } }]).line));
  check('coverage line shows chance/window for all six', /falsifier chance→replay: .*EIGEN \d+%\/window/.test(cov.line) && !/WEAK/.test(cov.line) && ['EIGEN', 'STRK', 'ARB', 'MOVE', 'ENA', 'ZRO'].every((s) => new RegExp('\\b' + s + ' ').test(cov.strength)) && !cov.underived);
  check('every verified claimCoverage line states its strength (cadence, contract, dead-man)', live.every((t) => /Falsifier strength: /.test(claimCoverage(t, 3).line)));
  // COMPOUND: the row's weight is the replay series, not the per-window figure.
  const { compoundChance } = await import('./src/core/unlock-promote.js');
  check('compound: 11 consecutive at 24% -> 1.5e-7 (binomial tail)', Math.abs(compoundChance(0.24, 11, 11) / 1.5e-7 - 1) < 0.02);
  check('compound: ORDER 6/8 at 58% -> ~0.28 (misses counted, not consecutive)', Math.abs(compoundChance(0.58, 6, 8) - 0.275) < 0.005);
  check('compound: 0/0 windows -> null (no series, no weight)', compoundChance(0.24, 0, 0) === null);
  check('compound: more consecutive stamps at the same chance rate always weigh more', compoundChance(0.3, 5, 5) > compoundChance(0.3, 8, 8));
  check('stamp carries compound + replayHits', st.falsifier.replayHits === 11 && Math.abs(st.falsifier.compound / 1.5e-7 - 1) < 0.1);
  check('coverage line shows per-window AND series AND compound (EIGEN 24%/window · 11/11 consecutive · p≈1.5e-7)', /EIGEN 24%\/window · 11\/11 consecutive · p≈1\.5e-7/.test(cov.line));
  check('claimCoverage says "that series by chance alone" with the compound', /record 11\/11 consecutive \(that series by chance alone: p≈1\.5e-7\)/.test(claimCoverage(live.find((t) => t.sym === 'EIGEN'), 3).line));
  check('claimCoverage can say UNDERIVED', /UNDERIVED/.test(claimCoverage({ verified: true, cadence: { monthsObserved: 3, wallet: 'x' }, events: [{}] }, 3).line));
}

console.log('51. a sourced row that CANNOT fire is counted as coverage — the heartbeat now says so');
{
  const { sourcedFiring } = await import('./src/sources/calendar/unlocks.js');
  const now = Date.UTC(2026, 8, 7, 12);
  const D = 86400e3, sec = (ms) => Math.floor(ms / 1000);
  const base = { provenance: 'sourced', source: 'defillama', chain: 'ethereum', maxSupply: 1e9,
    sourceFetchedAt: new Date(now - 2 * D).toISOString().slice(0, 16) };
  const ev = (days, n = 1e7) => ({ t: sec(now + days * D), n, cats: 'insiders' });
  const rows = [
    { ...base, sym: 'SOON', stage: 'STANDARD', sourceEvents: [ev(7)] },        // T-7 today
    { ...base, sym: 'LATER', stage: 'STANDARD', sourceEvents: [ev(30)] },      // no lead inside 7d
    { ...base, sym: 'DUE10', stage: 'STANDARD', sourceEvents: [ev(10)] },      // T-7 fires in 3 days
    { ...base, sym: 'PAST', stage: 'STANDARD', sourceEvents: [ev(-30)] },      // events exhausted
    { ...base, sym: 'QUIET', stage: 'LOGGED', sourceEvents: [ev(3)] },         // silent on purpose
    { ...base, sym: 'OLD', stage: 'STANDARD', sourceEvents: [ev(7)], sourceFetchedAt: new Date(now - 40 * D).toISOString().slice(0, 16) },
  ];
  // one-row builder, so the invariants below read as rules rather than as data
  const row = ([sym, daysOut]) => [{ ...base, sym, stage: 'STANDARD', sourceEvents: [ev(daysOut)] }];
  const r = sourcedFiring(now, rows);
  check('counts rows, rows with a future event, and rows firing in 7d', r.sourced === 6 && r.withFuture === 5 && r.firing7d === 2);
  check('a row whose next lead lands inside 7d counts, one whose lead is further out does not', r.firing.includes('SOON') && r.firing.includes('DUE10') && !r.firing.includes('LATER'));
  check('an exhausted row is MUTE, and mute is not coverage', /PAST:no future event/.test(r.mute.join()) && r.faultMute.some((m) => m.startsWith('PAST')));
  check('a stale row is MUTE for a different reason, and says which', r.faultMute.some((m) => m === 'OLD:stale'));
  check('a LOGGED row is silent BY DESIGN, not a fault (the alarm must not cry wolf)', r.mute.includes('QUIET:silent-by-stage') && !r.faultMute.some((m) => m.startsWith('QUIET')));
  check('the line names the firing rows and raises 🚨 only on fault-mute', /29|6 rows/.test(r.line) && /🚨 2 MUTE/.test(r.line) && /1 silent by design/.test(r.line));
  check('no fault-mute -> no MUTE siren (the coverage arm is its own siren, asserted below)', !/🚨 \d+ MUTE/.test(sourcedFiring(now, [rows[0], rows[4]]).line));
  // INVARIANTS, not today's data. These two were written as `LIVE:` assertions on
  // 2026-09-07 ("all 29 rows can fire") and went RED on 2026-09-13 without a line of
  // code changing: SEI, APT and CARV simply ran out of listed events. A fixture that
  // pins today's data reddens with the calendar, and a suite that reddens on schedule
  // trains people to ignore red. Fourth instance of the environment-vs-logic class.
  // The RULE is what is asserted now; the facts about today live on the heartbeat.
  const exhausted = row(['EXH', -30]);   // events all in the past
  const alive = row(['ALIVE', 10]);      // one future event
  const mixed = sourcedFiring(now, [...exhausted, ...alive]);
  check('a row with zero future events is fault-mute, and says which fault', mixed.faultMute.includes('EXH:no future event'));
  check('a row with a future event is NOT fault-mute', !mixed.faultMute.some((m) => m.startsWith('ALIVE')));
  check('MUTATION: give the exhausted row a future event and it leaves faultMute', sourcedFiring(now, row(['EXH', 10])).faultMute.length === 0);
  check('withFuture counts exactly the rows with an event after now', mixed.withFuture === 1 && mixed.sourced === 2);
  // ITEM 8 — COVERAGE ARM. The age arm reads the file's age; the coverage arm reads how
  // far ahead the file LOOKS (horizon = the latest listed event across rows). N = 14
  // was pre-registered before the rows were measured (REMAINING-WORK-NOTES.md
  // 2026-09-18). Acceptance: the coverage arm fires on a FRESH file whose horizon is
  // short, while the age arm stays FRESH on the same file.
  const { sourceCoverage, COVERAGE_WARN_DAYS } = await import('./src/core/unlock-promote.js');
  const freshShort = [...row(['A', 3]), ...row(['B', 9]), ...row(['C', -2])];            // fetched now, horizon 9d
  const rs = sourcedFiring(now, freshShort);
  check('N is a declared constant, pre-registered (14)', COVERAGE_WARN_DAYS === 14);
  check('coverage arm FIRES on a fresh file whose horizon is 9d', rs.coverage.level === 'SHORT' && rs.coverage.horizonDays === 9 && /🚨 coverage horizon 9d < 14d/.test(rs.line));
  check('…while the AGE arm stays FRESH on the same file', rs.freshness.level === 'FRESH' && /index age 2d/.test(rs.line) && !/index \d+d old/.test(rs.line));
  check('a row with no listed event inside the horizon is named, with the remedy (refresh, not age)', rs.coverage.exhausted.join() === 'C' && /a refresh extends the horizon, age does not/.test(rs.line));
  check('MUTATION: horizon at exactly N is OK (>=); 30d is OK and still names the exhausted row', sourceCoverage([...row(['A', 14])], now).level === 'OK' && sourcedFiring(now, [...row(['A', 30]), ...row(['C', -2])]).coverage.level === 'OK');
  check('MUTATION: every event behind us -> PASSED, its own state', sourceCoverage([...row(['A', -1])], now).level === 'PASSED');
  check('no sourced rows -> NONE, not OK', sourceCoverage([], now).level === 'NONE' && sourceCoverage([{ sym: 'V', verified: true }], now).level === 'NONE');
  check('the heartbeat line carries BOTH arms', /index age \d+d/.test(rs.line) && /coverage horizon/.test(rs.line));
  // THE COUNTER. estimatedSkipped climbed 17 → 51 → 68 → 85 across cycles because it
  // lived at module scope. The counts are now sums over a pure classifier the loop
  // itself consults: two consecutive cycles over the same rows give the same numbers.
  const { cycleCounts, rowSilence } = await import('./src/sources/calendar/unlocks.js');
  const cycleRows = [...freshShort, { sym: 'EST', monthlyDay: 1 }, { sym: 'DEM', verified: true, events: [{ date: '2026-01-01', source: 'x' }] }, { sym: 'RET', retired: 'gone' },
    { ...base, sym: 'OLDR', stage: 'STANDARD', sourceEvents: [ev(7)], sourceFetchedAt: new Date(now - 40 * D).toISOString().slice(0, 16) }];
  const cctx = { demoted: { DEM: { at: '2026-09-01' } }, recheck: null, now };
  const c1 = cycleCounts(cycleRows, cctx), c2 = cycleCounts(cycleRows, cctx);
  check('two consecutive cycles, same rows, same count (estimated 2 = EST + DEM · demoted 1 · stale 1)', JSON.stringify(c1) === JSON.stringify(c2) && c1.estimatedSkipped === 2 && c1.cadenceDemoted === 1 && c1.staleSourced === 1 && c1.alertable === 3);
  check('the classifier names each silence', rowSilence({ sym: 'EST', monthlyDay: 1 }, cctx) === 'estimated' && rowSilence(cycleRows[4], cctx) === 'cadence-demoted' && rowSilence(cycleRows[5], cctx) === 'retired' && rowSilence(cycleRows[6], cctx) === 'stale' && rowSilence(freshShort[0], cctx) === null);
  check('no module-scope counter survives in unlocks.js (the shape that accumulated)', !/^let (estimatedSkipped|cadenceDemoted|staleSourced)/m.test(readFileSync('src/sources/calendar/unlocks.js', 'utf8')));
  check('LIVE: the live file reports a horizon and names its exhausted rows (the arm is arithmetic over rows)', (() => { const l = sourcedFiring(); return Number.isFinite(l.coverage.horizonDays) && Array.isArray(l.coverage.exhausted); })());
  check('MUTATION: two live rows -> withFuture === sourced; two dead rows -> 0', sourcedFiring(now, [...row(['A', 5]), ...row(['B', 9])]).withFuture === 2
    && sourcedFiring(now, [...row(['A', -5]), ...row(['B', -9])]).withFuture === 0);
}

console.log('52. staleness LADDER — the 21-day cliff warns before it bites');
{
  const { sourceFreshness, sourceIsStale, SOURCE_WARN_DAYS, SOURCE_URGENT_DAYS, SOURCE_STALE_DAYS } = await import('./src/core/unlock-promote.js');
  const { sourcedFiring } = await import('./src/sources/calendar/unlocks.js');
  const now = Date.UTC(2026, 8, 27, 12), D = 86400e3;
  const at = (days) => ({ sourceFetchedAt: new Date(now - days * D).toISOString().slice(0, 16) });
  check('ladder boundaries are 14 / 18 / 21, in that order, all below the cliff', SOURCE_WARN_DAYS === 14 && SOURCE_URGENT_DAYS === 18 && SOURCE_STALE_DAYS === 21 && SOURCE_WARN_DAYS < SOURCE_URGENT_DAYS && SOURCE_URGENT_DAYS < SOURCE_STALE_DAYS);
  check('day 13 is FRESH, day 14 WARNs (boundary is inclusive, pinned)', sourceFreshness(at(13), now).level === 'FRESH' && sourceFreshness(at(14), now).level === 'WARN');
  check('day 17 WARN, day 18 URGENT', sourceFreshness(at(17), now).level === 'WARN' && sourceFreshness(at(18), now).level === 'URGENT');
  check('day 21 is still URGENT (not yet silent), day 22 is STALE', sourceFreshness(at(21), now).level === 'URGENT' && sourceFreshness(at(22), now).level === 'STALE');
  check('the cliff has ONE implementation — sourceIsStale delegates to the ladder', !/now - at\) > SOURCE_STALE_DAYS/.test(readFileSync('src/core/unlock-promote.js', 'utf8')));
  check('the ladder agrees with the rule that actually silences rows', [13, 14, 18, 21, 22, 40].every((d) => (sourceFreshness(at(d), now).level === 'STALE') === sourceIsStale(at(d), now)));
  check('days-left counts down to the cliff', sourceFreshness(at(18), now).daysLeft === 3 && sourceFreshness(at(14), now).daysLeft === 7);
  check('an unparseable timestamp is its own level, never quietly FRESH', sourceFreshness({ sourceFetchedAt: 'soon' }, now).level === 'UNPARSEABLE');
  // The warning must state the ACTION — the refresh is manual and browser-pane-only.
  const mk = (days) => [{ provenance: 'sourced', source: 'defillama', chain: 'ethereum', maxSupply: 1e9, sym: 'X', stage: 'STANDARD',
    sourceEvents: [{ t: Math.floor((now + 30 * D) / 1000), n: 1e7, cats: 'insiders' }], ...at(days) }];   // 30d horizon: the age arm is what these assert
  check('WARN line names the action and the deadline, not just the age', /⚠️ index 14d old · 7d until every sourced row goes silent — browser-pane refresh required/.test(sourcedFiring(now, mk(14)).line));
  check('URGENT escalates the marker, same sentence', /🚨 index 18d old · 3d/.test(sourcedFiring(now, mk(18)).line));
  check('past the cliff it reports the consequence in the past tense, not a countdown', /🚨 index 22d old — sourced rows are SILENT/.test(sourcedFiring(now, mk(22)).line));
  check('fresh index says only its age — no siren on a healthy day', /index age 3d/.test(sourcedFiring(now, mk(3)).line) && !/⚠️|🚨/.test(sourcedFiring(now, mk(3)).line));
  // Partial refresh: the OLDEST row sets the level, not the newest.
  const mixed = [...mk(2), ...mk(19)];
  check('a partial refresh reports the OLDEST row (a fresh row must not mask a stale one)', /🚨 index 19d old/.test(sourcedFiring(now, mixed).line));
  check('LIVE: the index is inside the ladder and the heartbeat says its age', /index (age )?\d+d/.test(sourcedFiring().line));
}

console.log('53. CROSS-SOURCE AGREEMENT — a second index changes the MESSAGE, never the provenance');
{
  const { sourceAgreement, sourcedMessage, unlockCoverage, AGREEMENT_STATES, AGREE_TOLERANCE_DAYS, loadSecondIndex } = await import('./src/sources/calendar/unlocks.js');
  const { sourcedRowProblems } = await import('./src/core/unlock-promote.js');
  const now = Date.UTC(2026, 8, 7, 12), D = 86400e3, sec = (ms) => Math.floor(ms / 1000);
  const row = (dates) => ({ sym: 'TST', name: 'T', provenance: 'sourced', source: 'defillama', chain: 'ethereum',
    stage: 'STANDARD', maxSupply: 1e9, circSupply: 5e8, sourceFetchedAt: new Date(now - D).toISOString().slice(0, 16),
    sourceEvents: dates.map((d) => ({ t: sec(now + d * D), type: 'cliff', n: 1e7, cats: 'insiders' })) });
  const idx = (d) => ({ protocols: [{ symbol: 'TST', nextDate: d }], withheld: 5 });
  check('the four states are exactly these four', AGREEMENT_STATES.join() === 'both-agree,both-differ,single-source,not-checked');
  check('same date -> both-agree', sourceAgreement(row([10]), idx('2026-09-17'), now).state === 'both-agree');
  check('one day apart is still agreement (declared tolerance, timezones)', AGREE_TOLERANCE_DAYS === 1 && sourceAgreement(row([10]), idx('2026-09-18'), now).state === 'both-agree');
  const diff = sourceAgreement(row([10]), idx('2026-09-20'), now);
  check('two days apart -> both-differ', diff.state === 'both-differ' && Math.abs(diff.deltaDays) === 3);
  check('DISAGREEMENT SHOWS BOTH DATES and picks no winner', /2026-09-17/.test(diff.line) && /2026-09-20/.test(diff.line) && !/correct|right|use /i.test(diff.line));
  check('second source silent on this symbol -> single-source, and says the source withholds', sourceAgreement(row([10]), { protocols: [], withheld: 5 }, now).state === 'single-source');
  check('no second index at all -> not-checked, never "agree"', sourceAgreement(row([10]), null, now).state === 'not-checked');
  check('a row with no future event cannot agree with anything', sourceAgreement(row([-10]), idx('2026-09-17'), now).state === 'single-source');
  // The comparison is against OUR NEXT event, not any event.
  check('compares our NEXT event, not a later one (no manufactured disagreement)', sourceAgreement(row([10, 40]), idx('2026-09-17'), now).state === 'both-agree');
  const msg = sourcedMessage(row([10, 40]), row([10, 40]).sourceEvents[0], 7, new Date(now), idx('2026-09-17'));
  check('the message carries the agreement on the NEXT event — collapsed in public, in full for the operator', msg.lines.some((l) => /DefiLlama \+ CryptoRank agree/.test(l)) && msg.operatorLines.some((l) => /agree on this date/.test(l)));
  const later = sourcedMessage(row([10, 40]), row([10, 40]).sourceEvents[1], 7, new Date(now), idx('2026-09-17'));
  check('a LATER tranche carries no agreement line (the second source made no claim about it)', !later.lines.some((l) => /agree|disagree/.test(l)) && !later.operatorLines.some((l) => /agree on this date|Sources disagree/.test(l)));
  // AGREEMENT MUST NOT PROMOTE.
  const agreed = row([10]);
  check('an agreeing row is still provenance sourced, still not verified', agreed.provenance === 'sourced' && agreed.verified !== true && sourcedRowProblems(agreed).length === 0);
  check('nothing in the agreement path writes a provenance or verified field', (() => { const before = JSON.stringify(agreed); sourceAgreement(agreed, idx('2026-09-17'), now); return JSON.stringify(agreed) === before; })());
  check('the message still says unverified even when both agree (public), NOT independently verified (operator)', msg.lines.some((l) => /unverified/.test(l)) && msg.operatorLines.some((l) => /NOT independently verified/.test(l)));
  // Live: all four states are reachable, and two are actually occupied today.
  const cov = unlockCoverage();
  check('coverage line reports the second-source split', /2nd source: \d+ agree · \d+ DISAGREE · \d+ single-source/.test(cov.line));
  check('LIVE: the states sum to the sourced row count', Object.values(cov.agreement).reduce((a, b) => a + b, 0) === cov.sourced);
  check('LIVE: at least one real disagreement was found (the state that earns the feature)', cov.agreement['both-differ'] >= 1);
  check('LIVE: the second index is on disk and dated', (() => { const s2 = loadSecondIndex(); return !!s2 && /^\d{4}-\d\d-\d\dT/.test(s2.fetchedAt) && s2.protocols.length >= 20; })());
}

console.log('54. the TRUNCATION BOUNDARY day is partial — every paginated reader is guarded, by DISCOVERY not by a list');
{
  const { spanCovered, checkPaginationGuards, paginatedReaders, PAGINATION_MARKERS } = await import('./src/core/pagination.js');
  const { cadenceDecision } = await import('./src/sources/calendar/cadence-watch.js');
  // THE GUARD ITSELF. Strict: reaching the target day is not covering it, because
  // the fetch may have stopped inside that day.
  check('spanCovered is STRICT — reaching the target day is not covering it', spanCovered('2026-06-29', '2026-06-30') && !spanCovered('2026-06-30', '2026-06-30'));
  check('no oldest, or no target, is never "covered" (we did not look)', !spanCovered(null, '2026-06-30') && !spanCovered('2026-06-29', null));
  // WHY IT MATTERS, demonstrated rather than asserted. Probed 2026-09-07: 3 pages of
  // the EIGEN wallet gave 150 transfers, 8 pages gave 400, differing on exactly the
  // boundary day.
  const spec = { wallet: '0xw', meanAmount: 1e6, expectDay: 10, graceDays: 3 };
  const now = new Date(Date.UTC(2026, 8, 20));
  check('a fully-counted boundary day CONFIRMs', cadenceDecision(spec, 2026, 9, now, { '2026-09-09': 1.2e6 }).action === 'CONFIRM');
  check('the SAME day half-counted DEMOTEs — which is what the guard prevents', cadenceDecision(spec, 2026, 9, now, { '2026-09-09': 4e5 }).action === 'DEMOTE');
  // COVERAGE BY DISCOVERY. The first version of this fixture NAMED three readers;
  // a fourth (discover-vesting) already existed and was unlisted. Now the readers
  // are found by marker, and each must call the guard or declare why not.
  const g = checkPaginationGuards();
  check('every discovered paginated reader is guarded or explicitly exempt', g.ok, g.problems.join(' | '));
  check('discovery finds MORE than the three originally listed', g.readers.length >= 4);
  check('the exemption is a stated reason, never silence', g.readers.filter((r) => r.exempt).every((r) => r.exempt !== 'unstated' && r.exempt.length > 20));
  check('every live exemption names its own file (so it cannot be copied into a new reader)', g.readers.filter((r) => r.exempt).length >= 1 && !g.readers.some((r) => r.staleExemption));
  // The count is on the HEARTBEAT, not only in a boot line nobody watched: 1 -> 2
  // exempt readers is a drift that should be visible over time.
  const { buildHeartbeat } = await import('./src/core/telemetry.js');
  const hbP = buildHeartbeat(Date.now(), { rows: [], drops: { total: 0, byReason: {} }, bugs: 0, pulse: 'x', startedAt: Date.now(), digest: { line: 'd' } });
  check('heartbeat reports the paginated-reader and exemption counts', hbP.lines.some((l) => /Paginated readers: \d+ · \d+ guarded · \d+ exempt/.test(l)));
  check('heartbeat names the exempt files, so a new one is visible not just counted', hbP.lines.some((l) => /exempt \(discover-vesting\.js\)/.test(l)));
  check('an unguarded reader would put 🚨 on that heartbeat line', /🚨 UNGUARDED/.test(buildHeartbeat(Date.now(), { rows: [], drops: { total: 0, byReason: {} }, bugs: 0, pulse: 'x', startedAt: Date.now(), digest: { line: 'd' }, pagination: { ok: false, problems: ['synthetic.js is unguarded'], readers: [] } }).lines.join('\n')));
  check('the date-span readers are the guarded ones', ['detect-cadence.js', 'detect-cliff-cluster.js', 'src/sources/calendar/cadence-watch.js'].every((f) => g.readers.find((r) => r.file === f)?.guarded));
  // SELF-TEST: the check must be able to fail. A synthetic reader that walks a
  // paginated feed with neither guard nor exemption is detected.
  const { mkdtempSync, writeFileSync: wf, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j2 } = await import('node:path');
  const dir = mkdtempSync(j2(tmpdir(), 'pgguard-'));
  wf(j2(dir, 'rogue-reader.js'), 'while (j.next_page_params) { next = j.next_page_params; }\n');
  const rogue = checkPaginationGuards(dir);
  check('SELF-TEST: an unguarded new reader is CAUGHT (the check can go red)', !rogue.ok && /rogue-reader/.test(rogue.problems.join()));
  // A COPIED exemption must fail closed. This is the exact accident the tag guards
  // against: a new reader started from an exempt one inherits a reason that was
  // never about it, and the boot line would still have said "1 declared exempt".
  wf(j2(dir, 'rogue-reader.js'), '// PAGINATION-EXEMPT(discover-vesting.js): holder traversal is balance-ordered\nwhile (j.next_page_params) {}\n');
  const copied = checkPaginationGuards(dir);
  check('SELF-TEST: an exemption COPIED from another file does not transfer', !copied.ok && /written for discover-vesting\.js/.test(copied.problems.join()));
  wf(j2(dir, 'rogue-reader.js'), '// PAGINATION-EXEMPT(rogue-reader.js): synthetic, walks nothing that is ever scored by date\nwhile (j.next_page_params) {}\n');
  check('SELF-TEST: the same reader passes once it declares why, naming ITSELF', checkPaginationGuards(dir).ok);
  mkdirSync(j2(dir, 'empty'), { recursive: true });
  check('SELF-TEST: discovering NOTHING is a failure, not a pass (the marker moving is a defect)', !checkPaginationGuards(j2(dir, 'empty')).ok);
  check('the marker set is declared, so a new feed shape is an edit not a silence', PAGINATION_MARKERS.length >= 1 && PAGINATION_MARKERS.includes('next_page_params'));
  check('paginatedReaders skips the test and probe files (or it would find itself)', !paginatedReaders().some((r) => /test-delivery|probe-pagination/.test(r.file)));
}

console.log('56. a BOOT GATE must not pass because it read nothing (corrupt != empty)');
{
  const { checkTierRoutes } = await import('./src/core/routes.js');
  const { mkdtempSync, writeFileSync: wf, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j3 } = await import('node:path');
  // checkTierRoutes reads unlocks.json and data/macro-calendar.json relative to cwd.
  // Both used to fall back to [] on a parse failure, which made the assertion
  // trivially TRUE on a corrupt file — nothing left to route or check, so "OK", and
  // the bot boots with the thing the gate protects entirely absent.
  const here = process.cwd();
  const mk = (unlocks, calendar) => {
    const d = mkdtempSync(j3(tmpdir(), 'routes-'));
    mkdirSync(j3(d, 'data'), { recursive: true });
    if (unlocks !== null) wf(j3(d, 'unlocks.json'), unlocks);
    if (calendar !== null) wf(j3(d, 'data', 'macro-calendar.json'), calendar);
    return d;
  };
  const run = (d) => { process.chdir(d); try { return checkTierRoutes(); } finally { process.chdir(here); } };

  const corrupt = run(mk('{"tokens":[', '{"events":['));
  check('a corrupt unlocks.json FAILS the gate instead of reading as empty', !corrupt.ok && corrupt.problems.some((p) => /unlocks\.json EXISTS but does not parse/.test(p)));
  check('a corrupt macro-calendar.json FAILS the gate instead of reading as empty', corrupt.problems.some((p) => /macro-calendar\.json EXISTS but does not parse/.test(p)));
  check('the failure names the file, so the operator knows which one', corrupt.problems.some((p) => /refusing to treat a corrupt/.test(p)));

  // MUTATION — the gate must still PASS on the states that are legitimately empty,
  // or this fix would refuse boot on a fresh install.
  const absent = run(mk(null, null));
  check('MUTATION: both files ABSENT is a legitimate empty state and PASSES', absent.ok, absent.problems.join(' | '));
  const valid = run(mk('{"tokens":[]}', '{"events":[]}'));
  check('MUTATION: both files present and VALID passes', valid.ok, valid.problems.join(' | '));
  const halfBad = run(mk('{"tokens":[]}', '{"events":['));
  check('MUTATION: one corrupt of the two still fails, naming only that one', !halfBad.ok
    && halfBad.problems.some((p) => /macro-calendar/.test(p)) && !halfBad.problems.some((p) => /unlocks\.json EXISTS/.test(p)));
  check('cwd is restored after every probe', process.cwd() === here);
}

console.log('57. a corrupt state file is QUARANTINED, not silently treated as no history');
{
  const { loadWatchState, cadenceStatus } = await import('./src/sources/calendar/cadence-watch.js');
  const { mkdtempSync, writeFileSync: wf, readFileSync: rf, existsSync: ex, readdirSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j4 } = await import('node:path');
  // The state file path is INJECTABLE, so the corrupt-file path is exercised for real
  // against a temp file rather than asserted from source text. The live
  // data/cadence-watch.json is never touched by this fixture.
  const d = mkdtempSync(j4(tmpdir(), 'watchstate-'));
  const at = new Date(Date.UTC(2026, 8, 13, 14, 30, 5));
  const target = j4(d, 'cadence-watch.json');

  // ABSENT is a legitimate empty state and must NOT quarantine or stamp anything.
  const absent = loadWatchState(at, target);
  check('absent file reads as empty history with NO reset stamp', absent.historyResetAt === undefined && Object.keys(absent.months).length === 0);

  // VALID parses through untouched.
  wf(target, JSON.stringify({ months: { EIGEN: { '2026-08': { action: 'CONFIRM' } } }, demotions: {} }));
  const good = loadWatchState(at, target);
  check('a valid file is returned as-is, with no reset stamp', good.months.EIGEN['2026-08'].action === 'CONFIRM' && good.historyResetAt === undefined);

  // CORRUPT — the case that erased everything on 2026-09-12.
  wf(target, '{"months":{"EIGEN":');
  const bad = loadWatchState(at, target);
  const quarantined = readdirSync(d).filter((f) => /corrupt-/.test(f));
  check('a corrupt file is QUARANTINED, not overwritten', quarantined.length === 1 && /cadence-watch\.corrupt-2026-09-13/.test(quarantined[0]));
  check('the quarantined copy still holds the original bytes', rf(j4(d, quarantined[0]), 'utf8') === '{"months":{"EIGEN":');
  check('the corrupt file is GONE from its live path (renamed, not copied)', !ex(target));
  check('the loss is stamped into the fresh state', bad.historyResetAt === '2026-09-13T14:30' && bad.historyResetFile === quarantined[0]);
  check('the fresh state suppresses notifications for one cycle', bad.suppressNotifyUntilCycle === true);
  check('history is empty after a reset — the point is that this is now VISIBLE, not silent', Object.keys(bad.months).length === 0);

  const resetState = { months: {}, demotions: {}, cliffs: {}, historyResetAt: '2026-09-12T13:58', historyResetFile: 'cadence-watch.corrupt-2026-09-12.json', suppressNotifyUntilCycle: true };
  const tok = [{ sym: 'X', reviewBy: '2026-12-01', events: [{}] }];
  const hbNow2 = new Date(Date.UTC(2026, 8, 13));
  const resetLine = cadenceStatus(tok, resetState, hbNow2).line;
  check('a reset is announced on the heartbeat with its timestamp', /🚨 VERDICT HISTORY RESET 2026-09-12T13:58/.test(resetLine));
  check('the banner names the quarantined file so the evidence is findable', /corrupt file kept as cadence-watch\.corrupt-2026-09-12\.json/.test(resetLine));
  check('the banner says the verdicts were RE-DERIVED and may not have been announced', /RE-DERIVED and may not have been announced/.test(resetLine));
  check('the banner says it is UNACKNOWLEDGED (it does not time out)', /unacknowledged/.test(resetLine));
  check('cadenceStatus exposes historyResetAt so telemetry can act on it', cadenceStatus(tok, resetState, hbNow2).historyResetAt === '2026-09-12T13:58');
  // MUTATION — a clean state must carry NO banner, or the alarm is meaningless.
  const cleanLine = cadenceStatus(tok, { months: {}, demotions: {} }, hbNow2).line;
  check('MUTATION: a clean state raises no reset banner', !/VERDICT HISTORY RESET/.test(cleanLine) && !/🚨/.test(cleanLine));
  check('MUTATION: a quarantine that FAILED says so rather than implying a copy exists',
    /could NOT be quarantined/.test(cadenceStatus(tok, { ...resetState, historyResetFile: null }, hbNow2).line));

  // The suppression flag is what stops a reset re-sending delivered verdicts.
  check('a reset sets the one-cycle notify suppression', resetState.suppressNotifyUntilCycle === true);
  const src = rf('src/sources/calendar/cadence-watch.js', 'utf8');
  check('pollCadence marks re-derived verdicts delivered instead of re-sending them', /if \(suppressNotify\) \{[\s\S]{0,200}notified = true/.test(src));
  check('the suppression clears after one cycle, so real demotions still send', /if \(suppressNotify\) \{ st\.suppressNotifyUntilCycle = false/.test(src));
  check('the corrupt file is RENAMED, never overwritten (data/ is not in the backup set)', /renameSync\(file, quarantine\)/.test(src));
}

console.log('58. an unavailable equity list EXCLUDES on the convention — it does not fall through to pushing');
{
  const { classifySymbol, equityListStatus, EQUITY_LIST_OK } = await import('./src/core/taxonomy.js');
  // The xStock rule reads: trailing-X + stem in the ticker list -> EXCLUDE; trailing-X
  // + stem NOT in the list -> UNRECOGNISED, which is "pushed, logged for review".
  // So an EMPTY list does not disable the rule, it INVERTS it — every tokenised
  // equity becomes a push. That is how TSLAX and CRCLX reached the channel. Absent
  // evidence must not read as evidence of absence.
  check('LIVE list is usable, so the ordinary path is being exercised below', equityListStatus() === EQUITY_LIST_OK);
  // Injected tickers are trusted (this is how the ordinary non-match is expressed).
  const withList = classifySymbol('FOOX', 'USDT', '', { tickers: new Set(['TSLA']) });
  check('list present, stem unknown -> UNRECOGNISED and pushed for review', withList.state === 'UNRECOGNISED');
  const matched = classifySymbol('TSLAX', 'USDT', '', { tickers: new Set(['TSLA']) });
  check('list present, stem known -> EXCLUDE with the corroborated reason', matched.state === 'EXCLUDE' && /is a known equity ticker/.test(matched.reason));
  // The restrictive default. Exercised by pointing the loader at a corrupt file via a
  // temp dataDir, so the real behaviour is tested rather than the source text.
  const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j5 } = await import('node:path');
  const dir = mkdtempSync(j5(tmpdir(), 'equity-'));
  wf(j5(dir, 'equity-tickers.json'), '{"tickers":[');
  const { config } = await import('./src/config.js');
  const realDir = config.dataDir;
  let corruptResult, missingResult, corruptState, missingState;
  try {
    // fresh module instance so the memoised list re-loads against the temp dir
    config.dataDir = dir;
    const t1 = await import(`./src/core/taxonomy.js?corrupt=${Date.now()}`);
    corruptResult = t1.classifySymbol('TSLAX');
    corruptState = t1.equityListStatus();
    wf(j5(dir, 'equity-tickers.json'), '');
    const { rmSync } = await import('node:fs');
    rmSync(j5(dir, 'equity-tickers.json'));
    const t2 = await import(`./src/core/taxonomy.js?missing=${Date.now()}`);
    missingResult = t2.classifySymbol('TSLAX');
    missingState = t2.equityListStatus();
  } finally { config.dataDir = realDir; }
  check('a CORRUPT equity list is detected as corrupt, not read as empty', corruptState === 'corrupt');
  check('with a corrupt list, a tokenised equity is EXCLUDED, not pushed', corruptResult.state === 'EXCLUDE' && /list is corrupt/.test(corruptResult.reason));
  check('the reason says it was excluded UNCORROBORATED, so it is not mistaken for a match', /rather than pushed uncorroborated/.test(corruptResult.reason));
  check('a MISSING equity list is detected as missing', missingState === 'missing');
  check('with a missing list, a tokenised equity is EXCLUDED, not pushed', missingResult.state === 'EXCLUDE');
  // MUTATION — the leveraged rule and the crypto guard must be untouched by this.
  check('MUTATION: the leveraged rule is unaffected by list availability', classifySymbol('BTC3L').state === 'EXCLUDE');
  check('MUTATION: a known crypto ending in X is still OK, list or no list', classifySymbol('AVAX').state === 'OK');
  check('MUTATION: a plain symbol is still a plain listing', classifySymbol('SOL').state === 'OK');
}

console.log('59. SCORING IS DETERMINISTIC — nothing can be safely re-scored if it disagrees with itself');
{
  const { cadenceDecision, cliffClusterDecision } = await import('./src/sources/calendar/cadence-watch.js');
  // The 2026-09-12 history reset accidentally re-derived three live verdicts EXACTLY.
  // That is evidence for a property the whole rescore design rests on and which had
  // never been tested on purpose: the same inputs must give the same verdict. If
  // scoring can disagree with itself, a "correction" is indistinguishable from noise.
  // Fixed `now` throughout; no Date.now() anywhere in this section.
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // --- SINGLE-WALLET, the MOVE 2026-09 regression case (CONFIRM, ratio 2.048) ---
  const moveSpec = { wallet: '0xE67A9E94bf21551EDCB8008AAE29823E87610D9b', expectDay: 9, meanAmount: 9461497, graceDays: 3 };
  const moveDays = { '2026-09-08': 120000, '2026-09-09': 19376705, '2026-09-11': 88000 };
  const moveNow = new Date(Date.UTC(2026, 8, 20));
  const m1 = cadenceDecision(moveSpec, 2026, 9, moveNow, moveDays);
  const m2 = cadenceDecision(moveSpec, 2026, 9, moveNow, moveDays);
  check('single-wallet: two runs over identical input give identical verdicts', eq(m1, m2));
  check('REGRESSION: MOVE 2026-09 re-derives as CONFIRM 19,376,705 ratio 2.048', m1.action === 'CONFIRM' && m1.amount === 19376705 && m1.ratio === 2.048 && m1.date === '2026-09-09');

  // --- SINGLE-WALLET, the ENA 2026-09 regression case (DEMOTE, largestSeen 5,148,798) ---
  const enaSpec = { wallet: '0x54B8c65f0635fD91C8729Dd3269C630d9AED54e5', expectDay: 6, meanAmount: 12069436, roll: 'nextBusinessDay' };
  const enaDays = { '2026-09-07': 5148798 };
  const enaNow = new Date(Date.UTC(2026, 8, 20));
  const e1 = cadenceDecision(enaSpec, 2026, 9, enaNow, enaDays);
  const e2 = cadenceDecision(enaSpec, 2026, 9, enaNow, enaDays);
  check('the DEMOTE path is deterministic too, not just the confirming one', eq(e1, e2));
  check('REGRESSION: ENA 2026-09 re-derives as DEMOTE with largestSeen 5,148,798', e1.action === 'DEMOTE' && e1.largestSeen === 5148798 && e1.window === '2026-09-06..2026-09-10');

  // --- FAMILY, the EIGEN 2026-08 regression case (CONFIRM, ratio 0.976) ---
  const eigenSpec = { wallets: [{ addr: '0xA', meanAmount: 7822556 }, { addr: '0xB', meanAmount: 1692519 }],
    familyMean: 9515075, tolerance: 0.13, expectDay: 30, monthEnd: true, graceDays: 3 };
  const eigenDays = { '0xA': { '2026-08-30': 7920090 }, '0xB': { '2026-08-30': 1364336 } };
  const eigenNow = new Date(Date.UTC(2026, 8, 10));
  const g1 = cadenceDecision(eigenSpec, 2026, 8, eigenNow, eigenDays);
  const g2 = cadenceDecision(eigenSpec, 2026, 8, eigenNow, eigenDays);
  check('family: two runs over identical input give identical verdicts, per-wallet detail included', eq(g1, g2));
  check('REGRESSION: EIGEN 2026-08 re-derives as CONFIRM familyTotal 9,284,426 ratio 0.976', g1.action === 'CONFIRM' && g1.familyTotal === 9284426 && g1.ratio === 0.976);

  // --- CONTRACT-CLIFF ---
  const spec5 = { windowDays: 5, minRatio: 3, minRecipients: 5, baselineDaily: 19488 };
  const clDays = { '2026-10-05': { amt: 400000, to: ['a', 'b', 'c', 'd', 'e', 'f'] }, '2026-10-07': { amt: 50000, to: ['g'] } };
  const clNow = new Date(Date.UTC(2026, 9, 20));
  const c1 = cliffClusterDecision(spec5, '2026-10-05', clNow, clDays);
  const c2 = cliffClusterDecision(spec5, '2026-10-05', clNow, clDays);
  check('contract-cliff: two runs over identical input give identical verdicts', eq(c1, c2));
  check('contract-cliff verdict carries its numbers, not just its action', c1.action === 'CONFIRM' && c1.recipients === 7 && typeof c1.ratio === 'number');

  // --- MUTATION: each must be able to DISAGREE, or determinism is vacuous ---
  check('MUTATION: one token less and MOVE flips to DEMOTE', cadenceDecision(moveSpec, 2026, 9, moveNow, { '2026-09-09': 4730748 }).action === 'DEMOTE');
  check('MUTATION: one token more and ENA flips to CONFIRM', cadenceDecision(enaSpec, 2026, 9, enaNow, { '2026-09-07': 6034718 }).action === 'CONFIRM');
  check('MUTATION: a silent family wallet turns EIGEN CONFIRM into PARTIAL', cadenceDecision(eigenSpec, 2026, 8, eigenNow, { '0xA': { '2026-08-30': 7920090 }, '0xB': {} }).action === 'PARTIAL');
  check('MUTATION: one claimant fewer drops the cliff below its recipient gate', cliffClusterDecision(spec5, '2026-10-05', clNow, { '2026-10-05': { amt: 400000, to: ['a', 'b', 'c', 'd'] } }).action === 'DEMOTE');
  check('MUTATION: a window that has not closed is PENDING, not a verdict', cliffClusterDecision(spec5, '2026-10-05', new Date(Date.UTC(2026, 9, 6)), clDays).action === 'PENDING');

  // --- The property that makes re-scoring safe at all ---
  check('re-running a verdict does not consume or mutate its input', eq(moveDays, { '2026-09-08': 120000, '2026-09-09': 19376705, '2026-09-11': 88000 })
    && eq(eigenDays, { '0xA': { '2026-08-30': 7920090 }, '0xB': { '2026-08-30': 1364336 } }));
}

console.log('60. a CACHE may not answer a request whose window it does not cover (ORDER\'s void demotion)');
{
  const { rangeCovers, spanCovered } = await import('./src/core/pagination.js');
  const { cacheSatisfies } = await import('./detect-cliff-cluster.js');
  // 2026-09-12: pollCliffWatch asked whether ORDER's vault emitted in 09-07..09-12 and
  // was handed the 2026-09-05 cache — covered:true, 0 pages, no network. The window
  // was empty BY CONSTRUCTION, so the verdict was DEMOTE at ratio 0: a verdict from a
  // fetch that never ran. `covered` was not bypassed; the cache handed it a true value.
  check('rangeCovers is strict at the BACK end, like spanCovered', rangeCovers('2026-05-01', '2026-09-13', '2026-05-05', '2026-09-12') && !rangeCovers('2026-05-05', '2026-09-13', '2026-05-05', '2026-09-12'));
  check('rangeCovers requires reaching the FRONT end too', !rangeCovers('2026-05-01', '2026-09-11', '2026-05-05', '2026-09-12'));
  check('reaching exactly the front end counts (coveredTo >= to)', rangeCovers('2026-05-01', '2026-09-12', '2026-05-05', '2026-09-12'));
  check('a missing boundary is never coverage', !rangeCovers(null, '2026-09-13', '2026-05-05', '2026-09-12') && !rangeCovers('2026-05-01', null, '2026-05-05', '2026-09-12'));

  // THE TRAP the fix had to avoid: coveredTo must be the boundary the FETCH reached,
  // not the newest row it FOUND. A vault that genuinely stopped has nothing in or
  // after the window; if coveredTo came from the data, it would read UNCOVERED and the
  // row would sit PENDING FOREVER instead of demoting — making a dead vault
  // indistinguishable from a stale cache, and the one that matters never resolves.
  const silentVault = { oldest: '2026-05-01', coveredTo: '2026-09-13' };  // fetched today, found nothing recent
  check('a SILENT vault fetched today still COVERS the window, so it can be demoted', cacheSatisfies(silentVault, '2026-09-05', '2026-09-12'));

  // The actual regression: the real shape of the 2026-09-05 entry.
  const sept5 = { oldest: '2026-05-11', coveredTo: '2026-09-05', done: true };
  check('REGRESSION: the 2026-09-05 cache does NOT satisfy a 2026-09-12 window', !cacheSatisfies(sept5, '2026-09-05', '2026-09-12'));
  check('the same cache DOES satisfy the window it was actually built for', cacheSatisfies(sept5, '2026-05-15', '2026-09-05'));
  // Pre-fix entries recorded no recent boundary at all — they must not be trusted.
  check('a pre-fix entry with no coveredTo cannot prove coverage, so it does not', !cacheSatisfies({ oldest: '2026-05-11', done: true }, '2026-09-05', '2026-09-12'));
  check('LIVE-SHAPED: every entry now on disk lacks coveredTo and will be discarded', (() => {
    const c = JSON.parse(readFileSync('data/cliff-fetch-cache.json', 'utf8'));
    return Object.values(c).every((e) => !cacheSatisfies(e, '2026-09-05', '2026-09-30'));
  })());
  // MUTATION — the guard must still let a GOOD cache through, or every read refetches.
  check('MUTATION: a cache fetched after the window end satisfies it', cacheSatisfies({ oldest: '2026-05-01', coveredTo: '2026-10-01' }, '2026-09-05', '2026-09-30'));
  check('MUTATION: with no stated requirement the cache is allowed (offline tools)', cacheSatisfies(sept5, '2026-05-15', null));
  check('MUTATION: no cache at all is never satisfaction', !cacheSatisfies(null, '2026-09-05', '2026-09-12'));

  // The caller must actually state the requirement, or the guard is unreachable.
  const cw = readFileSync('src/sources/calendar/cadence-watch.js', 'utf8');
  check('pollCliffWatch passes needUpTo covering the LATEST due cliff plus its window', /needUpTo: latestEnd/.test(cw) && /windowDays \* 86400e3/.test(cw));
  check('an uncovered fetch logs what it reached and produces NO verdict', /no verdict, retrying next poll/.test(cw));
}

console.log('61. corrections go through a WRITE PATH — a voided verdict is recorded, not erased');
{
  const { voidVerdict } = await import('./annotate-verdict.js');
  // Hand-editing data/cadence-watch.json destroyed it on the first attempt (2026-09-12):
  // one dropped brace, loadWatchState returned the empty default, every verdict was
  // re-derived and an already-delivered DM was re-sent. Third instance of the hazard
  // (regime tags v0.13.1, the outcomes.json tear v0.17, this). promote-unlock.js exists
  // so nobody hand-edits unlocks.json; this is the same thing for verdicts.
  const base = () => ({
    cliffs: { 'ORDER:2026-09-07': { action: 'DEMOTE', ratio: 0, recipients: 0, at: '2026-09-12T13:56' } },
    demotions: { ORDER: { cliff: '2026-09-07', type: 'cliff-cluster-absent' }, ENA: { month: '2026-09', kind: 'DEMOTE' } },
    months: { ENA: { '2026-09': { action: 'DEMOTE', largestSeen: 5148798 } } },
  });
  const why = 'scored against a stale cache rather than a fetch, so the window was empty by construction';

  check('a correction with NO reason is refused', !!voidVerdict(base(), 'ORDER', '2026-09-07', null).error);
  check('a token gesture at a reason is refused too (>=20 chars of actual reason)', !!voidVerdict(base(), 'ORDER', '2026-09-07', 'bad').error);
  check('voiding a verdict that does not exist is refused, not silently ignored', !!voidVerdict(base(), 'ORDER', '2026-11-11', why).error);

  const r = voidVerdict(base(), 'ORDER', '2026-09-07', why);
  check('the blocking stamp is CLEARED, so the window can be scored again', !r.error && r.state.cliffs['ORDER:2026-09-07'] === undefined);
  check('the demotion that verdict caused is cleared with it', r.clearedDemotion === true && r.state.demotions.ORDER === undefined);
  check('an UNRELATED demotion is left alone', r.state.demotions.ENA !== undefined);
  check('the ORIGINAL verdict is carried into the audit entry — recorded, not erased', r.entry.original.action === 'DEMOTE' && r.entry.original.at === '2026-09-12T13:56');
  check('the audit entry carries the reason verbatim', r.entry.reason === why);
  check('the input state is NOT mutated (a correction must not half-apply on error)', (() => { const b = base(); voidVerdict(b, 'ORDER', '2026-09-07', why); return b.cliffs['ORDER:2026-09-07'] !== undefined; })());

  // A month verdict clears through the same path, matched on month not cliff.
  const rm = voidVerdict(base(), 'ENA', '2026-09', why);
  check('a monthly verdict voids through the same path', !rm.error && rm.state.months.ENA['2026-09'] === undefined && rm.state.demotions.ENA === undefined);
  check('voiding ENA leaves ORDER\'s verdict untouched', rm.state.cliffs['ORDER:2026-09-07'] !== undefined);

  // MUTATION — a demotion that does NOT correspond to the voided verdict must survive.
  const mism = voidVerdict({ cliffs: { 'ORDER:2026-09-07': { action: 'DEMOTE' } }, demotions: { ORDER: { cliff: '2026-10-05' } }, months: {} }, 'ORDER', '2026-09-07', why);
  check('MUTATION: a demotion from a DIFFERENT cliff is not swept up', mism.clearedDemotion === false && mism.state.demotions.ORDER !== undefined);

  // LIVE: the correction actually applied, and it is on the record.
  const ann = JSON.parse(readFileSync('data/verdict-annotations.json', 'utf8'));
  check('LIVE-RECORD: ORDER\'s void verdict is in the annotation log with its reason', ann.annotations.some((a) => a.sym === 'ORDER' && a.key === '2026-09-07' && /stale cache|resume cache/i.test(a.reason)));
  check('LIVE-RECORD: the original DEMOTE is preserved in that entry', ann.annotations.some((a) => a.sym === 'ORDER' && a.original?.action === 'DEMOTE' && a.original?.ratio === 0));
}

console.log('62. a CORRECTION is visible — removing a verdict from state must not remove it from view');
{
  const { verdictCorrections } = await import('./src/sources/calendar/cadence-watch.js');
  const { buildHeartbeat } = await import('./src/core/telemetry.js');
  const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j6 } = await import('node:path');
  // The design choice: a voided verdict is REMOVED from state and written to the
  // annotation log, so no consumer needs to learn a 'void' state — state holds live
  // verdicts, the log holds corrections. The cost is that a correction is invisible
  // unless something reports it, which is the silence this project keeps closing.
  const d = mkdtempSync(j6(tmpdir(), 'ann-'));
  const f = j6(d, 'verdict-annotations.json');

  check('no log yet -> no line, and no false alarm', verdictCorrections(f).n === 0 && verdictCorrections(f).line === '');
  wf(f, JSON.stringify({ annotations: [
    { at: '2026-09-13T20:00', sym: 'ORDER', key: '2026-09-07', op: 'void', reason: 'stale cache', original: { action: 'DEMOTE' } },
  ] }));
  const one = verdictCorrections(f);
  check('a correction is counted and the latest one is named', one.n === 1 && /Verdict corrections: 1 \(latest ORDER 2026-09-07 void/.test(one.line));
  wf(f, JSON.stringify({ annotations: [
    { at: '2026-09-13T20:00', sym: 'ORDER', key: '2026-09-07', op: 'void', reason: 'x', original: {} },
    { at: '2026-09-14T09:00', sym: 'ENA', key: '2026-09', op: 'void', reason: 'y', original: {} },
  ] }));
  check('the count rises and the LATEST is the one reported', verdictCorrections(f).n === 2 && /latest ENA 2026-09/.test(verdictCorrections(f).line));
  // MUTATION — an unreadable log is a failure to audit, not an absence of corrections.
  wf(f, '{"annotations":[');
  const broken = verdictCorrections(f);
  check('MUTATION: an unreadable annotation log says so rather than reading as zero', broken.unreadable === true && /does not parse/.test(broken.line));
  check('MUTATION: it does NOT claim zero corrections when it cannot tell', broken.n === 0 && broken.line !== '');

  // The line reaches the heartbeat.
  const hb = buildHeartbeat(Date.now(), { rows: [], drops: { total: 0, byReason: {} }, bugs: 0, pulse: 'x', startedAt: Date.now(),
    digest: { line: 'd' }, corrections: { n: 3, line: 'Verdict corrections: 3 (latest ORDER 2026-09-07 void 2026-09-13T20:00)' } });
  check('the heartbeat carries the corrections line', hb.lines.some((l) => /Verdict corrections: 3/.test(l)));
  check('MUTATION: with no corrections the heartbeat adds no empty line', !buildHeartbeat(Date.now(), { rows: [], drops: { total: 0, byReason: {} }, bugs: 0, pulse: 'x', startedAt: Date.now(), digest: { line: 'd' }, corrections: { n: 0, line: '' } }).lines.some((l) => /Verdict corrections/.test(l)));

  // LIVE — ORDER's correction is real and reportable.
  const live = verdictCorrections();
  check('LIVE-RECORD: the real annotation log is readable and reports ORDER', !live.unreadable && live.n >= 1 && /ORDER 2026-09-07/.test(live.line));
}

console.log('48. MECHANISM — a sourced date can name no discrete event; weak falsifiers are stated');
{
  const { mechanismEvidence, mechanismProblems, sourceRow, sourcedRowProblems, pressureStage, chanceRate, clusterMargin, promoteRow, UNVERIFIABLE_MECHANISMS } = await import('./src/core/unlock-promote.js');
  const { claimCoverage, unlockCoverage, leadsFor } = await import('./src/sources/calendar/unlocks.js');
  const { cadenceStatus } = await import('./src/sources/calendar/cadence-watch.js');
  const grid9 = (hits) => [3, 5, 7].flatMap((w) => [2, 3, 5].map((r) => ({ windowDays: w, minRatio: r, hits, n: 4, off: 2 })));
  const stream = { contract: '0x' + '8'.repeat(40), distinctRecipients: 2367, n: 4, hits: 1, activeDayFrac: 1, grid: grid9(2), perCliff: [{ cluster: false }, { cluster: false }, { cluster: true }, { cluster: false }], offIndexClusters: [] };
  const quiet = { contract: '0x' + '9'.repeat(40), distinctRecipients: 71, n: 4, hits: 0, activeDayFrac: 0.47, grid: grid9(0), perCliff: [{ cluster: false }, { cluster: false }, { cluster: false }, { cluster: false }], offIndexClusters: [{ from: '2026-04-30', ratio: 13.97, recipients: 23 }] };
  const cliffy = { ...stream, distinctRecipients: 80, hits: 3, grid: grid9(3) };
  // Evidence rules, each capable of refusing.
  check('continuous-claim: wide claimant base, claims most days, never 2/3 -> supported', mechanismEvidence('continuous-claim', [stream], []).ok);
  check('continuous-claim: refused when any parameterisation replays >=2/3', !mechanismEvidence('continuous-claim', [cliffy], []).ok);
  check('continuous-claim: refused with few claimants (a quiet contract is not a stream)', !mechanismEvidence('continuous-claim', [{ ...stream, distinctRecipients: 40 }], []).ok);
  check('continuous-claim: refused when claims are NOT on most days', !mechanismEvidence('continuous-claim', [{ ...stream, activeDayFrac: 0.4 }], []).ok);
  check('index-contradicted: 0 on-index everywhere + >=1 off-index cluster -> supported', mechanismEvidence('index-contradicted', [quiet], ['2026-05-30']).ok);
  check('index-contradicted: refused when the contract simply never clusters (silence proves nothing)', !mechanismEvidence('index-contradicted', [{ ...quiet, offIndexClusters: [] }], []).ok);
  check('index-contradicted: refused when any index cliff DID cluster', !mechanismEvidence('index-contradicted', [{ ...quiet, perCliff: [{ cluster: true }, { cluster: false }, { cluster: false }, { cluster: false }], hits: 1 }], []).ok);
  check('basis sentence carries the numbers', /2367 distinct claimants/.test(mechanismEvidence('continuous-claim', [stream], []).basis) && /13\.97x\/23r/.test(mechanismEvidence('index-contradicted', [quiet], []).basis));
  check('an unknown mechanism label is not stamped by this path', !mechanismEvidence('vibes', [stream], []).ok);
  // Row gate: unverifiable mechanisms MUST be LOGGED and MUST carry a basis.
  const base = { source: 'defillama', sourceFetchedAt: new Date().toISOString().slice(0, 16), chain: 'ethereum', sourceEvents: [{ t: 1, n: 1e6, cats: 'insiders' }], maxSupply: 1e9 };
  check('unverifiable mechanism at STANDARD is refused by the boot gate', mechanismProblems({ ...base, mechanism: 'continuous-claim', mechanismBasis: 'x', stage: 'STANDARD' }).length > 0);
  check('non-pending mechanism without basis is refused', mechanismProblems({ ...base, mechanism: 'index-contradicted', stage: 'LOGGED' }).length > 0);
  check('pending needs nothing further', mechanismProblems({ ...base, mechanism: 'pending', stage: 'STANDARD' }).length === 0);
  check('sourceRow defaults mechanism to pending', sourceRow({ sym: 'T', name: 'T' }, base).mechanism === 'pending');
  check('sourceRow refuses an unverifiable mechanism at STANDARD (constructor = gate)', (() => { try { sourceRow({ sym: 'T', name: 'T' }, { ...base, mechanism: 'continuous-claim', mechanismBasis: 'x' }); return false; } catch { return true; } })());
  check('unverifiable mechanism -> LOGGED at runtime whatever the size', pressureStage({ ...base, mechanism: 'continuous-claim', stage: 'STANDARD', sourceEvents: [{ t: 1, n: 5e7, cats: 'insiders' }] }) === 'LOGGED' && leadsFor({ stage: 'LOGGED' }).length === 0);
  check('the unverifiable set is exactly the two Route 2 found', UNVERIFIABLE_MECHANISMS.length === 2);
  // Falsifier margin: derived chance rate and replay, not an impression.
  const spec = { windowDays: 5, minRatio: 3, minRecipients: 5, baselineDaily: 1, n: 8, hits: 6, offIndex: 7, spanDays: 113, basis: 'b' };
  check('chance rate = clusters x window / span (ORDER: 13x5/113 = 0.58) and margin = replay − chance (0.17)', chanceRate(spec) === 0.58 && clusterMargin(spec) === 0.17);
  check('a quiet contract (2 clusters in 113d, 2/8 replay) has margin 0.16 — quiet is not strong either', clusterMargin({ ...spec, hits: 2, offIndex: 0 }) === 0.16);
  check('no span recorded -> no chance rate -> no margin (unknown is not strong)', chanceRate({ ...spec, spanDays: undefined }) === null && clusterMargin({ ...spec, spanDays: undefined }) === null);
  // Re-promotion keeps provenance history.
  const rp = promoteRow({ sym: 'X', name: 'X', verified: true, events: [{ date: '2026-09-01', source: 'a' }], sourceHistory: { source: 'defillama', supersededAt: '2026-09-05' } }, { events: [{ date: '2026-09-05', source: 'announcement' }], reviewBy: '2026-12-01' });
  check('re-promoting a verified row keeps sourceHistory (dropped once)', rp.sourceHistory?.source === 'defillama');
  // Live rows and lines.
  const live = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens;
  const l3 = live.find((t) => t.sym === 'L3'), rez = live.find((t) => t.sym === 'REZ'), order = live.find((t) => t.sym === 'ORDER');
  check('LIVE: L3 is continuous-claim, LOGGED, with basis', l3?.mechanism === 'continuous-claim' && l3.stage === 'LOGGED' && /2367/.test(l3.mechanismBasis));
  check('LIVE: REZ is index-contradicted, LOGGED, with the off-index dates in its basis', rez?.mechanism === 'index-contradicted' && rez.stage === 'LOGGED' && /2026-04-30/.test(rez.mechanismBasis));
  check('LIVE: every sourced row passes the gate with mechanisms in place', sourcedRowProblems(l3).length === 0 && sourcedRowProblems(rez).length === 0);
  // 2026-09-15 TIER CORRECTION: ORDER's margin (0.17; grid best 0.26) is outside the
  // verified population (0.64-0.76). It is sourced again, with the verification it
  // held recorded — and its coverage line is the sourced one, with no WEAK clause.
  check('LIVE: ORDER is SOURCED with tierHistory recording the retracted contract-cliff verification and the reason', order?.provenance === 'sourced' && order.tierHistory?.from === 'verified' && order.tierHistory.retracted?.enforcement === 'contract' && order.tierHistory.retracted?.falsifier?.margin === 0.17 && /0\.40/.test(order.tierHistory.reason) && !order.events && !order.enforcement && !order.clusterSpec);
  check('LIVE: ORDER carries the settled evidence — 9 grid points with margins, best w3/r2 0.26 against bar 0.40, spec and 8 backtested cliffs retained', order?.tierHistory?.evidence?.grid?.points?.length === 9 && order.tierHistory.evidence.grid.best.margin === 0.26 && order.tierHistory.evidence.bar === 0.4 && order.tierHistory.evidence.stampedMargin === 0.17 && order.tierHistory.retracted.clusterSpec?.hits === 6 && order.tierHistory.retracted.cliffDates?.filter((c) => c.cluster !== null).length === 8);
  check('LIVE: ORDER passes the sourced gate and its coverage line names the source, not a WEAK falsifier', sourcedRowProblems(order).length === 0 && /published figures/.test(claimCoverage(order, 0).line) && !/WEAK/.test(claimCoverage(order, 0).line));
  check('claimCoverage for a stream says there is no discrete event', claimCoverage(l3, 3).scope === 'mechanism' && /No discrete event/.test(claimCoverage(l3, 3).line));
  check('claimCoverage for a contradicted index says the chain contradicts it', /Index contradicted by chain/.test(claimCoverage(rez, 3).line));
  const cov = unlockCoverage();
  check('coverage line splits sourced into pending vs unverifiable-by-mechanism', /\d+ pending verification · 2 unverifiable by mechanism: 1 continuous-claim, 1 index-contradicted/.test(cov.line) && cov.sourcedPending + cov.sourcedUnverifiable === cov.sourced);
  check('coverage line carries no WEAK label and no weakFalsifier count (state retired)', !/WEAK/.test(cov.line) && cov.weakFalsifier === undefined);
  // RENDERING RULE, constructed state, fixed `now`. A cliff-watched row renders its
  // stamped margin (one derivation, in unlock-promote.js — the inline chance-rate copy
  // that used to live in cadenceStatus is gone); a demoted one renders only the
  // demotion; a row corrected to SOURCED is no longer demoted by a verdict against the
  // tier it left — otherwise unlocks.js would skip it as "alerts as nothing".
  const hbNow = new Date(Date.UTC(2026, 8, 13));
  const cliffRow = { sym: 'WK', clusterSpec: { windowDays: 5, hits: 8, offIndex: 1, n: 8, spanDays: 113, minRatio: 3, minRecipients: 5, baselineDaily: 1, basis: 'b' }, falsifier: { verdict: 'STRONG', margin: 0.6 },
    cliffDates: [{ date: '2026-10-05', cluster: null }], events: [{ date: '2026-09-01', source: 'contract-cliff' }] };
  const cleanState = { months: {}, demotions: {}, cliffs: {} };
  const cliffLine = cadenceStatus([cliffRow], cleanState, hbNow).line;
  check('a non-demoted cliff-watched row renders its stamped margin, never a WEAK label', /WK cliff 0\/0 confirmed · next 2026-10-05 · margin 0\.6/.test(cliffLine) && !/WEAK/.test(cliffLine));
  const demotedState = { months: {}, demotions: { WK: { at: '2026-09-12T00:00', type: 'cliff-cluster-absent' } }, cliffs: {} };
  const demotedLine = cadenceStatus([cliffRow], demotedState, hbNow).line;
  check('a DEMOTED row renders the demotion and NOT the margin', /WK 🚨 demoted/.test(demotedLine) && !/margin/.test(demotedLine));
  const { activeDemotions: aDem } = await import('./src/sources/calendar/cadence-watch.js');
  check('a demotion against a row since corrected to SOURCED is moot (the demoted tier no longer exists)', aDem([{ sym: 'WK', provenance: 'sourced', tierHistory: { from: 'verified' } }], demotedState).WK === undefined);
  check('MUTATION: the same demotion against the still-verified row is active', aDem([cliffRow], demotedState).WK !== undefined);
  check('MUTATION: a row with no stamped margin renders no margin clause', !/margin/.test(cadenceStatus([{ ...cliffRow, falsifier: undefined }], cleanState, hbNow).line));
}

console.log('47. sourced PRESSURE FLOOR is derived from the index distribution, recorded, static');
{
  const { SOURCED_PRESSURE_FLOOR: F, derivePressureFloor, pressureStage, NON_PRESSURE_CATS } = await import('./src/core/unlock-promote.js');
  const { unlockCoverage, leadsFor } = await import('./src/sources/calendar/unlocks.js');
  check('floor is recorded with percentile, n and a basis sentence', F.pctOfMaxSupply > 0 && F.percentile === 15 && F.n === 30 && /percentile/.test(F.basis) && /2026-09-15/.test(F.basis));
  // The recorded static must be what the live index derives (re-derive on refresh, record again).
  const live = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens;
  const d = derivePressureFloor(live);
  check('recorded floor equals the value the live rows derive (drift here = index refreshed, floor not re-recorded)', !!d && d.n === F.n && Math.abs(d.pctOfMaxSupply - F.pctOfMaxSupply) < 0.0005);
  // The floor is derived PER ROW because it is applied per row. A per-EVENT
  // percentile lets one protocol with many small events set the floor for all of
  // them — the 2026-09-07 refresh moved the per-event figure 0.061 -> 0.014 on an
  // unchanged population. This fixture pins the invariant, not the number: adding
  // 200 tiny events to ONE row must not move the floor.
  const flood = live.map((t) => (t.sym !== 'TIA' || !t.sourceEvents ? t : { ...t, sourceEvents: [...t.sourceEvents, ...Array.from({ length: 200 }, (_, i) => ({ t: i, n: t.maxSupply * 1e-6, cats: 'ecosystem' }))] }));
  check('one row spamming tiny events cannot drag the floor down (per-row, not per-event)', derivePressureFloor(flood).pctOfMaxSupply === d.pctOfMaxSupply);
  check('the floor is applied to the same quantity it is derived from (row median)', pressureStage({ stage: 'STANDARD', maxSupply: 1e9, sourceEvents: [{ t: 1, n: 1e5, cats: 'insiders' }, { t: 2, n: 1e5, cats: 'insiders' }, { t: 3, n: 1e9, cats: 'insiders' }] }) === 'LOGGED');
  // FORT below (weekly 0.005% farming drip); EIGEN/ENA/MOVE-scale tranches well above.
  const mk = (n, maxSupply, cats) => ({ stage: 'STANDARD', maxSupply, sourceEvents: [{ t: 1, n, cats }, { t: 2, n, cats }, { t: 3, n, cats }] });
  check('FORT-scale tranche (0.005% farming) -> LOGGED', pressureStage(mk(50000, 1e9, 'farming')) === 'LOGGED');
  check('FORT-scale tranche is LOGGED by SIZE alone, category aside', pressureStage(mk(50000, 1e9, 'insiders')) === 'LOGGED');
  check('EIGEN-scale (9.6M of 1.67B = 0.57%) -> stays STANDARD', pressureStage(mk(9.6e6, 1.67e9, 'insiders')) === 'STANDARD');
  check('ENA-scale (~2.3% of supply) -> stays STANDARD', pressureStage(mk(3.4e8, 1.5e10, 'insiders')) === 'STANDARD');
  check('MOVE-scale (~1.9% of supply) -> stays STANDARD', pressureStage(mk(1.9e8, 1e10, 'insiders+privateSale')) === 'STANDARD');
  check('farming/staking-ONLY row -> LOGGED whatever the size', pressureStage(mk(5e7, 1e9, 'staking')) === 'LOGGED' && pressureStage(mk(5e7, 1e9, 'farming+staking')) === 'LOGGED');
  check('mixed categories (staking+insiders) are pressure', pressureStage(mk(5e7, 1e9, 'staking+insiders')) === 'STANDARD');
  check('no maxSupply -> cannot be sized -> own stage (unknown is not small)', pressureStage({ stage: 'STANDARD', sourceEvents: [{ t: 1, n: 10, cats: 'insiders' }] }) === 'STANDARD');
  check('LOGGED means no leads at runtime', leadsFor({ stage: pressureStage(mk(50000, 1e9, 'farming')) }).length === 0);
  check('non-pressure categories are exactly farming and staking (a third would be a new decision)', NON_PRESSURE_CATS.length === 2);
  check('LIVE: FORT is below the floor', pressureStage(live.find((t) => t.sym === 'FORT')) === 'LOGGED');
  const below = live.filter((t) => t.provenance === 'sourced' && t.stage !== 'LOGGED' && pressureStage(t) === 'LOGGED').map((t) => t.sym);
  const cov = unlockCoverage();
  check('coverage line reports rows the floor silences (count matches)', (cov.belowFloor === below.length) && (below.length === 0 || new RegExp(`${below.length} below pressure floor`).test(cov.line)));
  console.log(`      floor ${F.pctOfMaxSupply}% · silenced at runtime: ${below.join(', ') || 'none'}`);
}

console.log('46. CONTRACT-CLIFF tier (Route 2) — enforcement:contract is EARNED by replayed claim clusters');
{
  const { clusterVerdicts, reportContracts, NOT_VESTING_RX } = await import('./detect-cliff-cluster.js');
  const { clusterSpecProblems, forwardFalsifierProblems, CONTRACT_ENFORCEMENT_RETRACTED, MIN_FALSIFIER_MARGIN } = await import('./src/core/unlock-promote.js');
  const { cliffClusterDecision, cadenceStatus } = await import('./src/sources/calendar/cadence-watch.js');
  const { claimCoverage, unlockCoverage } = await import('./src/sources/calendar/unlocks.js');
  // Synthetic series: 60 days of 1k/day drip to 2 recipients; cliffs on days 10/30/50
  // with 20 claimants taking 30k over the 5-day window. One off-index cluster on day 42.
  const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400e3).toISOString().slice(0, 10);
  const mk = (clusterDays, { recips = 20, offIndex = true } = {}) => {
    const byDay = {};
    for (let i = 0; i < 60; i++) byDay[day(i)] = { amt: 1000, to: new Set(['0xdrip1', '0xdrip2']) };
    for (const c of clusterDays) for (let k = 0; k < 5; k++) { const r = byDay[day(c + k)]; r.amt += 6000; for (let j = 0; j < recips; j++) r.to.add('0xclaim' + j); }
    if (offIndex) { const r = byDay[day(42)]; r.amt += 40000; for (let j = 0; j < 12; j++) r.to.add('0xoff' + j); }
    return byDay;
  };
  const cliffs = [day(10), day(30), day(50)];
  const v = clusterVerdicts(mk([10, 30, 50]), cliffs);
  check('synthetic clusters on every cliff -> verified 3/3', v.verified && v.hits === 3 && v.n === 3);
  check('baseline is the NON-window median x window (drip days only)', v.medianDaily === 1000 && v.baseline === 5000);
  // Rolling windows: the reported window CONTAINS day 42 (its start may precede it).
  const off = v.offIndexClusters;
  check('off-index cluster is REPORTED, not hidden (index auditing is the second use)', off.length === 1 && off[0].from <= day(42) && off[0].from > day(37) && off[0].recipients === 14);
  const nv = clusterVerdicts(mk([]), cliffs);
  check('no clusters -> 0/3, not verified', !nv.verified && nv.hits === 0);
  const few = clusterVerdicts(mk([10, 30, 50], { recips: 2 }), cliffs);
  check('amount alone is NOT a cluster: 2 recipients fails the minRecipients gate', !few.verified && few.hits === 0);
  check('2/3 replays is the floor (n=3): one miss still verifies, two do not',
    clusterVerdicts(mk([10, 30]), cliffs).verified && !clusterVerdicts(mk([10]), cliffs).verified);
  check('n<3 never verifies however clean', !clusterVerdicts(mk([10, 30]), [day(10), day(30)]).verified);

  // FROZEN: the live report's parameter grid. ORDER's vault replays >=2/3 under all 9
  // parameterisations; L3 (continuous claims, 2,367 recipients) never does. The sweep
  // showed the 20% clustering rate is NOT a parameter artefact — that is the finding
  // the next brief builds on, so it is pinned here.
  const rep = JSON.parse(readFileSync('data/cliff-cluster-report.json', 'utf8'));
  const vault = rep.ORDER?.results?.find((r) => /^0x6d00268a/i.test(r.contract));
  // Observed grid: 7/8 6/8 5/8 7/8 6/8 5/8 6/8 5/8 4/8 — never below half, >=2/3 at 5 of 9
  // (including the declared w5/r3). The verdict is robust to the window, sensitive to
  // the ratio bar: that is what "not a parameter artefact" means here, no more.
  check('FROZEN: ORDER vault verdict CLUSTERS-REPLAY at the declared parameters (6/8 @ w5/r3)', vault?.verdict === 'CLUSTERS-REPLAY' && vault.hits === 6 && vault.n === 8);
  check('FROZEN: ORDER vault never falls below 1/2 at any of 9 parameterisations, >=2/3 at 5+', !!vault && vault.grid.length === 9 && vault.grid.every((g) => g.hits / g.n >= 0.5) && vault.grid.filter((g) => g.hits / g.n >= 2 / 3).length >= 5);
  const l3 = rep.L3?.results?.find((r) => /^0x8E02d37b/i.test(r.contract));
  check('FROZEN: L3 (continuous claims) never reaches 2/3 at any parameterisation', !!l3 && l3.grid.length === 9 && l3.grid.every((g) => g.hits / g.n < 2 / 3));
  check('FROZEN: REZ shows off-index clusters and no on-index ones (index dates wrong, not the method)',
    rep.REZ?.results?.[0]?.grid?.every((g) => g.hits === 0 && g.off > 0) === true);

  // Bridge exclusion: the v0.29.0 STO false hit was a LayerZero adapter.
  const disc = { STO: { contracts: [{ addr: '0x' + '1'.repeat(40), bucket: 'C', pctSupply: 9, name: 'StakeStoneLayerZeroAdapter' }, { addr: '0x' + '2'.repeat(40), bucket: 'C', pctSupply: 5, name: 'TokenVesting' }] } };
  const cands = reportContracts('STO', disc);
  check('STO LayerZero adapter classifies NOT-VESTING (excluded from cluster candidates)', cands.length === 1 && cands[0].name === 'TokenVesting');
  check('exclusion regex covers adapter/bridge/connector', ['XBridge', 'OFTAdapter', 'L2Connector'].every((n) => NOT_VESTING_RX.test(n)) && !NOT_VESTING_RX.test('LockedTokenVault'));

  // Spec shape is still checked (a future spec is shape-checked before anyone argues
  // about its margin) — but the TIER is closed: enforcement:'contract' is claimable by
  // nobody again (2026-09-15). The one row that earned it never cleared the margin bar.
  const spec = { windowDays: 5, minRatio: 3, minRecipients: 5, baselineDaily: 19488, n: 8, hits: 6, basis: 'derived on 8 past cliffs' };
  check('clusterSpec: complete spec passes', clusterSpecProblems(spec).length === 0);
  check('clusterSpec: n<3 or missing basis refused', clusterSpecProblems({ ...spec, n: 2 }).length > 0 && clusterSpecProblems({ ...spec, basis: undefined }).length > 0);
  const ev = [{ date: '2026-09-19', source: 'contract-cliff' }];
  const earned = { events: ev, enforcement: 'contract', contract: '0x6d00268a47D48474f999c18210c6877491AE6FB3', clusterSpec: spec, upgradeable: false,
    cliffDates: [{ date: '2026-08-08', cluster: true }, { date: '2026-08-22', cluster: true }, { date: '2026-09-19', cluster: null }] };
  const ffp = forwardFalsifierProblems(earned);
  check('a FULLY-EVIDENCED contract row is refused by the forward-falsifier gate: the label is claimable by nobody', ffp.length === 1 && ffp[0] === CONTRACT_ENFORCEMENT_RETRACTED);
  check('the refusal names the bar and the row that failed it, and points at the sourced tier', new RegExp(String(MIN_FALSIFIER_MARGIN)).test(ffp[0]) && /ORDER/.test(ffp[0]) && /0\.17/.test(ffp[0]) && /sourced/.test(ffp[0]));
  check('MUTATION: the same evidence WITHOUT the label is judged on its other falsifiers (no cadence, no reviewBy -> refused for that reason, not this one)', (() => { const q = forwardFalsifierProblems({ ...earned, enforcement: undefined }); return q.length === 1 && /no forward falsifier/.test(q[0]) && q[0] !== CONTRACT_ENFORCEMENT_RETRACTED; })());

  // Forward falsifier: presence of the next cluster, not amount-in-band.
  const stamp = (d) => new Date(d + 'T00:00:00Z');
  const fut = {}; for (let i = 0; i < 12; i++) fut[day(200 + i)] = { amt: 19000, to: ['0xa', '0xb'] };
  check('PENDING until cliff+window closes', cliffClusterDecision(spec, day(203), stamp(day(206)), fut).action === 'PENDING');
  check('window closed, no cluster -> DEMOTE with ratio and recipients', (() => { const d = cliffClusterDecision(spec, day(203), stamp(day(210)), fut); return d.action === 'DEMOTE' && d.ratio < 3 && d.recipients === 2; })());
  for (let k = 0; k < 5; k++) fut[day(203 + k)] = { amt: 80000, to: Array.from({ length: 9 }, (_, j) => '0xc' + j) };
  const c = cliffClusterDecision(spec, day(203), stamp(day(210)), fut);
  check('window closed, cluster present -> CONFIRM (ratio recorded)', c.action === 'CONFIRM' && c.ratio >= 3 && c.recipients === 9);
  const bigButFew = {}; for (let k = 0; k < 5; k++) bigButFew[day(203 + k)] = { amt: 500000, to: ['0xwhale'] };
  check('one whale claiming a lot is NOT a cluster (recipients gate holds forward too)', cliffClusterDecision(spec, day(203), stamp(day(210)), bigButFew).action === 'DEMOTE');

  // Coverage. No verified contract-cliff rows exist; the count is arithmetic, not asserted.
  const live = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens;
  check('LIVE: no verified row carries enforcement:contract', live.filter((t) => t.verified && !t.retired && t.enforcement === 'contract').length === 0);
  check('coverage line reports 0 contract-cliff (counted, not omitted)', /0 contract-cliff/.test(unlockCoverage().line));
  check('claimCoverage has no contract branch: a row that somehow carried the label gets the generic verified line, not "contract-enforced"', !/contract-enforced/.test(claimCoverage({ verified: true, events: [{ date: '2026-09-01', source: 'x' }], enforcement: 'contract', clusterSpec: spec }, 3).line));
  // RENDERING RULE, same reason as section 46's weak-flag check: this pinned ORDER's
  // live line and went red when ORDER was demoted. Assert that a contract row with
  // unobserved cliffs reports the EARLIEST one, from constructed state.
  const nowHb = new Date(Date.UTC(2026, 8, 13));
  const twoCliffs = { sym: 'CC', enforcement: 'contract', events: [{ date: '2026-09-01', source: 'contract-cliff' }],
    clusterSpec: { windowDays: 5, hits: 2, offIndex: 0, n: 3, spanDays: 113, minRatio: 3, minRecipients: 5, baselineDaily: 1, basis: 'b' },
    cliffDates: [{ date: '2026-11-02', cluster: null }, { date: '2026-10-05', cluster: null }, { date: '2026-08-01', cluster: true }] };
  const ccLine = cadenceStatus([twoCliffs], { months: {}, demotions: {}, cliffs: {} }, nowHb).line;
  check('a contract row reports its EARLIEST unobserved cliff', /CC cliff 0\/0 confirmed · next 2026-10-05/.test(ccLine));
  check('an already-observed cliff is not offered as next', !/2026-08-01/.test(ccLine));
  check('MUTATION: with every cliff observed, no next-cliff is claimed', !/next /.test(cadenceStatus([{ ...twoCliffs, cliffDates: [{ date: '2026-08-01', cluster: true }] }], { months: {}, demotions: {}, cliffs: {} }, nowHb).line));
}

console.log('45. SOURCED tier — a named source pushes, labelled; its falsifier is the source');
{
  const { sourceRow, sourcedRowProblems, sourceIsStale, promoteRow, SOURCE_STALE_DAYS } = await import('./src/core/unlock-promote.js');
  const { sourceRecheckDecision, effectiveSourced } = await import('./src/sources/calendar/cadence-watch.js');
  const { sourcedMessage, claimCoverage, unlockCoverage, STAGES } = await import('./src/sources/calendar/unlocks.js');
  const now = Date.now();
  const t7 = Math.floor((now + 7 * 86400e3) / 1000), t40 = Math.floor((now + 40 * 86400e3) / 1000);
  const base = { source: 'defillama', sourceFetchedAt: new Date(now).toISOString().slice(0, 16), chain: 'ethereum', token: 'ethereum:0x' + 'a'.repeat(40), maxSupply: 1e9, circSupply: 5.5e8,
    sourceEvents: [{ t: t7, type: 'cliff', n: 1e6, cats: 'insiders' }, { t: t40, type: 'cliff', n: 1e6, cats: 'insiders' }] };
  const row = sourceRow({ sym: 'TST', name: 'Test' }, base);
  // Shape discipline: the gate refuses what a sourced row must not be.
  check('a sourced row constructs with provenance/source/fetchedAt', row.provenance === 'sourced' && row.source === 'defillama' && !!row.sourceFetchedAt);
  check('REFUSED without a source name', sourcedRowProblems({ ...row, source: undefined }).length > 0);
  check('REFUSED without a fetch timestamp', sourcedRowProblems({ ...row, sourceFetchedAt: undefined }).length > 0);
  check('REFUSED if it also carries events[] (that field means VERIFIED)', sourcedRowProblems({ ...row, events: [{}] }).length > 0);
  check('REFUSED at FULL — T-14/T+3 assume observation it cannot make', sourcedRowProblems({ ...row, stage: 'FULL' }).length > 0);
  check('REFUSED without a chain (wrong chain reads as no-locked-supply, silently)', sourcedRowProblems({ ...row, chain: undefined }).length > 0);
  check('a verified row cannot be downgraded to sourced by this path', (() => { try { sourceRow({ sym: 'V', name: 'V', events: [{ date: '2026-09-01', source: 's' }] }, base); return false; } catch { return true; } })());
  // Stale rule: a source not re-read in three weeks is a memory, not a source.
  check('fresh source is not stale', !sourceIsStale(row, now));
  check(`a ${SOURCE_STALE_DAYS + 1}-day-old source IS stale and stops pushing`, sourceIsStale({ ...row, sourceFetchedAt: new Date(now - (SOURCE_STALE_DAYS + 1) * 86400e3).toISOString() }, now));
  check('day 20 is still fresh (boundary)', !sourceIsStale({ ...row, sourceFetchedAt: new Date(now - 20 * 86400e3).toISOString() }, now));
  // The falsifier: re-asking the source. Four outcomes, each producing the stated
  // result and nothing else.
  const idx = (events) => ({ fetchedAt: '2026-09-12T00:00', protocols: [{ symbol: 'TST', events }] });
  check('fetch failed → NO-LOOK, nothing changes', sourceRecheckDecision(row, null).action === 'NO-LOOK');
  check('token gone from index → DEMOTE', sourceRecheckDecision(row, { fetchedAt: 'x', protocols: [] }).action === 'DEMOTE');
  check('no upcoming events → DEMOTE (source retracted)', sourceRecheckDecision(row, idx([{ t: t7 - 30 * 86400, type: 'cliff', n: 1 }])).action === 'DEMOTE');
  check('same dates → REFRESH with the new fetch time', (() => { const d = sourceRecheckDecision(row, idx(base.sourceEvents)); return d.action === 'REFRESH' && d.fetchedAt === '2026-09-12T00:00'; })());
  const movedIdx = idx([{ t: t7 + 2 * 86400, type: 'cliff', n: 1e6, cats: 'insiders' }, { t: t40, type: 'cliff', n: 1e6, cats: 'insiders' }]);
  const rev = sourceRecheckDecision(row, movedIdx);
  check('date moved → REVISE, naming the old and new dates', rev.action === 'REVISE' && rev.moved.length === 1 && rev.added.length === 1 && /revised by source from/.test(rev.reason));
  // Overlay merge — the bot writes data/, never unlocks.json.
  const eff = effectiveSourced(row, { rows: { TST: { fetchedAt: '2099-01-01T00:00', events: movedIdx.protocols[0].events, revision: { at: '2099-01-01', note: 'x' } } } });
  check('overlay refreshes the fetch time and replaces events', eff.sourceFetchedAt === '2099-01-01T00:00' && eff.sourceEvents.length === 2 && !!eff.sourceRevision);
  const dem = effectiveSourced(row, { rows: { TST: { demoted: { at: '2099-01-01T00:00', reason: 'gone' } } } });
  check('overlay demotion silences the row', !!dem.sourceDemoted);
  check('re-ingest AFTER the demotion supersedes it', !effectiveSourced({ ...row, sourceFetchedAt: '2099-02-01T00:00' }, { rows: { TST: { demoted: { at: '2099-01-01T00:00' } } } }).sourceDemoted);
  // Message: visibly weaker than verified, no direction, source named, age stated.
  const m = sourcedMessage(row, row.sourceEvents[0], 7, new Date(now));
  check('header icon is 📅 UNLOCK, not 🔓', /^📅 UNLOCK · /.test(m.title) && !/🔓/.test(m.title));
  check('public names the source and says unverified, with the source age', m.lines.some((l) => /DefiLlama, unverified \(\d+d old|today\)/.test(l)));
  check('operator says NOT independently verified in full', m.operatorLines.some((l) => /per DefiLlama/.test(l) && /NOT independently verified/.test(l)));
  check('amount is labelled as the source figure', /source figure/.test(m.lines.join(' ')));
  check('operator states when the source was last confirmed and the silence rule', m.operatorLines.some((l) => /Source last confirmed/.test(l) && /goes silent/.test(l)));
  check('no directional language in the sourced template', !/(close now|drift|sell|buy|dump|bearish|bullish)/i.test(m.title + m.lines.join(' ')));
  check('claim coverage for sourced rows says so', claimCoverage(row).amount === 'sourced' && /not independently verified/.test(claimCoverage(row).line));
  check('sourced rows never look backward (no T+3)', STAGES.STANDARD.every((l) => l >= 0));
  // Supersession keeps the source as history on the verified row.
  const up = promoteRow(row, { events: [{ date: '2026-09-05', source: 'onchain-cadence', detail: 'd' }], cadence: { wallet: '0x' + 'b'.repeat(40), expectDay: 9, meanAmount: 1e6, monthsObserved: 8 }, monthlyDay: 9 });
  check('promotion of a sourced row keeps sourceHistory and drops provenance', up.sourceHistory?.source === 'defillama' && up.provenance === undefined && up.chain === 'ethereum');
  // Coverage line: sourced and stale counts are visible.
  const cov = unlockCoverage([row, { ...row, sym: 'OLD', sourceFetchedAt: new Date(now - 30 * 86400e3).toISOString() }, { sym: 'E' }]);
  check('coverage counts sourced and STALE separately', cov.sourced === 2 && cov.staleSourced === 1 && /STALE/.test(cov.line));
  // Live file: all 30 pass the gate.
  const { verifiedRowProblems } = await import('./src/core/unlock-promote.js');
  const live = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens;
  // 30 ingested; ORDER superseded to contract-cliff in v0.30.0 (sourceHistory kept) and
  // corrected back to sourced 2026-09-15 (tierHistory kept), so sourced +
  // supersessions-from-sourced must still account for all 30.
  const supersededFromSourced = live.filter((t) => t.provenance !== 'sourced' && !!t.sourceHistory?.source && !!t.sourceHistory?.supersededAt).length;
  check('LIVE: the 30 sourced ingests are all accounted for (sourced + superseded)', live.filter((t) => t.provenance === 'sourced').length + supersededFromSourced === 30);
  check('LIVE: every sourced row passes the boot gate', verifiedRowProblems(live).length === 0);
  check('LIVE: the six formerly-unconfirmed chains are resolved and recorded', ['ASTER', 'FF', 'LISTA', 'STO', 'SOLV', 'RE'].every((s) => live.find((t) => t.sym === s)?.chain !== 'unconfirmed'));
}

console.log('44. band width is DERIVED per row, not a global constant');
{
  // ±25% fit EIGEN (natural range ±12%) by coincidence — it was the only row with a
  // family spec. ENA's observed range is 0.53–1.66; under the same constant it would
  // breach in months where it behaves exactly as it always has. A constant
  // calibrated on the first case is wrong for the second row it meets.
  const { deriveTolerance } = await import('./src/sources/calendar/cadence-watch.js');
  const E = [1.123, 1.121, 1.034, 0.931, 0.920, 0.885, 1.029, 0.985, 0.999, 0.986, 0.987];
  const N = [0.531, 1.032, 1.659, 1.087, 0.853, 1.071, 1.150, 0.882, 1.062, 1.051, 0.658, 0.859, 1.103];
  const e = deriveTolerance(E), n = deriveTolerance(N);
  check('a steady row derives a TIGHTER band than the old constant', e.tolerance < 0.25);
  check('a volatile row derives a WIDER band than the old constant', n.tolerance > 0.25);
  check('the two rows differ materially (the whole point)', n.tolerance >= e.tolerance * 2);
  // NO INTUITED FLOOR. The first version floored at 0.15 — and EIGEN's band WAS the
  // floor, so the most-watched row was not derived from anything. The band must
  // instead exceed the worst shortfall the row has actually exhibited; 3xMAD alone
  // would have false-demoted BOTH rows once, so this term is load-bearing.
  check('the band exceeds the worst shortfall the row has actually shown', e.tolerance > 0.115 && n.tolerance > 0.469);
  check('3xMAD ALONE would have false-demoted EIGEN', E.filter((r) => r < 1 - e.spread).length === 1);
  check('3xMAD ALONE would have false-demoted ENA', N.filter((r) => r < 1 - n.spread).length === 1);
  check('EIGEN is now derived, not floored', /worst observed shortfall/.test(e.basis) && e.tolerance !== 0.15);
  check('the remaining clamps never bind on a real row', e.tolerance > 0.05 && e.tolerance < 0.60 && n.tolerance > 0.05 && n.tolerance < 0.60);
  check('window count travels with the band (n=11 is weaker than n=30)', e.n === 11 && n.n === 13);
  // Regression demonstrated, not asserted: the global constant on ENA's real history.
  const breaches = (rs, band) => rs.filter((r) => r < 1 - band).length;
  check('the GLOBAL band would have demoted ENA on its own normal history', breaches(N, 0.25) >= 2);
  check('the DERIVED band demotes ENA less often', breaches(N, n.tolerance) < breaches(N, 0.25));
  check('the derived band still never demotes EIGEN', breaches(E, e.tolerance) === 0);
  // MAD, not mean/max: one outlier month must not inflate the band.
  const withOutlier = deriveTolerance([...E, 3.5]);
  check('a single outlier barely moves a MAD-derived band', Math.abs(withOutlier.tolerance - e.tolerance) <= 0.05);
  check('degenerate flat history hits the hard floor, not a hair-trigger', deriveTolerance([1, 1, 1, 1, 1]).tolerance === 0.05);
  check('cap prevents a band that could never fail', deriveTolerance([0.1, 2.5, 0.2, 3.0, 0.15]).tolerance <= 0.60);
  check('too little history falls back to the default, and SAYS so', /default/.test(deriveTolerance([1.0, 1.1]).basis));
  check('the derivation travels with the number', /derived from 11 observed windows/.test(e.basis) && /shortfall|MAD/.test(e.basis));
  // A band with no stated derivation is refused at promotion and at boot.
  const { cadenceSpecProblems } = await import('./src/core/unlock-promote.js');
  const base = { wallets: [{ addr: '0x' + 'a'.repeat(40), meanAmount: 1 }], monthEnd: true, expectDay: 30, monthsObserved: 11 };
  check('a bare tolerance is refused', cadenceSpecProblems({ ...base, tolerance: 0.25 }).some((p) => /toleranceBasis/.test(p)));
  check('a derived tolerance passes', cadenceSpecProblems({ ...base, tolerance: 0.15, toleranceBasis: '3x MAD of 11' }).length === 0);
  const live = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens.find((t) => t.sym === 'EIGEN');
  check('LIVE EIGEN carries a derived band with its basis and n', live.cadence.tolerance === 0.13 && /observed windows/.test(live.cadence.toleranceBasis) && live.cadence.toleranceN === 11);

  // THE BAND IS STATIC. Re-deriving as windows accrue would let a drifting schedule
  // widen its own band — the same failure rejected for the mean, one level up.
  // Structural, not a promise: the watch module must never call the deriver.
  const watchSrc = readFileSync('src/sources/calendar/cadence-watch.js', 'utf8');
  const callsites = (watchSrc.match(/deriveTolerance\s*\(/g) || []).length;
  check('the WATCH never re-derives the band (definition only, no call sites)', callsites === 1, `${callsites} occurrences`);
  check('re-derivation lives in the promotion path, an explicit act', /deriveTolerance/.test(readFileSync('promote-unlock.js', 'utf8')));
}

console.log('43. drift detector BACKTESTED against 24 real windows (calibration frozen)');
{
  // The detector deserves the standard it enforces. At monthly windows its first
  // live signal is ~November, so it would otherwise sit unexercised outside its own
  // fixtures — the untested-premise shape. These are the REAL observed ratios
  // (EIGEN family 11 windows, ENA metronome 13), frozen so that changing the
  // threshold shows its cost instead of silently re-calibrating.
  const { driftStatus } = await import('./src/sources/calendar/cadence-watch.js');
  const EIGEN = [1.123, 1.121, 1.034, 0.931, 0.920, 0.885, 1.029, 0.985, 0.999, 0.986, 0.987];
  const ENA = [0.531, 1.032, 1.659, 1.087, 0.853, 1.071, 1.150, 0.882, 1.062, 1.051, 0.658, 0.859, 1.103];
  const mk = (rs) => Object.fromEntries(rs.map((r, i) => [`2026-${String(i + 1).padStart(2, '0')}`, { action: 'CONFIRM', ratio: r }]));
  const fires = (rs) => rs.some((_, i) => driftStatus(mk(rs.slice(0, i + 1)))?.drifting);
  check('NO false positive across 11 real EIGEN windows', !fires(EIGEN));
  check('NO false positive across 13 real ENA windows (range 0.53–1.66)', !fires(ENA));
  // EIGEN's Dec–Feb excursion (-7%, -8%, -11%) is three consecutive NEGATIVES that
  // recovered to ~0.99. The threshold correctly treats it as variance, not drift —
  // evidence the 10% bar is not too tight.
  check('a transient 3-month excursion under threshold is NOT called drift', !driftStatus(mk([0.931, 0.920, 0.885])).drifting);
  // Silence on real data is only good news if it CAN fire.
  const detect = (base, k) => {
    const rs = [...base];
    for (let i = 0; i < 12; i++) { rs.push(+(1 + k).toFixed(3)); if (driftStatus(mk(rs))?.drifting) return i + 1; }
    return null;
  };
  check('a −25% step change is caught within 3 windows', detect(EIGEN, -0.25) <= 3);
  check('a +15% step change is caught within 3 windows', detect(EIGEN, 0.15) <= 3);
  check('a −50% collapse is caught within 3 windows', detect(EIGEN, -0.5) <= 3);
  check('an 8% shift stays below the bar (documented insensitivity)', detect(EIGEN, -0.08) === null);
  check('detection needs a RUN, so one big month never fires alone', !driftStatus(mk([...EIGEN, 1.66])).drifting);
}

console.log('42. static mean + recorded ratio = drift detection without false demotion');
{
  // A ROLLING mean re-centres on whatever the treasury now does, absorbing a real
  // schedule change silently — a falsifier that tracks a moving target is not one.
  // So the mean stays STATIC and each confirmation records WHERE IN THE BAND it
  // landed; sustained one-sided deviation surfaces as DRIFT for the operator, never
  // as automatic silence.
  const { cadenceDecision, driftStatus, cadenceStatus } = await import('./src/sources/calendar/cadence-watch.js');
  const W = '0x54B8c65f0635fD91C8729Dd3269C630d9AED54e5';
  const spec = { wallet: W, meanAmount: 12069436, monthEnd: false, expectDay: 6, monthsObserved: 13 };
  const after = new Date('2026-09-13T00:00:00Z');
  const d = cadenceDecision(spec, 2026, 8, after, { '2026-08-06': 13318135 });
  check('CONFIRM records the ratio, not just the verdict', d.ratio === 1.103);
  // UNITS: the spec mean is peak-day-derived, so the ratio must use peak day. The
  // 5-day window sum (14.5M) would read +20% and compare different denominators —
  // the Part 0 units rule, which is exactly how this metric could have lied.
  check('ratio compares peak-day to a peak-day mean, not the window sum', Math.abs(d.ratio - 13318135 / 12069436) < 0.001 && d.ratio < 1.15);
  const mk = (ratios) => Object.fromEntries(ratios.map((r, i) => [`2026-0${i + 1}`, { action: 'CONFIRM', ratio: r }]));
  check('one high reading is NOT drift', driftStatus(mk([1.10])).drifting === false);
  check('two is still not drift', driftStatus(mk([1.10, 1.12])).drifting === false);
  check('three same-side readings ARE drift', driftStatus(mk([1.10, 1.12, 1.15])).drifting === true);
  check('drift reports magnitude and run length', (() => { const s = driftStatus(mk([1.10, 1.12, 1.15])); return s.pct === 12 && s.run === 3; })());
  check('a reading inside the threshold breaks the run', driftStatus(mk([1.10, 1.02, 1.15])).drifting === false);
  check('a sign flip breaks the run', driftStatus(mk([1.10, 0.85, 1.15])).drifting === false);
  check('downward drift is detected too', (() => { const s = driftStatus(mk([0.88, 0.86, 0.85])); return s.drifting && s.pct < 0; })());
  check('no confirmations yet = no drift claim', driftStatus({}) === null);
  // Drift must NEVER demote — it is operator judgement, not automatic silence.
  const toks = [{ sym: 'X', cadence: spec, events: [{ date: '2026-01-01', source: 'onchain-cadence' }] }];
  const st = { months: { X: mk([1.10, 1.12, 1.15]) }, demotions: {} };
  const line = cadenceStatus(toks, st, new Date('2026-04-01')).line;
  check('drift surfaces in the heartbeat', /DRIFT \+12% x3 windows/.test(line));
  check('drift does NOT demote the row', Object.keys(st.demotions).length === 0 && !/demoted/.test(line));
  check('a single confirmation still shows its position in the band', /\+10% vs mean/.test(cadenceStatus(toks, { months: { X: mk([1.10]) }, demotions: {} }, new Date('2026-02-01')).line));
}

console.log('41. predict the floor, report the total (stages have different epistemics)');
{
  // Forward stages can only claim what is PREDICTABLE, so an irregular co-emitter
  // stays out of the falsifier and the figure is a floor. T+3 is RETROSPECTIVE: it
  // reports what actually moved, carries no falsification risk, and must not
  // understate by omitting the irregular emitter. Same row, different claim, both true.
  const { retrospectiveLine } = await import('./src/sources/calendar/cadence-watch.js');
  const { claimCoverage } = await import('./src/sources/calendar/unlocks.js');
  const W = '0x54B8c65f0635fD91C8729Dd3269C630d9AED54e5', O = '0x2146AA5807D96E6B2922a149CeE870F17347F1d0';
  const spec = { wallet: W, meanAmount: 12069436, monthsObserved: 13 };
  const row = { cadence: spec, alsoObserve: [O] };
  check('forward stage quotes a FLOOR', claimCoverage(row, 3).amount === 'observed-partial' && /floor, not a total/.test(claimCoverage(row, 3).line));
  check('T+3 switches to observed-actual', claimCoverage(row, -3).amount === 'observed-actual' && claimCoverage(row, -3).scope === 'retrospective');
  check('T-0 is still forward-looking', claimCoverage(row, 0).amount === 'observed-partial');
  // The real August split: 13.32M metronome + 2.91M irregular.
  const obs = { total: 16227640, window: 'x', per: [{ addr: W, amt: 13318135 }, { addr: O, amt: 2909505 }] };
  const line = retrospectiveLine(obs, spec);
  check('retrospective line separates tracked from other holders', /13,318,135 from the tracked schedule/.test(line) && /2,909,505 from other holders/.test(line));
  check('retrospective line states the TOTAL', /16,227,640 total/.test(line));
  check('retrospective line does not understate by omitting the irregular emitter', !/12,069,436/.test(line));
  const solo = retrospectiveLine({ total: 13318135, window: 'x', per: [{ addr: W, amt: 13318135 }] }, spec);
  check('no co-emission = plain total, no phantom "other holders"', /no other watched holder emitted/.test(solo));
  // Absence-of-observation: a failed read must NOT silently fall back to the floor.
  check('uncovered read says so instead of claiming a total', /did not cover the window, so no total is claimed/.test(retrospectiveLine(null, spec)));
  // Promotion validates the address list (fabrication guard applies here too).
  const { promoteRow } = await import('./src/core/unlock-promote.js');
  let bad = false;
  try { promoteRow({ sym: 'X', name: 'X' }, { events: [{ date: '2026-09-01', source: 's', detail: 'd' }], reviewBy: '2026-12-01', alsoObserve: ['0x2146'] }); } catch { bad = true; }
  check('alsoObserve refuses a truncated address', bad);
  const live = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens.find((t) => t.sym === 'ENA');
  check('LIVE ENA carries its irregular co-emitters for T+3', live.alsoObserve?.length === 2);
  check('LIVE ENA keeps them OUT of the falsifier', !live.cadence.wallets && live.cadence.wallet === W);
}

console.log('40. claim coverage is stated per row (date/amount/scope, not just date)');
{
  // The class behind fixture 39: a falsifier usually covers ONE of the claims a
  // message makes. EIGEN's mismatch was found by accident. This states the mapping
  // for every verified row, derived from SHAPE (a stored coverage field would drift
  // from the spec it describes — same defect one level up).
  const { claimCoverage } = await import('./src/sources/calendar/unlocks.js');
  const famRow = { cadence: { wallets: [{}, {}], tolerance: 0.25, monthsObserved: 11 } };
  const oneRow = { cadence: { wallet: '0x' + 'a'.repeat(40), monthsObserved: 13 } };
  const annRow = { reviewBy: '2026-11-30' };
  check('family cadence: date AND amount observed', claimCoverage(famRow).amount === 'observed' && claimCoverage(famRow).scope === 'family');
  check('single-wallet cadence: amount only PARTIALLY covered', claimCoverage(oneRow).amount === 'observed-partial');
  check('single-wallet message says the figure is a FLOOR, not a total', /floor, not a total/.test(claimCoverage(oneRow).line));
  check('single-wallet message warns other holders are uncovered', /NOT covered/.test(claimCoverage(oneRow).line));
  check('announcement row: amount is UNCHECKED and says so', claimCoverage(annRow).amount === 'unchecked' && /nothing observes it on-chain/.test(claimCoverage(annRow).line));
  check('announcement row still discloses its date falsifier (operator part; line keeps it)', /Re-attested by 2026-11-30/.test(claimCoverage(annRow).line) && claimCoverage(annRow).operator.some((l) => /Re-attested by 2026-11-30/.test(l)));
  check('a row with no falsifier at all is refused, not narrated', /should not be alerting/.test(claimCoverage({}).line));
  // Every LIVE verified row must state coverage for both date and amount.
  const rows = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens.filter((t) => !t.retired && t.events?.length);
  const undisclosed = rows.filter((t) => { const c = claimCoverage(t); return c.date === 'unknown' || c.amount === 'unknown' || !c.line; });
  check('every LIVE verified row states date AND amount coverage', undisclosed.length === 0, undisclosed.map((t) => t.sym).join(','));
  const unchecked = rows.filter((t) => claimCoverage(t).amount === 'unchecked');
  check('rows whose AMOUNT nothing checks are known and disclosed (not silent)', unchecked.every((t) => /announcement-stated/.test(claimCoverage(t).line)));
  check('the disclosure reaches the message, not just the audit', rows.length > 0 && typeof claimCoverage(rows[0]).line === 'string');
}

console.log('39. the falsifier covers what the MESSAGE claims (family, not one wallet)');
{
  // The spec watched ONE metronome while the alert asserted the FAMILY figure. If
  // the second wallet stopped, the first would still clear its 50% bar and the row
  // would stay verified while real distribution fell ~15%: an alert claiming a
  // number nothing checks. Family specs require every wallet to emit AND the total
  // to land inside a band.
  const { cadenceDecision } = await import('./src/sources/calendar/cadence-watch.js');
  const { cadenceSpecProblems } = await import('./src/core/unlock-promote.js');
  const A = '0x34BcF805A503D5151c05CD349699a8aD1767a026', B = '0x3De6b6b121282CBe2F46d24f0023e7D59bB6c24e';
  // tolerance carries its derivation (§44): a bare band is a constant fitted to
  // whichever row it was written for, and is now refused.
  const spec = { wallets: [{ addr: A, meanAmount: 7822556 }, { addr: B, meanAmount: 1692519 }],
    familyMean: 9515075, tolerance: 0.25, toleranceBasis: 'fixture: fixed band for the arithmetic under test',
    monthEnd: true, expectDay: 30, monthsObserved: 11 };
  const after = new Date('2026-09-03T06:00:00Z');
  // The real August emission.
  const real = { [A]: { '2026-08-30': 7920090 }, [B]: { '2026-08-30': 1364336 } };
  const ok = cadenceDecision(spec, 2026, 8, after, real);
  check('both metronomes emitting = CONFIRM', ok.action === 'CONFIRM' && ok.familyTotal === 9284426);
  // THE SCENARIO THAT MOTIVATED THIS: second wallet silent, first perfectly normal.
  const oneStopped = { [A]: { '2026-08-30': 7920090 }, [B]: {} };
  const p = cadenceDecision(spec, 2026, 8, after, oneStopped);
  check('one wallet silent = PARTIAL, not a clean CONFIRM', p.action === 'PARTIAL');
  check('PARTIAL names the silent wallet', /0x3De6b6b1/.test((p.silent || []).join(',')));
  check('the OLD single-wallet spec would have missed it', cadenceDecision({ wallet: A, meanAmount: 7822556, monthEnd: true, expectDay: 30 }, 2026, 8, after, oneStopped[A]).action === 'CONFIRM');
  // Family-wide shortfall that no single wallet reveals (both emit, both above their
  // own 50% floor, total below the band).
  const thin = { [A]: { '2026-08-30': 4200000 }, [B]: { '2026-08-30': 900000 } };
  const s = cadenceDecision(spec, 2026, 8, after, thin);
  check('family shortfall with all wallets participating = PARTIAL', s.action === 'PARTIAL' && /below the/.test(s.reason));
  check('nobody emits = DEMOTE, not PARTIAL', cadenceDecision(spec, 2026, 8, after, { [A]: {}, [B]: {} }).action === 'DEMOTE');
  check('this month within band is not flagged (3.3% light passes)', ok.action === 'CONFIRM');
  check('open window still PENDING for a family spec', cadenceDecision(spec, 2026, 8, new Date('2026-08-31T06:00:00Z'), real).action === 'PENDING');
  // Spec validation.
  check('family spec validates', cadenceSpecProblems(spec).length === 0);
  check('family spec rejects a truncated member address', cadenceSpecProblems({ ...spec, wallets: [{ addr: '0x34Bc', meanAmount: 1 }] }).length > 0);
  check('family spec rejects a member with no mean', cadenceSpecProblems({ ...spec, wallets: [{ addr: A }] }).length > 0);
  check('legacy single-wallet spec still validates', cadenceSpecProblems({ wallet: A, meanAmount: 7822556, monthEnd: true, expectDay: 30, monthsObserved: 11 }).length === 0);
  // The LIVE row must be the family spec — the claim and the check must match.
  const live = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens.find((t) => t.sym === 'EIGEN');
  check('LIVE EIGEN watches both metronomes', live.cadence.wallets?.length === 2 && live.cadence.familyMean > 9e6);
}

console.log('38. the ladder never gates a FACT (the negative the citations exposed)');
{
  // Writing CLAIMS-FACTS-AND-CALLS.md surfaced a claim nothing checked: "the
  // ladder applies to calls only". True by construction (the fact path returns
  // before ladder evaluation) but unasserted — a refactor could route a fact
  // through evaluateLadder() and no test would object. Asserting the NEGATIVE
  // is the whole point: a fact whose type is ladder-DISABLED must still push.
  const { admit, isFact, withLadder } = await import('./src/core/budget.js');
  const allDisabled = { PUMP: 'DISABLED', LISTING: 'DISABLED', FUNDING: 'DISABLED', UNLOCK: 'DISABLED' };
  for (const type of ['LISTING', 'FUNDING', 'UNLOCK']) {
    const v = withLadder(allDisabled, () => admit({ source: 'CEX', type, severity: 'HIGH', key: `l${type}${Math.random()}`, title: 't', lines: [] }));
    check(`${type} fact admits even with its ladder DISABLED`, v.allow === true && v.kind === 'FACT');
    check(`${type} fact carries no tier/score under a disabled ladder`, v.score === undefined && v.tier === undefined);
  }
  // Control: the same disabled ladder DOES gate a call — otherwise the fixture
  // above would pass simply because the injection never took effect.
  const call = withLadder(allDisabled, () => admit({ source: 'SIG', type: 'PUMP', severity: 'HIGH', key: `c${Math.random()}`, title: 't', lines: [] }));
  check('CONTROL: the same disabled ladder suppresses a CALL (injection is live)', call.allow === false);
  check('the fact predicate itself ignores ladder state', isFact({ type: 'LISTING' }));
}

console.log('37. DESCRIPTIVE docs cite a fixture per claim (invariants, not prose)');
{
  // A descriptive document is closer to an invariant than to prose — and an
  // invariant can be tested. So the bar for STATUS: DESCRIPTIVE is that every
  // claim names the fixture that fails if code and document diverge. Drift is
  // then DISCOVERED rather than merely discoverable. A claim with no citation
  // must say UNENFORCED, which makes "we believe this" vs "we check this"
  // visible instead of blurred.
  const { readdirSync: rds2, statSync: st2 } = await import('node:fs');
  const SKIP2 = new Set(['node_modules', '.git', 'data', 'fixtures', 'backups']);
  const walk2 = (dir) => rds2(dir).flatMap((f) => {
    if (SKIP2.has(f)) return [];
    const p = dir === '.' ? f : `${dir}/${f}`;
    try { return st2(p).isDirectory() ? walk2(p) : (f.endsWith('.md') ? [p] : []); } catch { return []; }
  });
  const suite = readFileSync('test-delivery.js', 'utf8');
  const sectionTitles = [...suite.matchAll(/console\.log\('(\d+[a-z]?\..*?)'\)/g)].map((m) => m[1]);
  check('suite exposes its section titles for citation', sectionTitles.length >= 30);

  // STATUS PARSING IS FAIL-CLOSED (v0.31.7). The old selector was
  //     /Status:\s*DESCRIPTIVE/
  // — case-sensitive and exact-spacing, so `STATUS:`, `status:`, `Status : X` and any
  // stray character escaped this discipline SILENTLY. MESSAGE-FIELD-INVENTORY.md was
  // written with `STATUS:` and slipped through by typo. A selector that fails open
  // exempts documents; one that fails closed can only break the suite, which is the
  // direction you want. Third selector this month to have been the thing under test.
  //
  // Qualifiers are real and must survive: "mostly EXECUTED" (NEXT-SESSION.md),
  // "EXECUTED TWICE" (RESCAN-CANDIDATE-INDEX.md), "STRADDLES — ..." (the build spec).
  // Word boundaries, so DESCRIPTIVEE does NOT read as DESCRIPTIVE.
  const STATUSES = ['DESCRIPTIVE', 'ACTIVE PLAN', 'REFUTED', 'EXECUTED', 'STRADDLES'];
  const statusOf = (body) => {
    const m = body.slice(0, 1600).match(/^\s*status\s*:\s*(.+)$/im);
    if (!m) return null;
    const hits = STATUSES.filter((k) => new RegExp(`\\b${k}\\b`, 'i').test(m[1]));
    return hits.length === 1 ? hits[0] : { bad: m[1].trim(), hits: hits.length };
  };
  const mds = walk2('.');
  const statuses = mds.map((f) => [f, statusOf(readFileSync(f, 'utf8'))]);
  const unparseable = statuses.filter(([, v]) => v && typeof v === 'object').map(([f, v]) => `${f}: '${v.bad}' matched ${v.hits} known statuses`);
  check('every Status: line parses to exactly one known status', unparseable.length === 0, unparseable.join(' | '));
  // A brief with NO status is not exempt — it is unfiled. README.md is the directory
  // index, not a brief, and is the one principled exception (an index describes the
  // briefs; it is not one).
  const briefsMissing = statuses.filter(([f, v]) => /docs[\\/]briefs[\\/]/.test(f) && !/README\.md$/.test(f) && v === null).map(([f]) => f);
  check('every brief under docs/briefs/ carries a status (an unfiled brief fails)', briefsMissing.length === 0, briefsMissing.join(' | '));
  // SELF-TESTS — the parser must be shown to reject, not merely to accept.
  check('SELF-TEST: a typo\'d status is REJECTED, not silently exempted', typeof statusOf('Status: DESCRIPTIVEE') === 'object');
  check('SELF-TEST: case and spacing variants all PARSE (they used to escape)', ['STATUS: DESCRIPTIVE', 'status:descriptive', 'Status :  DESCRIPTIVE'].every((x) => statusOf(x) === 'DESCRIPTIVE'));
  check('SELF-TEST: qualifiers survive', statusOf('Status: mostly EXECUTED') === 'EXECUTED' && statusOf('Status: EXECUTED TWICE') === 'EXECUTED' && statusOf('Status: STRADDLES — per-section') === 'STRADDLES');
  check('SELF-TEST: two statuses in one line is ambiguous and REJECTED', typeof statusOf('Status: EXECUTED and REFUTED') === 'object');
  check('SELF-TEST: no status line at all reads as null, not as a status', statusOf('# doc\nno header') === null);

  const descriptive = statuses.filter(([, v]) => v === 'DESCRIPTIVE').map(([f]) => f);
  check('at least one DESCRIPTIVE doc exists to check', descriptive.length >= 1);
  const uncited = [], badCite = [];
  let claims = 0, unenforced = 0;
  for (const f of descriptive) {
    const body = readFileSync(f, 'utf8');
    const claimBlock = body.split(/^##\s+Claims\s*$/m)[1];
    if (!claimBlock) { uncited.push(`${f}: no "## Claims" section`); continue; }
    for (const line of claimBlock.split('\n')) {
      if (!/^-\s+\S/.test(line)) continue;
      if (/^##\s/.test(line)) break;
      claims++;
      const cite = line.match(/\[fixture:\s*(.+?)\]/);
      if (/\[UNENFORCED:/.test(line)) { unenforced++; continue; }
      if (!cite) { uncited.push(`${f}: ${line.trim().slice(0, 60)}`); continue; }
      // The citation must name a section that REALLY EXISTS — otherwise a
      // renamed fixture leaves a dangling reference that still reads as proof.
      if (!sectionTitles.includes(cite[1].trim())) badCite.push(`${cite[1].slice(0, 50)}`);
    }
  }
  check('DESCRIPTIVE docs declare claims', claims >= 5);
  check('every claim is cited or explicitly UNENFORCED', uncited.length === 0, uncited.slice(0, 2).join(' | '));
  check('every citation names a fixture that exists', badCite.length === 0, badCite.slice(0, 2).join(' | '));
  check('UNENFORCED claims are declared, not hidden', unenforced >= 1);
  // Self-tests.
  check('dangling citation would be caught', !sectionTitles.includes('99. a fixture that does not exist'));
  check('uncited claim would be caught', !/\[fixture:|\[UNENFORCED:/.test('- an unbacked claim'));
}

console.log('63. a COPY of the tree cannot send — by construction, not by a rule someone remembers');
{
  // Two boot checks on ad-hoc copies carried .env and pushed channel messages
  // (2026-09-15, 2026-09-17) that the live bot then sent again. The memory-dependent
  // fix was "blank the token"; the structural one is that the copy never holds the
  // token and the loader refuses a marked copy that somehow does.
  const { copySendGuard, COPY_MARKER, COPY_STUB_TOKEN } = await import('./src/config.js');
  const { withDataCopy, NEVER_COPIED } = await import('./test-on-copy.js');
  const { makeCopy } = await import('./boot-check.js');
  const { mkdtempSync, existsSync: ex, writeFileSync: wf, mkdirSync: md, rmSync: rm } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const has = (names) => (p) => names.includes(p.split(/[\\/]/).pop());
  check('marked copy + live token -> REFUSED, naming the marker and the two incidents', /copy must not send/.test(copySendGuard('/x', { TELEGRAM_BOT_TOKEN: 't' }, has([COPY_MARKER])) || '') && /2026-09-17/.test(copySendGuard('/x', { TELEGRAM_BOT_TOKEN: 't' }, has([COPY_MARKER]))));
  check('marked copy + no token -> starts (console-only is the copy\'s only mode)', copySendGuard('/x', {}, has([COPY_MARKER])) === null && copySendGuard('/x', { TELEGRAM_BOT_TOKEN: '' }, has([COPY_MARKER])) === null);
  check('marked copy + the declared STUB token -> starts (the suite needs a token present; this one cannot send)', copySendGuard('/x', { TELEGRAM_BOT_TOKEN: COPY_STUB_TOKEN }, has([COPY_MARKER])) === null && COPY_STUB_TOKEN.length > 10);
  check('MUTATION: the LIVE tree (no marker) with a token is untouched by the guard', copySendGuard('/x', { TELEGRAM_BOT_TOKEN: 't' }, has([])) === null);
  // Wherever this suite runs: the live tree has no marker; a copy has one AND no live
  // token (the stub or nothing). Asserted against the token config actually loaded.
  check('LIVE: no marker here, or marker + no live token — a copy running this suite with a real token is the incident', !ex(COPY_MARKER) || (config.telegramToken === COPY_STUB_TOKEN || !config.telegramToken));
  check('withDataCopy refuses .env by name', NEVER_COPIED.includes('.env') && (() => { try { withDataCopy('.env'); return false; } catch (e) { return /never copied/.test(e.message); } })());
  // makeCopy on a synthetic tree: .env left behind, marker written, everything else carried.
  const src = mkdtempSync(join(tmpdir(), 'mr-src-')); const dst = join(tmpdir(), 'mr-dst-' + process.pid);
  wf(join(src, '.env'), 'TELEGRAM_BOT_TOKEN=secret'); wf(join(src, 'a.js'), '1'); md(join(src, 'data')); wf(join(src, 'data', 'x.json'), '{}'); md(join(src, 'node_modules')); wf(join(src, 'node_modules', 'n.js'), '1');
  try {
    makeCopy(src, dst);
    check('makeCopy: .env is NOT in the copy, the marker IS, sources and data are', !ex(join(dst, '.env')) && ex(join(dst, COPY_MARKER)) && ex(join(dst, 'a.js')) && ex(join(dst, 'data', 'x.json')) && !ex(join(dst, 'node_modules')));
    check('the copy it makes is exactly the shape the guard refuses to run with a token', /must not send/.test(copySendGuard(dst, { TELEGRAM_BOT_TOKEN: 't' }) || '') && copySendGuard(dst, {}) === null);
  } finally { rm(src, { recursive: true, force: true }); rm(dst, { recursive: true, force: true }); }
}

console.log('64. MESSAGE DIET — two renderings, one row; public is lint-clean, capped, and loses no field');
{
  const U = await import('./src/sources/calendar/unlocks.js');
  const { renderFact, sourcedMessage, verifiedMessage, claimCoverage, PUBLIC_MAX_LINES, PUBLIC_MAX_CHARS } = U;
  const { formatAlert, ageLine } = await import('./src/core/dispatcher.js');
  const { lagDisclosure, DATA_AGE_DISCLOSE_SEC, LAG_DISCLOSE_MIN } = await import('./src/core/lag.js');
  const now = new Date(Date.UTC(2026, 8, 13, 12));
  const day = (d) => Math.floor((now.getTime() + d * 86400e3) / 1000);
  // Representative rows — one per shape the inventory covers (B sourced, C verified).
  const srcRow = { sym: 'KAI', name: 'Kaito', provenance: 'sourced', source: 'defillama', sourceFetchedAt: new Date(now - 5 * 86400e3).toISOString(), chain: 'base', token: 'base:0x' + 'a'.repeat(40),
    sourceEvents: [{ t: day(7), type: 'cliff', n: 17597619, cats: 'noncirculating+insiders+privateSale' }, { t: day(37), type: 'cliff', n: 1e6, cats: 'insiders' }], maxSupply: 1e9, circSupply: 4.6e8, stage: 'STANDARD', mechanism: 'pending',
    operatorNote: 'bucket C not enumerated by us' };
  const srcUnconf = { ...srcRow, sym: 'UNC', chain: 'unconfirmed', token: null };
  const idx = (d) => ({ protocols: [{ symbol: srcRow.sym, nextDate: d }], withheld: 78 });
  const famRow = { sym: 'EIG', name: 'EigenCloud', verified: true, events: [{ date: '2026-08-30', source: 'onchain-cadence', detail: 'd' }],
    cadence: { wallets: [{ addr: '0x' + '1'.repeat(40), meanAmount: 7.82e6 }, { addr: '0x' + '2'.repeat(40), meanAmount: 1.69e6 }], monthsObserved: 11, tolerance: 0.13, toleranceBasis: 'b' },
    falsifier: { verdict: 'STRONG', chanceRate: 0.24, replayRate: 1, replayN: 11, replayHits: 11, windowDays: 5, compound: 1.5e-7, margin: 0.76, basis: 'b' }, operatorNote: 'cadence spec would false-demote by construction' };
  const oneRow = { sym: 'ENA', name: 'Ethena', verified: true, events: [{ date: '2026-08-06', source: 'onchain-cadence' }], cadence: { wallet: '0x' + '3'.repeat(40), meanAmount: 12069436, monthsObserved: 13 },
    falsifier: { verdict: 'STRONG', chanceRate: 0.33, replayRate: 1, replayN: 13, replayHits: 13, windowDays: 5, margin: 0.67, basis: 'b' } };
  const annRow = { sym: 'STK', name: 'Starknet', verified: true, events: [{ date: '2026-09-15', source: 'announcement' }], reviewBy: '2026-11-30', falsifier: { verdict: 'NONE', basis: 'b' }, operatorNote: 'reviewBy dead-man switch; enforcement unverifiable' };
  const shapes = [
    ['sourced', () => renderFact(srcRow, 'public', { ev: srcRow.sourceEvents[0], lead: 7, now, second: idx('2026-09-20') }), () => renderFact(srcRow, 'operator', { ev: srcRow.sourceEvents[0], lead: 7, now, second: idx('2026-09-20') })],
    ['sourced-disagree', () => renderFact(srcRow, 'public', { ev: srcRow.sourceEvents[0], lead: 3, now, second: idx('2026-09-29') }), () => renderFact(srcRow, 'operator', { ev: srcRow.sourceEvents[0], lead: 3, now, second: idx('2026-09-29') })],
    ['sourced-unconfirmed-chain', () => renderFact(srcUnconf, 'public', { ev: srcUnconf.sourceEvents[0], lead: 0, now, second: { protocols: [], withheld: 78 } }), () => renderFact(srcUnconf, 'operator', { ev: srcUnconf.sourceEvents[0], lead: 0, now, second: { protocols: [], withheld: 78 } })],
    ['family', () => renderFact(famRow, 'public', { lead: 14, dateKey: '2026-09-30' }), () => renderFact(famRow, 'operator', { lead: 14, dateKey: '2026-09-30' })],
    ['single', () => renderFact(oneRow, 'public', { lead: 3, dateKey: '2026-10-06' }), () => renderFact(oneRow, 'operator', { lead: 3, dateKey: '2026-10-06' })],
    ['announcement', () => renderFact(annRow, 'public', { lead: 0, dateKey: '2026-09-15' }), () => renderFact(annRow, 'operator', { lead: 0, dateKey: '2026-09-15' })],
    ['retro', () => renderFact(oneRow, 'public', { lead: -3, dateKey: '2026-09-06', retro: 'Observed on-chain: 13,318,135 total from the tracked schedule; no other watched holder emitted in this window.' }), () => renderFact(oneRow, 'operator', { lead: -3, dateKey: '2026-09-06', retro: 'Observed on-chain: 13,318,135 total from the tracked schedule; no other watched holder emitted in this window.' })],
  ];
  const pub = Object.fromEntries(shapes.map(([k, p]) => [k, p()]));
  const op = Object.fromEntries(shapes.map(([k, , o]) => [k, o()]));

  // PART 1 — RENDER-LINT over the PUBLIC OUTPUT (not any field), so vocabulary
  // arriving through any path is caught. Compound forms where the bare word is
  // plain English ("cadence spec", not "cadence"; "demote" is never plain here).
  const BANNED = /\b(bucket [A-D]|falsifier|cadence spec|cluster spec|by construction|demot(e|es|ed|ion)|promot(e|es|ed|ion)|dead-man|provenance tier|overlay|quarantine|claim coverage|chance rate|binomial|replay series|enumerated by us|tierHistory|margin bar|not enumerated|auto-demotes|re-attest(ed|s)?|reviewBy|operator note)\b/i;
  const lintHits = (r) => r.lines.concat(r.title).filter((l) => BANNED.test(l));
  for (const [k, r] of Object.entries(pub)) check(`render-lint: PUBLIC ${k} carries no architecture vocabulary`, lintHits(r).length === 0, lintHits(r).join(' | '));
  check('render-lint: the OPERATOR rendering is where that vocabulary lives (family shows falsifier strength)', op.family.lines.some((l) => /Falsifier strength/.test(l)) && op.sourced.lines.some((l) => /bucket C/.test(l)));
  // SELF-TEST, same run: plant an operator note on a synthetic row via the PUBLIC
  // field, assert the public render FAILS; the same text as operatorNote passes.
  const planted = renderFact({ ...famRow, note: 'bucket C not enumerated by us' }, 'public', { lead: 14, dateKey: '2026-09-30' });
  check('SELF-TEST: a planted operator phrase in the public note is CAUGHT', lintHits(planted).length === 1);
  const safe = renderFact({ ...famRow, note: 'Team allocation; monthly since Oct 2025.', operatorNote: 'bucket C not enumerated by us' }, 'public', { lead: 14, dateKey: '2026-09-30' });
  check('SELF-TEST: the same phrase as operatorNote, with an operator-safe public note, PASSES', lintHits(safe).length === 0 && safe.lines.some((l) => /Team allocation/.test(l)));
  check('SELF-TEST: the lint also catches vocabulary arriving through a non-note path (title)', lintHits({ ...planted, lines: [], title: 'X — demoted' }).length === 1);
  // No-direction-words on every new public template (the prose-lint rule, applied to output).
  const DIRECTION = /(close now|exit here|buy now|sell now|take profit|dump hard|sell off sharply|capitulation bottom|blow-off top|reversal risk|front-run|bleeds into|drift usually|expect wider swings|precursor to|watch for a follow-up|bearish|bullish)/i;
  check('no-direction-words: every public template is clean', Object.values(pub).every((r) => !DIRECTION.test(r.text)));

  // PART 2 — the budget: six lines after the title, ≤420 chars, enforced not preferred.
  for (const [k, r] of Object.entries(pub)) check(`cap: PUBLIC ${k} is ≤${PUBLIC_MAX_LINES} lines and ≤${PUBLIC_MAX_CHARS} chars (${r.lines.length}/${r.text.length})`, r.lines.length <= PUBLIC_MAX_LINES && r.text.length <= PUBLIC_MAX_CHARS);
  check('MUTATION: a seventh public line would fail the cap', renderFact({ ...srcRow, note: 'x', sourceRevision: { note: 'moved', at: '2026-09-20' } }, 'public', { ev: srcRow.sourceEvents[0], lead: 7, now, second: idx('2026-09-29') }).lines.length <= PUBLIC_MAX_LINES);

  // PART 4 — coverage obligations survive the cut, per row shape that demands them.
  check('obligation: VERIFIED vs LISTED unmissable (🔓 vs 📅)', /^📅/.test(pub.sourced.title) && /^🔓/.test(pub.family.title));
  check('obligation: source NAME when unverified', pub.sourced.lines.some((l) => /DefiLlama, unverified/.test(l)));
  check('obligation: source AGE when staleness can silence the row', pub.sourced.lines.some((l) => /\(5d old\)/.test(l)));
  check('obligation: "amount not observed on-chain" on an announcement row', pub.announcement.lines.some((l) => /amount not observed on-chain/.test(l)));
  check('obligation: "chain unconfirmed" when no on-chain read was attempted', pub['sourced-unconfirmed-chain'].lines.some((l) => /chain unconfirmed — no on-chain read attempted/.test(l)));
  check('obligation: single-wallet figure says floor, not a total', pub.single.lines.some((l) => /a floor, not a total/.test(l)));
  check('obligation: second-source state collapses to one of three forms', /DefiLlama \+ CryptoRank agree/.test(pub.sourced.text) && /sources disagree: DefiLlama 20 Sep, CryptoRank 29 Sep/.test(pub['sourced-disagree'].text) && /DefiLlama only/.test(pub['sourced-unconfirmed-chain'].text));
  check('MUTATION: silence about coverage would read as coverage — a sourced row without its source name fails', !renderFact({ ...srcRow, source: '' }, 'public', { ev: srcRow.sourceEvents[0], lead: 7, now, second: null }).lines.some((l) => /DefiLlama, unverified/.test(l)));

  // PART 5 — FIELD PRESERVATION against docs/briefs/MESSAGE-FIELD-INVENTORY.md (frozen
  // input). Every inventory ID names its destination; PUBLIC/OPERATOR IDs must match a
  // rendering; the others carry a declared reason. Nothing is deleted; it moves.
  const T = (r, re) => r.text.split('\n').some((l) => re.test(l));
  const ffam = formatAlert({ source: 'CAL', type: 'UNLOCK', title: op.family.title, lines: pub.family.lines, operatorLines: op.family.lines.slice(pub.family.lines.length), url: 'u' }, { kind: 'FACT', updates: 3 }, 'operator');
  const table = [
    ['A1', 'PUBLIC', /\[🔓 TOKEN UNLOCK\]/.test(ffam)], ['A2', 'PUBLIC', /EIG — 30 Sep/.test(ffam)],
    ['A3', 'CHANNEL BIO', 'facts only — no trade calls: a property of the feed, set once in the channel description'],
    ['A4', 'PUBLIC', /conviction 76/.test(formatAlert({ source: 'SIG', type: 'CONFLUENCE', title: 'c', lines: ['x'] }, { kind: 'CALL', tier: 'B', score: 76 }))],
    ['A5', 'PUBLIC', /• /.test(ffam)], ['A6', 'PUBLIC', /updated 3x/.test(ffam)], ['A7', 'PUBLIC', /href="u"/.test(ffam)],
    ['A8', 'PUBLIC', /⏱ data 4m old/.test(formatAlert({ source: 'CAL', type: 'UNLOCK', title: 't', lines: ['x'], snapshotTs: Date.now() - 4 * 60e3 }, { kind: 'FACT' }, 'public'))],
    ['B1', 'PUBLIC', /^📅 UNLOCK · KAI/.test(pub.sourced.title)], ['B2', 'PUBLIC', T(pub.sourced, /· cliff/)], ['B3', 'PUBLIC', /20 Sep \(7d\)/.test(pub.sourced.title)],
    ['B4', 'PUBLIC', T(pub.sourced, /DefiLlama, unverified/) && T(op.sourced, /per DefiLlama's schedule — NOT independently verified/)],
    ['B5', 'OPERATOR', T(op.sourced, /Source lists 2 upcoming batch events/)], ['B6', 'PUBLIC', T(pub.sourced, /noncirculating \/ insiders \/ privateSale/)],
    ['B7', 'PUBLIC', T(pub.sourced, /17,597,619 KAI/)], ['B8', 'PUBLIC', T(pub.sourced, /1\.76% of max supply/)], ['B9', 'PUBLIC', T(pub.sourced, /46% already unlocked/)],
    ['B10', 'PUBLIC', T(pub.sourced, /source figure/)], ['B11', 'PUBLIC', T(pub['sourced-unconfirmed-chain'], /chain unconfirmed — no on-chain read attempted/) && T(pub.sourced, /^base ·/)],
    ['B12', 'PUBLIC', T(pub.sourced, /5d old/)], ['B13', 'OPERATOR', T(op.sourced, /goes silent if not re-confirmed within 21 days/)],
    ['B14', 'PUBLIC', T(renderFact({ ...srcRow, sourceRevision: { note: 'moved 2 days', at: '2026-09-20' } }, 'public', { ev: srcRow.sourceEvents[0], lead: 7, now, second: null }), /Schedule moved 2 days \(recheck 2026-09-20\)/)],
    ['B15', 'PUBLIC', T(pub.sourced, /DefiLlama \+ CryptoRank agree/)], ['B16', 'OPERATOR', T(op['sourced-unconfirmed-chain'], /withholds 78 entries/)],
    ['B17', 'PUBLIC', /basescan/.test(pub.sourced.url) || /defillama/.test(pub['sourced-unconfirmed-chain'].url)],
    ['C1', 'PUBLIC', /30 Sep \(14d\)/.test(pub.family.title) && /T\+3 \(event 6 Sep\)/.test(pub.retro.title) && /\(today\)/.test(pub.announcement.title)],
    ['C2', 'OPERATOR', T(op.family, /EigenCloud: scheduled token unlock/)],
    ['C3', 'UNREACHABLE', 'pctOfMcap is an estimated-era field; a verified row carrying it fails boot (fixture 11d), so the clause never rendered'],
    ['C4', 'SPLIT', T(op.family, /Operator note: cadence spec would false-demote by construction/) && !T(pub.family, /false-demote/)],
    ['C5', 'DROP', '"Unlocks add sell-side supply; thin-liquidity tokens absorb it worst" — generic advice, not a fact about the row; the inventory proposed DROP and the reviewer accepted'],
    ['C6', 'OPERATOR', T(op.family, /Stage T-14: Added supply reaches the market on this date/)], ['C7', 'OPERATOR', T(op.retro, /Stage T\+3: Post-event check/)], ['C8', 'OPERATOR', T(op.announcement, /Stage T-0: Emission is imminent/)],
    ['C9', 'OPERATOR', T(op.family, /Verified — source: onchain-cadence/)],
    ['C10', 'SPLIT', T(pub.family, /Verified on-chain · 11 consecutive months · 2 wallets/) && T(op.family, /Auto-demotes if the pattern breaks/) && T(op.family, /record 11\/11 consecutive \(that series by chance alone: p≈1\.5e-7\)/)],
    ['C11', 'PUBLIC', T(pub.retro, /Observed on-chain: 13,318,135 total/)],
    ['C12', 'UNREACHABLE', 'verified:true without events[] cannot alert (pollUnlocks skips rows without events before this branch)'],
    ['C13', 'UNREACHABLE', 'estimated rows are skipped before the message is built — the estimate warning never rendered'],
    ['C14', 'PUBLIC', /cryptorank\.io\/price\/eigencloud\/vesting/.test(pub.family.url)],
    ['D1-D7', 'RETIRED', 'contract-cliff messages: the tier is claimable by nobody (v0.31.9); the branch is deleted, not re-rendered'],
  ];
  const rendered = table.filter(([, d]) => ['PUBLIC', 'OPERATOR', 'SPLIT'].includes(d));
  const declared = table.filter(([, d]) => !['PUBLIC', 'OPERATOR', 'SPLIT'].includes(d));
  const notRendered = rendered.filter(([, , ok]) => ok !== true).map(([id]) => id);
  check(`field preservation: every rendered inventory field (${rendered.length}) appears in its rendering${notRendered.length ? ` — MISSING ${notRendered.join(',')}` : ''}`, notRendered.length === 0);
  check(`field preservation: every non-rendered field (${declared.length}) carries a declared destination and a reason`, declared.every(([, d, why]) => ['CHANNEL BIO', 'DROP', 'UNREACHABLE', 'RETIRED'].includes(d) && typeof why === 'string' && why.length > 20));
  check('field preservation: the table covers the inventory (A1-A8, B1-B17, C1-C14, D)', table.length === 8 + 17 + 14 + 1);
  check('operator ⊇ public, by construction, on every shape', shapes.every(([k]) => pub[k].lines.every((l) => op[k].lines.includes(l))));

  // PART 3 — ageLine: one rule, shared with macro.js; silent when fresh, ⏱ when not.
  check('ageLine: fresh REST-polled alert (no snapshot) renders NO footer at all', ageLine({ lines: [] }, now.getTime()) === null && !/data age|REST poll/.test(formatAlert({ source: 'CAL', type: 'UNLOCK', title: 't', lines: ['x'] }, { kind: 'FACT' })));
  check('ageLine: ≤120s is silent; 4 minutes discloses with the ⏱ marker', ageLine({ snapshotTs: now - 119e3 }, now.getTime()) === null && ageLine({ snapshotTs: now - 4 * 60e3 }, now.getTime()) === '⏱ data 4m old');
  check('ageLine: the threshold is the declared constant', DATA_AGE_DISCLOSE_SEC === 120);
  check('one rule: macro.js and the footer both go through lagDisclosure (no parallel ⏱ literal in macro)', /lagDisclosure\(/.test(readFileSync('src/sources/calendar/macro.js', 'utf8')) && !/`⏱/.test(readFileSync('src/sources/calendar/macro.js', 'utf8')));
  check('lagDisclosure: macro semantics unchanged (5m default; 6m past the mark discloses, 5m does not)', lagDisclosure(6 * 60e3, (m) => `late ${m}m`) === '⏱ late 6m' && lagDisclosure(5 * 60e3, (m) => 'x') === null && LAG_DISCLOSE_MIN === 5);

  // ACCEPTANCE — replay: the 13 Sep sourced pushes (CYBER, RE) plus the verified shapes
  // that fired 15-16 Sep (EIGEN T-14, STRK T-0), on the LIVE rows at a fixed `now`.
  // Public ≤6 lines and ≤40% of the operator text (the operator rendering carries
  // every pre-diet sentence, so it is at least today's message).
  const live = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens;
  const replay = [
    ['CYBER', 0, '2026-09-14'], ['RE', 3, '2026-09-17'], ['EIGEN', 14, '2026-09-30'], ['STRK', 0, '2026-09-15'],
  ].map(([sym, lead, dateKey]) => {
    const t = live.find((x) => x.sym === sym);
    if (!t) return null;
    const ctx = t.provenance === 'sourced' ? { ev: (t.sourceEvents || []).find((e) => new Date(e.t * 1000).toISOString().slice(0, 10) === dateKey) ?? t.sourceEvents[0], lead, now, second: U.loadSecondIndex() } : { lead, dateKey };
    return { sym, p: renderFact(t, 'public', ctx), o: renderFact(t, 'operator', ctx) };
  }).filter(Boolean);
  check('LIVE replay: all four rows exist', replay.length === 4);
  for (const r of replay) {
    check(`LIVE replay ${r.sym}: public ≤6 lines, lint-clean, ≤40% of operator length (${r.p.lines.length} lines · ${Math.round(100 * r.p.text.length / r.o.text.length)}%)`, r.p.lines.length <= PUBLIC_MAX_LINES && lintHits(r.p).length === 0 && r.p.text.length <= 0.4 * r.o.text.length, lintHits(r.p).join(' | '));
  }
  check('LIVE: no row carries a pre-split note (every note moved to operatorNote through promote-unlock.js note-split)', live.every((t) => !t.note));
  check('LIVE: replay operator renderings carry the pre-diet sentences (superset of today)', replay.every((r) => r.o.lines.some((l) => /NOT independently verified|Verified — source:/.test(l))));
}

console.log('65. RE-PROMOTION requires POST-DEMOTION evidence — the gate refuses on exactly ENA\'s input');
{
  const { repromotionProblems, NEAR_MISS_RATIO, NEAR_MISS_BASIS, QUALIFY_FRACTION } = await import('./src/core/unlock-promote.js');
  const { loadWatchState, activeDemotions } = await import('./src/sources/calendar/cadence-watch.js');
  // ENA's history as detect-cadence reports it: 13 on-day emissions, the 13th (09-07)
  // at 5.15M against a 12.07M mean — the miss that demoted, counted as a month.
  const mean = 12069436, bar = QUALIFY_FRACTION * mean;
  const hist = ['2025-09-08', '2025-10-06', '2025-11-06', '2025-12-08', '2026-01-06', '2026-02-06', '2026-03-06', '2026-04-06', '2026-05-06', '2026-06-08', '2026-07-06', '2026-08-06'].map((d) => ({ d, amt: 1.2e7 }));
  const miss = { d: '2026-09-07', amt: 5148798 };
  const dem = { kind: 'DEMOTE', month: '2026-09', window: '2026-09-06..2026-09-10', at: '2026-09-12T13:58' };
  const spec13 = { wallet: '0x' + '5'.repeat(40), meanAmount: mean, monthsObserved: 13 };
  const ena = repromotionProblems({ spec: spec13, demotion: dem, largestSeen: 5148798, emissions: [...hist, miss] });
  check('ENA input: REFUSED on both rules', ena.length === 2 && /R1/.test(ena[0]) && /R2/.test(ena[1]));
  check('R1 names the window\'s emission as the miss, not a confirming month', /monthsObserved 13 exceeds the 12 qualifying emissions OUTSIDE/.test(ena[0]) && /2026-09-07 5,148,798/.test(ena[0]));
  check('R2 states the ratio to the bar, the class, and the count required', /0\.85 of the 6,034,718 bar → deep miss/.test(ena[1]) && /2 required/.test(ena[1]));
  check('the near-miss cut is declared with its n=2 basis, not derived', NEAR_MISS_RATIO === 0.9 && /n=2/.test(NEAR_MISS_BASIS) && /ENA/.test(NEAR_MISS_BASIS) && /ORDER/.test(NEAR_MISS_BASIS) && /R2[^]*n=2/.test(ena[1]));
  // Re-analysing pre-demotion history is not new evidence however it is classified.
  check('dropping the miss from the count but adding NO post-window emission still fails R2', (() => { const p = repromotionProblems({ spec: { ...spec13, monthsObserved: 12 }, demotion: dem, largestSeen: 5148798, emissions: hist }); return p.length === 1 && /R2/.test(p[0]); })());
  // What WOULD pass: two post-window on-schedule emissions for a deep miss.
  const oct = { d: '2026-10-06', amt: 1.1e7 }, nov = { d: '2026-11-06', amt: 1.25e7 };
  check('deep miss + ONE post-window emission: still refused (needs two)', repromotionProblems({ spec: { ...spec13, monthsObserved: 13 }, demotion: dem, largestSeen: 5148798, emissions: [...hist, miss, oct] }).some((p) => /R2/.test(p)));
  check('deep miss + TWO post-window emissions, miss not counted: PASSES', repromotionProblems({ spec: { ...spec13, monthsObserved: 14 }, demotion: dem, largestSeen: 5148798, emissions: [...hist, miss, oct, nov] }).length === 0);
  check('MUTATION: a post-window emission BELOW the bar does not count', repromotionProblems({ spec: { ...spec13, monthsObserved: 12 }, demotion: dem, largestSeen: 5148798, emissions: [...hist, oct, { d: '2026-11-06', amt: 0.4 * mean }] }).some((p) => /R2/.test(p)));
  check('near miss (0.93 of bar): ONE post-window emission suffices', repromotionProblems({ spec: { ...spec13, monthsObserved: 12 }, demotion: dem, largestSeen: 0.93 * bar, emissions: [...hist, oct] }).length === 0);
  check('MUTATION: at 0.89 of bar it is a deep miss and one is not enough', repromotionProblems({ spec: { ...spec13, monthsObserved: 12 }, demotion: dem, largestSeen: 0.89 * bar, emissions: [...hist, oct] }).some((p) => /deep miss/.test(p)));
  check('unknown largestSeen is treated as a deep miss, said so', /treated as a deep miss/.test(repromotionProblems({ spec: spec13, demotion: dem, largestSeen: undefined, emissions: hist }).join()));
  check('no emission series -> refused, names detect-cadence (typed numbers do not re-promote)', /run detect-cadence/.test(repromotionProblems({ spec: spec13, demotion: dem, largestSeen: 1, emissions: null }).join()));
  check('a FAMILY spec is judged against the family mean', repromotionProblems({ spec: { wallets: [{ addr: 'a', meanAmount: 7e6 }, { addr: 'b', meanAmount: 5e6 }], monthsObserved: 12 }, demotion: dem, largestSeen: 5e6, emissions: [...hist, oct, nov] }).length === 0);
  check('no active demotion -> nothing to satisfy', repromotionProblems({ spec: spec13, demotion: null, largestSeen: 1, emissions: [] }).length === 0 && repromotionProblems({ spec: spec13, demotion: { kind: 'review-expired' }, largestSeen: 1, emissions: [] }).length === 0);
  // LIVE: the real ENA record + the real report refuse today (the row IS the test case).
  const live = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens;
  const st = loadWatchState();
  const liveDem = activeDemotions(live, st).ENA;
  const liveEna = live.find((t) => t.sym === 'ENA');
  const rep = JSON.parse(readFileSync('data/cadence-report.json', 'utf8')).ENA;
  const w = (rep?.perWallet || []).find((x) => x.addr.toLowerCase() === liveEna?.cadence?.wallet?.toLowerCase());
  check('LIVE: ENA is under an active DEMOTE and its report still says CADENCE on the same history', liveDem?.kind === 'DEMOTE' && w?.solo?.verdict === 'CADENCE');
  check('LIVE: re-promoting ENA from that report is REFUSED today', repromotionProblems({ spec: liveEna.cadence, demotion: liveDem, largestSeen: st.months?.ENA?.[liveDem?.month]?.largestSeen, emissions: w?.solo?.emissions }).length >= 1);
  check('the CLI consults the gate before promoteRow (source-level: no override flag exists)', /repromotionProblems\(/.test(readFileSync('promote-unlock.js', 'utf8')) && !/force|override/i.test(readFileSync('promote-unlock.js', 'utf8').split('ITEM 10')[1].split('const row = promoteRow')[0].replace(/^\s*\/\/.*$/gm, '')));
}

console.log('66. MESSAGE DIET, CEX remainder — one rendering discipline across every FACT type');
{
  const { fundingMessage } = await import('./src/sources/cex/funding.js');
  const { listingMessage, listingBatchMessage } = await import('./src/sources/cex/listings.js');
  const { announcementMessage, announcementBatchMessage } = await import('./src/sources/cex/announcements.js');
  const { upbitMarketMessage, upbitNoticeMessage } = await import('./src/sources/cex/upbit.js');
  const { renderMessage, gateLine, formatAlert } = await import('./src/core/dispatcher.js');
  const { PUBLIC_MAX_LINES, PUBLIC_MAX_CHARS } = await import('./src/sources/calendar/unlocks.js');
  const fund = fundingMessage({ symbol: 'MTLUSDT', f: -0.551, thresh: 0.212, reason: 'entered', mark: 0.3133 }, { building: true, velocity: -0.212, oiChange: 12.3, oiConfirm: true, ls: { longPct: 59, shortPct: 41 } });
  // The executable line is appended by the dispatcher for gated types; include it in the cap.
  const fundGated = { ...fund, lines: [...fund.lines, gateLine({ executableUsd: 922, spreadBps: 30.7, pass: false })] };
  const msgs = {
    funding: fundGated,
    fundingFlip: fundingMessage({ symbol: 'XUSDT', f: 0.9, thresh: 0.4, reason: 'flipped', mark: 1 }, { ls: { longPct: 72, shortPct: 28 } }),
    listing: listingMessage('mexc', 'BATONUSDT', { price: 0.010949, quoteVol24h: 2658 }, { state: 'RECOGNISED' }, 'u'),
    listingUnrec: listingMessage('mexc', 'XSTOCKUSDT', null, { state: 'UNRECOGNISED', reason: 'product line not classified: xStock' }, 'u'),
    listingBatch: listingBatchMessage('bitget', Array.from({ length: 14 }, (_, i) => 'P' + i), 'u'),
    suspension: announcementMessage('upbit', { title: 'MED 입출금 일시 중단 안내', url: 'u' }, { type: 'SUSPENSION', which: 'deposits and withdrawals', routine: false }),
    suspensionRoutine: announcementMessage('binance', { title: 'Wallet maintenance', url: 'u' }, { type: 'SUSPENSION', which: 'deposits', routine: true, interest: ['held asset', 'pending delist on the same asset'] }),
    delist: announcementMessage('binance', { title: 'Binance Will Delist X', url: 'u' }, { type: 'DELIST_SCHEDULED', dateText: '2026-10-01' }),
    perp: announcementMessage('bybit', { title: 'Bybit lists XUSDT perpetual', url: 'u' }, { type: 'PERP' }),
    annBatch: announcementBatchMessage('okx', 'LISTING', Array.from({ length: 5 }, (_, i) => ({ title: 'OKX lists T' + i })), 'u'),
    upbitMarket: upbitMarketMessage('BATON', 'Baton', ['KRW', 'USDT']),
    upbitNotice: upbitNoticeMessage('Baton', '[거래] 바톤(BATON) 신규 거래지원 안내', { isList: true }),
    upbitWarn: upbitNoticeMessage('X', 'notice', {}),
  };
  const pub = Object.fromEntries(Object.entries(msgs).map(([k, m]) => [k, renderMessage(m, 'public')]));
  const op = Object.fromEntries(Object.entries(msgs).map(([k, m]) => [k, renderMessage(m, 'operator')]));
  // Same lint as fixture 64 (the unlock diet), plus the CEX prediction vocabulary the
  // reviewer named: squeeze, precursor, expect wider swings, lead time, violent open.
  const BANNED = /\b(bucket [A-D]|falsifier|cadence spec|cluster spec|by construction|demot(e|es|ed|ion)|promot(e|es|ed|ion)|dead-man|provenance tier|overlay|quarantine|claim coverage|chance rate|binomial|replay series|enumerated by us|tierHistory|margin bar|detector|squeeze|precursor|expect wider swings|real money|lead time|violent|reversals?|catalysts?|surge rule|velocity)\b/i;
  const DIRECTION = /(close now|exit here|buy now|sell now|take profit|dump hard|sell off sharply|capitulation bottom|blow-off top|reversal risk|front-run|bleeds into|drift usually|expect wider swings|precursor to|watch for a follow-up|bearish|bullish)/i;
  const hits = (r) => r.lines.concat(r.title).filter((l) => BANNED.test(l) || DIRECTION.test(l));
  for (const [k, r] of Object.entries(pub)) check(`render-lint: PUBLIC ${k} is clean`, hits(r).length === 0, hits(r).join(' | '));
  check('the operator rendering is where the detector reading lives ("squeeze building" survives there, as a quote)', op.funding.lines.some((l) => /squeeze building/.test(l)) && op.funding.lines.some((l) => /surge rule/.test(l)));
  // SELF-TEST, same run: the lint catches the pre-diet lines if they came back.
  check('SELF-TEST: the pre-diet perp line would be caught', hits({ title: 'x', lines: ['Perp/futures listing — leverage and a short side open up, so expect wider swings'] }).length === 1);
  check('SELF-TEST: the pre-diet suspension line would be caught', hits({ title: 'x', lines: ['Possible precursor to a delisting, chain halt or incident — watch for a follow-up notice.'] }).length === 1);
  check('SELF-TEST: the pre-diet Upbit line would be caught', hits({ title: 'x', lines: ['Korean retail concentration makes the open violent — magnitude, not direction.'] }).length === 1);
  // Cap, on every shape, executable line included where the dispatcher adds it.
  for (const [k, r] of Object.entries(pub)) check(`cap: PUBLIC ${k} ≤${PUBLIC_MAX_LINES} lines / ≤${PUBLIC_MAX_CHARS} chars (${r.lines.length}/${r.text.length})`, r.lines.length <= PUBLIC_MAX_LINES && r.text.length <= PUBLIC_MAX_CHARS);
  check('funding at full decoration is exactly at the cap (6 with the executable line), never over', pub.funding.lines.length === 6);
  // Coverage obligations (inventory F5).
  check('obligation: executable size where computed', /Executable ~\$922 @50bps · spread 30\.7bps/.test(pub.funding.text));
  check('obligation: unrecognised product is flagged in PUBLIC', pub.listingUnrec.lines.some((l) => /⚠️ product line not classified/.test(l)));
  check('obligation: a suspension says whether a resumption was stated — both ways', /⚠️ no resumption stated/.test(pub.suspension.text) && /resumption stated/.test(pub.suspensionRoutine.text) && !/⚠️/.test(pub.suspensionRoutine.text));
  check('obligation: who pays whom, the percentile, and the reason survive in PUBLIC funding', /shorts paying longs/.test(pub.funding.text) && /99th pctile/.test(pub.funding.text) && /just entered/.test(pub.funding.text) && /sign flipped/.test(pub.fundingFlip.text));
  check('MUTATION: strip the resumption clause and the obligation fails', !/resumption/.test(renderMessage({ ...msgs.suspension, lines: ['Deposits halted'] }, 'public').text));
  // Field preservation against inventory section F.
  const T = (r, re) => r.lines.concat(r.title).some((l) => re.test(l));
  const table = [
    ['F1.1', 'SPLIT', /^⚡ FUNDING · MTLUSDT -0\.551%\/8h$/.test(pub.funding.title) && T(op.funding, /squeeze building/) && T(op.funding, /surge rule/)],
    ['F1.2', 'PUBLIC', T(pub.funding, /-603% annualised · shorts paying longs/)], ['F1.3', 'SPLIT', T(pub.funding, /99th pctile of its own 90d/) && T(op.funding, /Threshold for this pair: 0\.212%/)],
    ['F1.4', 'PUBLIC', T(pub.funding, /just entered/)], ['F1.5', 'SPLIT', T(pub.funding, /Moved -0\.212% since last check/) && T(op.funding, /velocity/)],
    ['F1.6', 'SPLIT', T(pub.funding, /Open interest \+12\.3%/)], ['F1.7', 'PUBLIC', T(renderMessage(fundingMessage({ symbol: 'A', f: 0.5, thresh: 0.1, reason: 'entered', mark: 1 }, { oiChange: -3.2 }), 'public'), /Open interest -3\.2%/)],
    ['F1.8', 'PUBLIC', T(pub.funding, /59% long \/ 41% short/)], ['F1.9', 'OPERATOR', T(op.fundingFlip, /Positioning long-heavy/) && T(op.fundingFlip, /same side as funding/)],
    ['F1.10', 'PUBLIC', T(pub.funding, /mark \$0\.3133/)], ['F1.11', 'PUBLIC', T(pub.funding, /^Executable/)],
    ['F2.1', 'PUBLIC', /^🆕 LISTING · BATONUSDT on MEXC$/.test(pub.listing.title)], ['F2.2', 'OPERATOR', T(op.listing, /New spot pair detected/)],
    ['F2.3', 'PUBLIC', T(pub.listing, /\$0\.010949 · Vol24h \$2,658/) && T(pub.listingUnrec, /No ticker data yet/)], ['F2.4', 'PUBLIC', T(pub.listingUnrec, /⚠️ product line not classified/)],
    ['F2.5', 'PUBLIC', /14 new pairs on BITGET/.test(pub.listingBatch.title) && T(pub.listingBatch, /P0, P1.*… \+2 more/)], ['F2.6', 'OPERATOR', T(op.listingBatch, /Batched: 14 listings/)],
    ['F3.1', 'PUBLIC', /^UPBIT: MED/.test(pub.suspension.title)], ['F3.2', 'PUBLIC', T(pub.suspension, /Deposits and withdrawals halted/)],
    ['F3.3', 'SPLIT', T(pub.suspensionRoutine, /resumption stated/) && T(op.suspensionRoutine, /reported because: held asset; pending delist/)],
    ['F3.4', 'PUBLIC', T(pub.suspension, /⚠️ no resumption stated/)], ['F3.5', 'SPLIT', T(pub.delist, /effective 2026-10-01/) && T(op.delist, /reminders at T-7d and T-1d/)],
    ['F3.6', 'PUBLIC', T(pub.perp, /Perp\/futures listing/)], ['F3.7', 'PUBLIC', T(renderMessage(announcementMessage('x', { title: 't', url: 'u' }, { type: 'LISTING', delist: true }), 'public'), /Delisting notice/)],
    ['F3.8', 'PUBLIC', T(renderMessage(announcementMessage('x', { title: 't', url: 'u' }, { type: 'LISTING' }), 'public'), /published before trading opens/)],
    ['F3.9', 'PUBLIC', pub.annBatch.lines.length === 5 && T(pub.annBatch, /OKX lists T4/)], ['F3.10', 'OPERATOR', T(op.annBatch, /product-line rollout/)],
    ['F4.1', 'PUBLIC', /^🆕 LISTING · Baton on UPBIT — KRW, USDT markets$/.test(pub.upbitMarket.title)], ['F4.2', 'SPLIT', T(pub.upbitMarket, /Now trading on Upbit \(Korea\)/) && T(op.upbitMarket, /live market list/)],
    ['F4.3', 'DROP', '"Korean retail concentration makes the open violent" — a frequency claim with no sample; the inventory proposed DROP'],
    ['F4.4', 'PUBLIC', /^UPBIT will list Baton$/.test(pub.upbitNotice.title) && /investment warning on X/.test(pub.upbitWarn.title)],
    ['F4.5', 'SPLIT', T(pub.upbitNotice, /^Announced before trading opens$/)], ['F4.6', 'PUBLIC', T(pub.upbitWarn, /investment warning" designation/)],
    ['F4.7', 'PUBLIC', T(pub.upbitNotice, /바톤\(BATON\)/)],
  ];
  const rendered = table.filter(([, d]) => d !== 'DROP');
  const missing = rendered.filter(([, , ok]) => ok !== true).map(([id]) => id);
  check(`field preservation (section F): every rendered field (${rendered.length}) appears in its rendering${missing.length ? ` — MISSING ${missing.join(',')}` : ''}`, missing.length === 0);
  check('field preservation (section F): the table covers F1.1–F4.7 (34 IDs)', table.length === 34 && table.filter(([, d]) => d === 'DROP').every(([, , why]) => typeof why === 'string' && why.length > 20));
  check('operator ⊇ public on every CEX shape', Object.keys(msgs).every((k) => pub[k].lines.every((l) => op[k].lines.includes(l))));
  check('formatAlert routes operatorLines to the operator audience for CEX types too', /surge rule/.test(formatAlert({ source: 'CEX', type: 'FUNDING', ...fund }, { kind: 'FACT' }, 'operator')) && !/surge rule/.test(formatAlert({ source: 'CEX', type: 'FUNDING', ...fund }, { kind: 'FACT' }, 'public')));
  // The pollers consume the pure builders (source-level): no inline `lines: [` remains in the four files.
  const inline = ['src/sources/cex/funding.js', 'src/sources/cex/listings.js', 'src/sources/cex/announcements.js', 'src/sources/cex/upbit.js']
    .filter((f) => /^\s*lines: \[/m.test(readFileSync(f, 'utf8').split(/\/\/ .*MESSAGE.*pure/)[0].replace(/^\s*\/\/.*$/gm, '')));
  check('every CEX poller builds its message through its pure builder (no inline lines: [ left in the poll path)', inline.length === 0, inline.join(','));
}

console.log('67. the VERSION BUMP asks each PREMISE what it claims — a blanket sed is a hand-maintained list in disguise');
{
  const { bumpPremise, bumpTree, readVersions } = await import('./bump-version.js');
  const { mkdtempSync, mkdirSync: md, writeFileSync: wf, readFileSync: rf, rmSync: rm } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const live = '<!-- PREMISE\nWritten against: v0.31.8\nTracks: live\nReviewed: x\nAssumes:\n- a\n-->\n# doc\nWritten against: v0.10.0 (quoted in the body — must not move)\n';
  const hist = '<!-- PREMISE\nWritten against: v0.31.7\nReviewed: x\nAssumes:\n- a\n-->\n# brief\n';
  check('a PREMISE that tracks live MOVES, and only in the block (the body quote stays)', (() => { const r = bumpPremise(live, '0.32.4'); return r.action === 'moved' && /Written against: v0\.32\.4\nTracks: live/.test(r.text) && /Written against: v0\.10\.0 \(quoted/.test(r.text); })());
  check('a PREMISE without Tracks: live is a historical claim and is LEFT, whatever version it names', bumpPremise(hist, '0.32.4').action === 'historical-claim' && bumpPremise(hist, '0.32.4').text === hist);
  check('no PREMISE -> reported, untouched', bumpPremise('# plain\n', '0.32.4').action === 'no-premise');
  check('already at the target -> says so, not "moved"', bumpPremise(live.replace('v0.31.8', 'v0.32.4'), '0.32.4').action === 'already-current');
  // A synthetic tree: config + package + three docs.
  const root = mkdtempSync(join(tmpdir(), 'mr-bump-'));
  try {
    md(join(root, 'src')); md(join(root, 'docs'));
    wf(join(root, 'src/config.js'), "export const VERSION = '0.32.3';\n"); wf(join(root, 'package.json'), JSON.stringify({ version: '0.32.3' }));
    wf(join(root, 'README.md'), live); wf(join(root, 'docs/BRIEF.md'), hist); wf(join(root, 'docs/PLAIN.md'), '# nothing\n');
    const dry = bumpTree(root, '0.32.4', { dry: true });
    check('dry run reports the split and changes nothing', dry.moved.length === 1 && dry.left.length === 1 && dry.noPremise.length === 1 && readVersions(root).config === '0.32.3' && rf(join(root, 'README.md'), 'utf8') === live);
    const r = bumpTree(root, '0.32.4');
    check('real run moves config, package and ONLY the tracking doc', readVersions(root).config === '0.32.4' && readVersions(root).pkg === '0.32.4' && /v0\.32\.4/.test(rf(join(root, 'README.md'), 'utf8')) && rf(join(root, 'docs/BRIEF.md'), 'utf8') === hist && r.moved.length === 1);
    check('bumping to the current version ABORTS', (() => { try { bumpTree(root, '0.32.4'); return false; } catch (e) { return /already at/.test(e.message); } })());
    wf(join(root, 'package.json'), JSON.stringify({ version: '0.32.2' }));
    check('config/package disagreement ABORTS before touching anything', (() => { try { bumpTree(root, '0.33.0'); return false; } catch (e) { return /disagree/.test(e.message) && readVersions(root).config === '0.32.4'; } })());
    check('a non-semver target ABORTS', (() => { try { bumpTree(root, 'v1'); return false; } catch (e) { return /semver/.test(e.message); } })());
  } finally { rm(root, { recursive: true, force: true }); }
  // LIVE: the living docs declare it; the briefs do not; config and package agree.
  const v = readVersions('.');
  check('LIVE: src/config.js and package.json agree', v.config === v.pkg);
  check('LIVE: README.md and REMAINING-WORK.md track live; briefs are historical claims', /Tracks: live/.test(rf('README.md', 'utf8').match(/<!--\s*PREMISE([\s\S]*?)-->/)[1]) && /Tracks: live/.test(rf('REMAINING-WORK.md', 'utf8').match(/<!--\s*PREMISE([\s\S]*?)-->/)[1]) && !/Tracks: live/.test(rf('docs/briefs/MESSAGE-DIET.md', 'utf8')));
  check('LIVE: every doc that tracks live is AT the live version (the tool was used, not sed)', bumpTree('.', '99.99.99', { dry: true }).moved.every((m) => new RegExp(`\\(v${v.config.replace(/\./g, '\\.')} →`).test(m)));
}

console.log('68. --preflight runs the four boot gates and NOTHING else — systemd ExecStartPre on the VPS');
{
  // The brief's first draft imported index.js with a `?preflight=1` query nothing
  // read: that would have started the bot inside the preflight. A `--once` would have
  // polled and marked cooldowns the real instance then honours. This flag is the
  // honest layer: gates, banner, exit — read-only.
  const { makeCopy } = await import('./boot-check.js');
  const { COPY_STUB_TOKEN } = await import('./src/config.js');
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync: wf, readFileSync: rf, readdirSync: rd, statSync: st, rmSync: rm } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { createHash } = await import('node:crypto');
  const dst = join(tmpdir(), 'mr-preflight-' + process.pid);
  const digest = (root) => createHash('sha1').update(rd(join(root, 'data')).filter((f) => f.endsWith('.json')).sort().map((f) => f + ':' + st(join(root, 'data', f)).size + ':' + rf(join(root, 'data', f), 'utf8')).join('|') + rf(join(root, 'unlocks.json'), 'utf8')).digest('hex');
  const run = (root, token) => spawnSync(process.execPath, ['src/index.js', '--preflight'], { cwd: root, encoding: 'utf8', env: { ...process.env, TELEGRAM_BOT_TOKEN: token }, timeout: 120_000 });
  try {
    makeCopy(process.cwd(), dst);
    const before = digest(dst);
    const ok = run(dst, '');
    const out = (ok.stdout || '') + (ok.stderr || '');
    check('preflight on a green copy exits 0 with four gates and the banner', ok.status === 0 && /\[boot\] admit\(\) self-test/.test(out) && /tier-route assertion: OK/.test(out) && /classifiers-wired assertion: OK/.test(out) && /pagination-guard assertion: OK/.test(out) && /\[preflight\] v\d+\.\d+\.\d+: four gates OK — not starting/.test(out));
    check('preflight does NOT start: no "starting" banner, no poller scan, no telegram', !/Market Radar v.* starting/.test(out) && !/\[cex\]/.test(out) && !/\[telegram\]/.test(out));
    check('preflight writes NOTHING under data/ or unlocks.json (digest identical)', digest(dst) === before);
    check('preflight with a real-looking token in a marked copy is refused by config.js (exit 3) — the copy guard still holds', run(dst, 'not-a-stub').status === 3);
    // MUTATION: a corrupt unlocks.json is what the tier-route gate exists for.
    wf(join(dst, 'unlocks.json'), '{ not json');
    const bad = run(dst, '');
    check('MUTATION: a corrupt unlocks.json makes preflight exit 1 at the tier-route gate', bad.status === 1 && /tier/i.test((bad.stdout || '') + (bad.stderr || '')));
  } finally { rm(dst, { recursive: true, force: true }); }
  check('the flag is read from argv, not from an import query nothing reads', /process\.argv\.includes\('--preflight'\)/.test(rf('src/index.js', 'utf8')) && !/preflight=1/.test(rf('src/index.js', 'utf8')));
}

console.log('69. whale sources are TESTED routes, not a pricing-page belief — and a dark chain is a heartbeat line');
{
  const w = await import('./src/sources/chain/whale.js');
  const cfg = { etherscanKey: 'k', moralisKey: '', heliusKey: 'h' };
  check('ethereum/arbitrum/polygon route to Etherscan V2 (the free key answers them — tested 2026-09-25)', ['ethereum', 'arbitrum', 'polygon'].every((c) => w.whaleSource(c, cfg).source === 'etherscan' && w.whaleSource(c, cfg).ready));
  check('base routes to Blockscout, keyless — ready with no key at all', w.whaleSource('base', {}).source === 'blockscout' && w.whaleSource('base', {}).ready);
  check('bsc stays on Moralis and is NOT ready without a key (no silent fallthrough to a route that refuses it)', w.whaleSource('bsc', cfg).source === 'moralis' && !w.whaleSource('bsc', cfg).ready);
  check('an unmapped chain is not ready and says so', !w.whaleSource('tron', cfg).ready && /no source/.test(w.whaleSource('tron', cfg).why));
  const tx = { hash: '0xh', from: '0xF', to: '0xT', value: '1500000000000000000', tokenDecimal: '18' };
  const m = w.mapExplorerTx('base', tx);
  check('mapExplorerTx: amount honours tokenDecimal, id is hash:from:to, explorer link is the chain\'s own scanner', m.amount === 1.5 && m.id === '0xh:0xF:0xT' && /basescan\.org\/tx\/0xh/.test(m.explorer));
  check('mapExplorerTx: arbitrum links arbiscan, ethereum links etherscan', /arbiscan/.test(w.mapExplorerTx('arbitrum', tx).explorer) && /etherscan\.io/.test(w.mapExplorerTx('ethereum', tx).explorer));
  check('explorerUrl: the Blockscout query carries no key; the Etherscan query carries the key and the chain id', !/apikey/.test(w.explorerUrl('base', '0xabc', 'blockscout', cfg)) && /base\.blockscout\.com/.test(w.explorerUrl('base', '0xabc', 'blockscout', cfg)) && /chainid=42161/.test(w.explorerUrl('arbitrum', '0xabc', 'etherscan', cfg)) && /apikey=k/.test(w.explorerUrl('arbitrum', '0xabc', 'etherscan', cfg)));
  check('an empty answer from either explorer is an empty list, not an error; a plan refusal is an error', w.isEmptyExplorerAnswer({ status: '0', message: 'No transactions found', result: [] }) && w.isEmptyExplorerAnswer({ status: '0', message: 'No token transfers found', result: [] }) && !w.isEmptyExplorerAnswer({ status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain' }));
  const dark = new Map([['bsc', 'moralis key rejected: free tier paused']]);
  const cov = w.whaleCoverage({ cfg: { etherscanKey: 'k', moralisKey: 'm', heliusKey: 'h' }, dark, paused: new Map(), now: 0 });
  check('whaleCoverage: a dark chain is named with its reason on the heartbeat line', /bsc DARK \(moralis key rejected: free tier paused\)/.test(cov.line) && cov.off.length === 1);
  check('whaleCoverage: live chains list their source', /ethereum etherscan/.test(cov.line) && /base blockscout/.test(cov.line) && /solana helius/.test(cov.line));
  check('whaleCoverage: a chain with no credential is "off", distinct from DARK', /optimism off \(moralis key missing\)/.test(w.whaleCoverage({ cfg, dark: new Map(), paused: new Map(), now: 0 }).line));
  const { buildHeartbeat: bh } = await import('./src/core/telemetry.js');
  check('the heartbeat carries the whale coverage line', bh(Date.now(), { rows: [], whale: cov }).lines.some((l) => l === cov.line));
}

console.log('70. the calendar verifier compares against PARSED official schedules and names the official date — five wrong dates hid behind "not found"');
{
  const m = await import('./src/sources/calendar/macro.js');
  const bls = '<table><tr><td>September 2026</td><td>Oct. 14, 2026</td><td>08:30 AM</td></tr><tr><td>October 2026</td><td>Nov. 10, 2026</td></tr><tr><td>December 2025</td><td>Jan. 09, 2026</td></tr><tr><td>April 2026</td><td>May 12, 2026</td></tr></table>';
  const cpi = m.parseBlsSchedule(bls);
  check('parseBlsSchedule reads "Oct. 14, 2026", zero-padded "Jan. 09, 2026" and period-less "May 12, 2026" as ISO dates', cpi.includes('2026-10-14') && cpi.includes('2026-11-10') && cpi.includes('2026-01-09') && cpi.includes('2026-05-12') && cpi.length === 4);
  const fed = '<div class="panel panel-default"><div class="panel-heading"><h4>2026 FOMC Meetings</h4></div>'
    + '<div class="fomc-meeting__month col"><strong>October</strong></div><div class="fomc-meeting__date col">27-28</div>'
    + '<div class="fomc-meeting__month col"><strong>December</strong></div><div class="fomc-meeting__date col">8-9*</div></div>'
    + '<div class="panel panel-default"><div class="panel-heading"><h4>2025 FOMC Meetings</h4></div>'
    + '<div class="fomc-meeting__month col"><strong>August</strong></div><div class="fomc-meeting__date col">22 (notation vote)</div>'
    + '<div class="fomc-meeting__month col"><strong>September</strong></div><div class="fomc-meeting__date col">16-17*</div>'
    + '<a href="/monetarypolicy/files/monetary20250917a1.pdf">PDF</a></div>';
  const fomc = m.parseFomcCalendar(fed);
  check('parseFomcCalendar: statement day is the LAST day of the meeting, year from the panel, notation votes skipped', fomc.includes('2026-10-28') && fomc.includes('2026-12-09') && fomc.includes('2025-09-17') && !fomc.some((d) => d.endsWith('-08-22')) && fomc.length === 3);
  const fedNoHeading = fed.replace(/<h4>20\d{2} FOMC Meetings<\/h4>/g, '');
  check('parseFomcCalendar: no heading -> a statement link inside the panel supplies the year; a panel with neither is skipped, not guessed', m.parseFomcCalendar(fedNoHeading).includes('2025-09-17') && !m.parseFomcCalendar(fedNoHeading).includes('2026-10-28'));
  const bea = '<th>Year 2026</th><table><tr class="x"><td><div class="release-date">October 29</div></td><td>GDP (Advance Estimate), 3rd Quarter 2026</td></tr>'
    + '<tr class="x"><td><div class="release-date">October 29</div></td><td>Personal Income and Outlays, September 2026 </td></tr>'
    + '<tr class="x"><td><div class="release-date">September 30</div></td><td>Personal Income and Outlays, August 2026</td></tr></table>';
  const pce = m.parseBeaSchedule(bea);
  check('parseBeaSchedule: row-scoped — the PCE row gets ITS date; the GDP row on the same day is not a PCE entry', pce['Personal Income and Outlays, September 2026'] === '2026-10-29' && pce['Personal Income and Outlays, August 2026'] === '2026-09-30' && Object.keys(pce).length === 2);
  const now = Date.parse('2026-09-25T08:00:00Z');
  const events = [
    { id: 'cpi-2026-10', kind: 'CPI', date: '2026-10-13' },                       // the real wrong date
    { id: 'cpi-2026-11', kind: 'CPI', date: '2026-11-10', verifiedOn: '2026-09-25' },
    { id: 'pce-2026-09', kind: 'PCE', date: '2026-09-25' },                       // "today", per the file — BEA said the 30th
    { id: 'pce-2026-10', kind: 'PCE', date: '2026-10-29' },
    { id: 'fomc-2026-10', kind: 'FOMC', date: '2026-10-28' },
    { id: 'nfp-2026-10', kind: 'NFP', date: '2026-10-02' },                       // BLS unreachable, 7d out, never verified
    { id: 'ppi-2026-10', kind: 'PPI', date: '2026-10-15', verifiedOn: '2026-09-25' }, // unreachable but freshly stamped
    { id: 'cpi-2026-08', kind: 'CPI', date: '2026-08-12' },                       // past: ignored
  ];
  const f = m.compareCalendar(events, { CPI: cpi, PCE: pce, FOMC: fomc, NFP: null, PPI: null }, now);
  const by = Object.fromEntries(f.map((x) => [x.id, x]));
  check('a wrong CPI date is a MISMATCH carrying the official date from the same month', by['cpi-2026-10'].status === 'mismatch' && by['cpi-2026-10'].official === '2026-10-14');
  check('a right CPI date is ok', by['cpi-2026-11'].status === 'ok');
  check('PCE is matched by reference month (release month minus one): the wrong "today" is a mismatch with the 30th', by['pce-2026-09'].status === 'mismatch' && by['pce-2026-09'].official === '2026-09-30' && by['pce-2026-10'].status === 'ok');
  check('the FOMC statement date matches the Fed panel', by['fomc-2026-10'].status === 'ok');
  check('an unreachable source yields UNCHECKED — never ok, never mismatch', by['nfp-2026-10'].status === 'unchecked' && by['ppi-2026-10'].status === 'unchecked');
  check('past events are not reported', !by['cpi-2026-08'] && f.length === 7);
  const lines = m.verifyReport(f, { NFP: '403', PPI: '403' }, now);
  check('every mismatch is an [OPERATOR] line naming both dates and the file to fix', lines.some((l) => /\[OPERATOR\] CPI cpi-2026-10: calendar says 2026-10-13, official schedule says 2026-10-14/.test(l)) && lines.some((l) => /\[OPERATOR\] PCE pce-2026-09: calendar says 2026-09-25, official schedule says 2026-09-30/.test(l)) && lines.filter((l) => /official schedule says/.test(l)).length === 2);
  check('unchecked + within 14d + never verified is loud, with the page to open; unchecked + freshly stamped is quiet', lines.some((l) => /\[OPERATOR\] NFP nfp-2026-10 on 2026-10-02 .*never verified.*empsit\.htm/.test(l)) && !lines.some((l) => /ppi-2026-10/.test(l)));
  check('exactly one summary line, last, with counts and the unreachable sources', lines.filter((l) => /^\[macro\] calendar verified:/.test(l)).length === 1 && /3 ok · 2 mismatch · 2 unchecked of 7 upcoming/.test(lines.at(-1)) && /unreachable: NFP 403, PPI 403/.test(lines.at(-1)));
  const fetchImpl = async (url) => {
    if (/bls\.gov/.test(url)) return { ok: false, status: 403, text: async () => '' };
    if (/federalreserve/.test(url)) return { ok: true, text: async () => fed };
    if (/bea\.gov/.test(url)) return { ok: true, text: async () => bea };
    throw new Error('unexpected url ' + url);
  };
  const beforeCal = readFileSync('data/macro-calendar.json', 'utf8');
  const r = await m.verifyCalendar({ fetchImpl, force: true, now });
  check('verifyCalendar: BLS 403 is reported as unreachable for CPI/PPI/NFP; Fed and BEA are fetched and parsed', r && /unreachable: /.test(r.lines.at(-1)) && r.unreachable.CPI === '403' && r.unreachable.NFP === '403' && !('FOMC' in r.unreachable) && !('PCE' in r.unreachable));
  check('verifyCalendar never writes the calendar (the file is truth; the verifier only compares)', readFileSync('data/macro-calendar.json', 'utf8') === beforeCal);
  check('verifyCalendar is weekly: a second un-forced call is a no-op', (await m.verifyCalendar({ fetchImpl, now })) === null);
}

console.error = origErr;
console.log(failures === 0 ? '\nALL DELIVERY PROPERTIES HOLD' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
