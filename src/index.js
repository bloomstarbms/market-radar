import { readFileSync } from 'node:fs';
import { config, VERSION } from './config.js';
import { load, getState, save } from './core/store.js';
import { startBot } from './core/telegram.js';
import { dispatch, recordSuppressedRug, checkPendingListings } from './core/dispatcher.js';
import { dailyDigest, heartbeat } from './core/telemetry.js';
import { assertTierRoutes, checkClassifiersWired } from './core/routes.js';
import { notePulse } from './core/pulse.js';
import { loadOutcomes, checkOutcomes, statsSummary, recordAlert, backupOutcomes } from './core/outcomes.js';
import { getPairsForTokens, bestPairPerToken } from './sources/dex/dexscreener.js';
import { checkRevival } from './sources/dex/revival.js';
import { screen as screenContract } from './sources/dex/rugscreen.js';
import { pollCex } from './sources/cex/monitor.js';
import { pollFunding } from './sources/cex/funding.js';
import { pollAnnouncements } from './sources/cex/announcements.js';
import { pollUpbit } from './sources/cex/upbit.js';
import { pollCascade } from './sources/cex/cascade.js';
import { checkWhales } from './sources/chain/whale.js';
import { checkConfluence } from './core/confluence.js';
import { pollMacro, verifyCalendar } from './sources/calendar/macro.js';
import { pollEvents } from './sources/calendar/events.js';
import { pollUnlocks } from './sources/calendar/unlocks.js';
import { pollCadence, pollSourceRecheck, pollCliffWatch } from './sources/calendar/cadence-watch.js';
import { startUniverseSweep } from './core/universe.js';
import { classifySymbol } from './core/taxonomy.js';

const ONCE = process.argv.includes('--once');
const startedAt = Date.now();
let alertCount = 0;

function loadWatchlist() {
  const wl = JSON.parse(readFileSync(config.watchlistPath, 'utf8'));
  const byChain = {};
  for (const t of wl.tokens) (byChain[t.chainId] ||= []).push(t.address);
  return byChain;
}

async function pollDex() {
  const byChain = loadWatchlist();
  for (const [chainId, addrs] of Object.entries(byChain)) {
    try {
      const pairs = await getPairsForTokens(chainId, addrs);
      const best = bestPairPerToken(pairs);
      console.log(`[dex] ${chainId}: ${Object.keys(best).length}/${addrs.length} tokens found`);
      notePulse(`dex:${chainId}`);
      if (config.debug) {
        const top = Object.values(best).map(p => ({ s: p.baseToken.symbol, h1: p.priceChange?.h1 || 0, v: p.volume?.h1 || 0 }))
          .sort((a, b) => Math.abs(b.h1) - Math.abs(a.h1)).slice(0, 3);
        for (const t of top) if (t.h1 !== 0 || t.v > 0) console.log(`  [debug] ${chainId} active: ${t.s} ${t.h1 >= 0 ? '+' : ''}${t.h1}% 1h, $${(t.v/1000).toFixed(1)}K vol/1h`);
      }
      for (const pair of Object.values(best)) {
        const alert = checkRevival(pair);
        // Contract-risk screen is BLOCKING and runs before the alert can be scored
        // (spec §3.5). Only paid for on a live candidate, and cached 24h per token,
        // so the cost is a handful of calls a day rather than one per poll.
        if (alert) {
          const rug = await screenContract(pair);
          alert.rug = { status: rug.status, failures: rug.failures };
          if (!rug.pass) {
            // Blocked, but still recorded with forward outcomes. This is the passive
            // calibration set: a hand-picked "known-good thin pool" list would be a
            // survivor sample screened against today's contract state, which is
            // circular. These rows are point-in-time by construction — the verdict is
            // stored as of the alert, and the outcome accrues afterwards. When REVIVAL
            // earns its way back past the floor, the discrimination question is
            // already answerable.
            recordSuppressedRug(alert, rug.status);
            console.log(`  [rug] ${pair.baseToken?.symbol} ${rug.status}: ${rug.failures.join(', ')}`);
          } else if (await dispatch(alert)) alertCount++;
        }
        await checkWhales(pair);
        // Highest-conviction signal: recent exchange withdrawal + live market activity
        if (await checkConfluence(pair, {
          volH1: pair.volume?.h1 || 0,
          volAvgH1: (pair.volume?.h24 || 0) / 24,
          priceH1: pair.priceChange?.h1 || 0,
        })) alertCount++;
      }
    } catch (e) {
      console.error(`[dex] ${chainId} poll failed:`, e.message);
    }
  }
}

// Digest and heartbeat live in core/telemetry.js as of v0.20.0 — two DISTINCT daily
// messages (content vs telemetry), both idempotent-across-restart via persisted,
// delivery-gated markers. Do not reintroduce in-memory sent-flags here.
async function pollAll() {
  const settled = await Promise.allSettled([pollDex(), pollCex(), pollFunding(), pollCascade(), pollAnnouncements(), pollMacro(), pollEvents(), pollUnlocks(), pollUpbit(), pollCadence(), pollSourceRecheck(), pollCliffWatch()]);
  settled.forEach((r, i) => { if (r.status === 'rejected') console.error('[OPERATOR] poller #' + i + ' rejected:', r.reason?.stack || r.reason); });
  await checkPendingListings().catch((e) => console.error('[listing] pending re-check failed:', e.message));
  await checkOutcomes().catch(() => {});
  await heartbeat(startedAt).catch(() => {});
  await verifyCalendar().catch(() => {});
  backupOutcomes();
  await dailyDigest().catch((e) => console.error('[digest] failed:', e.message));
}

// One-time migration: drop EXCLUDE-class symbols already accumulated in ADV. Runs
// INSIDE the bot's own process at startup rather than as an external script, because
// a separate process writing state.json would race the bot's saves (the lost-update
// class). Idempotent and self-marking, so restarts are free.
function purgeExcludedFromAdv() {
  const st = getState();
  if (st.advPurgedAt) return;
  const before = Object.keys(st.adv || {}).length;
  let removed = 0;
  for (const sym of Object.keys(st.adv || {})) {
    const base = String(sym).toUpperCase().replace(/(USDT|USDC|USD|BUSD|KRW|BTC|ETH)$/, '');
    if (classifySymbol(base).state === 'EXCLUDE') { delete st.adv[sym]; removed++; }
  }
  st.advPurgedAt = Date.now();
  save();
  console.log(`[boot] ADV purge: removed ${removed} EXCLUDE-class symbols of ${before} (leveraged tokens / xStocks are not universe members)`);
}

function admitSelfTest() {
  // Boot gate: pushes a synthetic candidate through every admit() path. Any undefined
  // reference becomes a STARTUP failure instead of a silent runtime one — the direct
  // countermeasure to "a patch's exit code is not evidence the function changed."
  return import('./core/budget.js').then(async (b) => {
    const st = getState();
    st.universe ??= {};
    st.universe['selftest:SELFTESTUSDT'] = { at: Date.now(), pass: true, status: 'PASS' };
    const mk = (type, sev, ex, sym) => ({ source: 'CEX', type, severity: sev, key: 'st' + Math.random(), title: 'selftest', lines: [], track: { kind: 'cex', exchange: ex, symbol: sym, price: 1 } });
    // HERMETIC: multipliers are INJECTED (FUNDING 0.83 -> MEDIUM scores 48, below the
    // 55 floor) so the gate asserts code paths deterministically. With live
    // multipliers the verdict moved under the gate — a fresh/restored data dir
    // (mult 1.0, FUNDING-MEDIUM = 58) failed boot exactly when recovering from data
    // loss. The gate tests LOGIC; data conditions are the diagnostic below, non-fatal.
    // v0.23.0: the previous cases used FUNDING and UNLOCK, which are now FACT types —
    // they return on the fact path and never reach the scoring branches, so all three
    // assertions failed and the gate correctly refused to boot. Cases rebuilt around
    // types that still make CALLS (PUMP, CONFLUENCE) plus a fact-path case.
    // NOTE: every RISK_TYPES member is now also a FACT_TYPES member, so the RISK
    // bypass branch inside admit() is unreachable — facts return above it. Tier-A
    // bypass is still reachable, and that is what this exercises.
    // HERMETIC against ALL live data the gate touches: multipliers AND the ladder.
    // 21 Aug: the windowing fix let the live ladder DISABLE PUMP for real (correct
    // behaviour), and the self-test's PUMP cases — hermetic against multipliers only —
    // dropped as ladder-disabled and crash-looped the boot on a data state. Any live
    // state a gate reads is a clock that will eventually strike; inject all of it.
    const SYN_MULT = { PUMP: 0.83, CONFLUENCE: 1.2 };
    const hermetic = (fn) => b.withLadder({}, () => b.withMultipliers(SYN_MULT, fn));
    const cases = [
      ['fact-path', b.admit({ source: 'CEX', type: 'SUSPENSION', severity: 'HIGH', key: 'st' + Math.random(), title: 'selftest', lines: [] }),
        (v) => v.allow && v.kind === 'FACT' && v.charge === false && v.score === undefined],
      ['provisional', hermetic(() => b.admit(mk('PUMP', 'HIGH', 'selftest', 'SELFTESTUSDT'))), (v) => v.allow && v.provisional],
      ['below-floor', hermetic(() => b.admit(mk('PUMP', 'MEDIUM', 'selftest', 'NOGATEUSDT'))), (v) => !v.allow && v.reason === 'below-floor'],
      ['tier-A-bypass', hermetic(() => b.admit({ source: 'SIG', type: 'CONFLUENCE', severity: 'HIGH', key: 'st' + Math.random(), title: 'selftest', lines: [] })), (v) => v.allow && v.bypass && v.tier === 'A'],
      ['ladder-disable-path', b.withLadder({ PUMP: 'DISABLED' }, () => b.withMultipliers(SYN_MULT, () => b.admit(mk('PUMP', 'HIGH', 'selftest', 'SELFTESTUSDT')))),
        (v) => !v.allow && v.reason === 'ladder-disabled'],
      ['sys-pass', b.admit({ source: 'SYS', type: 'HEARTBEAT', severity: 'LOW', key: 'st', title: 'selftest', lines: [] }), (v) => v.allow],
    ];
    delete st.universe['selftest:SELFTESTUSDT'];
    // Non-fatal live-data diagnostic: report where the real multipliers put a
    // single-factor MEDIUM today. Logs, never exits — data is weather, not a bug.
    const liveScore = Math.round(b.scoreOf({ type: 'FUNDING', severity: 'MEDIUM' }));
    console.log(`[boot][diag] live-data: FUNDING-MEDIUM scores ${liveScore} with current multipliers (${liveScore >= 55 ? 'C-tier digest' : 'below-floor'}) — informational only`);
    const failed = cases.filter(([n, v, ok]) => !ok(v));
    if (failed.length) {
      console.error('[OPERATOR][BOOT] admit() self-test FAILED: ' + failed.map(([n]) => n).join(', ') + ' — refusing to start with a broken dispatch path.');
      process.exit(1);
    }
    console.log(`[boot] admit() self-test: ${cases.length}/${cases.length} paths OK`);
  });
}

async function main() {
  load();
  loadOutcomes();
  await admitSelfTest();
  if (!assertTierRoutes()) process.exit(1); // a tier with no reader is a config bug
  console.log('[boot] tier-route assertion: OK (routes.js)');
  const cw = checkClassifiersWired();
  if (!cw.ok) {
    console.error('[OPERATOR][BOOT] classifier not wired: ' + cw.problems.join(' ; ')
      + ' — a path emitting what a classifier classifies must call it; refusing to start.');
    process.exit(1);
  }
  console.log('[boot] classifiers-wired assertion: OK');
  purgeExcludedFromAdv();
  const whaleMode = (config.etherscanKey ? 'evm ' : '') + (config.heliusKey ? 'solana' : '') || 'OFF (no keys)';
  console.log(`Market Radar v${VERSION} starting · poll ${config.pollIntervalSec}s · minSev ${config.minSeverity} · telegram ${config.telegramToken ? 'ON' : 'OFF (console-only)'} · cex [${config.cexExchanges.join(', ')}] · whale ${whaleMode}`);
  startBot();
  startUniverseSweep();
  await pollAll();
  if (ONCE) { console.log('[once] done'); process.exit(0); }
  setInterval(pollAll, config.pollIntervalSec * 1000);
}

main();
