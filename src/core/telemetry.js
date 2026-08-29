// Delivery-layer telemetry, split on purpose (12 Aug fix session):
//   DIGEST   = CONTENT — C-tier signals, deferred listings, digest-tier calendar.
//   HEARTBEAT = TELEMETRY — uptime, funnel, collector ages, bug counter.
// Do not merge them again: merging is how the heartbeat stopped doing its one job
// (making silence falsifiable) and caused two "is the bot broken?" investigations
// in 24 hours while the system was healthy.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { broadcast, hasRecipients } from './telegram.js';
import { formatAlert, dispatchBugCount, messageCounts } from './dispatcher.js';
import { dropStats } from './budget.js';
import { allOutcomes } from './outcomes.js';
import { getState, save } from './store.js';
import { formatPulse, feedWasLooking } from './pulse.js';
import { unclassifiedStats, excludedStats } from './unclassified.js';
import { cadenceStatus } from '../sources/calendar/cadence-watch.js';

const DIGEST_HOUR = Number(process.env.DIGEST_HOUR_UTC ?? 18);

// FIXED UTC day, not rolling 24h: digest day D covers [D-1 18:00Z, D 18:00Z).
// A rolling window made the 12 Aug double-fire produce DIFFERENT content (SHIB 52
// vs 60), which is exactly how the duplicate hid. Fixed boundaries make any
// re-send byte-identical and therefore obviously a duplicate.
export function digestWindow(now = Date.now()) {
  const d = new Date(now);
  const cut = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DIGEST_HOUR);
  return { start: cut - 24 * 3600e3, end: cut, day: new Date(cut).toISOString().slice(0, 10) };
}

// Idempotent across ANY number of restarts: the sent-marker is st.lastDigestDay,
// PERSISTED, and written only AFTER a confirmed successful send (v0.19.2 delivery
// rule). The 12 Aug double-digest was an in-memory flag re-armed by two restarts —
// same mark-done-before-persist family as the broadcast bug.
export function digestDue(st, now = Date.now()) {
  if (new Date(now).getUTCHours() < DIGEST_HOUR) return false;
  return st.lastDigestDay !== digestWindow(now).day;
}

// C-tier price signals are RECORDED-ONLY as of 14 Aug (config.tiers.C) and no longer
// appear here — 11 of 12 slots on 13 Aug were unshrunk-multiplier WHALE rows relocating
// out of the push channel into a daily message. What remains is content a reader can
// act on knowing it was deliberately withheld from push: DIGEST-tier calendar events
// and deferred tier-2 catalysts.
//
// THIS CHANGES THE DIGEST'S SOURCE QUERY ONLY. C-tier candidates still enter the
// outcomes table with their suppression reason and mult stamp — the FLOORED cohort and
// the re-derivation depend on it. Nothing on the recording path may change here.
const DIGEST_REASONS = new Set(['listing-deferred']);
export const digestSources = () => new Set(DIGEST_REASONS); // exported for fixtures
const DIGEST_PER_MODULE = Number(process.env.DIGEST_PER_MODULE ?? 3);
const DIGEST_MAX = 12;

// Pure and exported for replay/tests. PER-MODULE cap (default 3) applies BEFORE the
// global 12-line cap, so one module's tail cannot consume every slot: on 13 Aug,
// WHALE — a module below the n>=100 gate, so scoring an unshrunk default 60 while
// every measured module has been scaled DOWN — took 11 of 12 slots with the same
// tokens (EIGEN, ZRO, SHIB) that were auto-suppressed from pushes. They didn't stop;
// they relocated into the digest. Truncation is DISCLOSED, never silent.
export function selectDigestItems(rows, perMod = DIGEST_PER_MODULE, max = DIGEST_MAX) {
  const by = {};
  for (const r of rows) {
    const k = r.type + ' ' + (r.symbol || '?');
    if (!by[k] || (r.score ?? 0) > (by[k].score ?? 0)) by[k] = r;
  }
  const byType = {};
  for (const r of Object.values(by)) (byType[r.type] ??= []).push(r);
  const kept = [];
  const cut = {};
  for (const [type, list] of Object.entries(byType)) {
    list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    kept.push(...list.slice(0, perMod));
    if (list.length > perMod) cut[type] = list.length - perMod;
  }
  const items = kept.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, max);
  const overflow = kept.length - items.length;
  let cutLine = '';
  const parts = Object.entries(cut).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} more ${t}`);
  if (parts.length) cutLine = `+ ${parts.join(', ')} (capped at ${perMod}/module)`;
  if (overflow > 0) cutLine += `${cutLine ? ' · ' : '+ '}${overflow} more cut by the ${max}-line cap`;
  return { items, cutLine };
}

export async function dailyDigest() {
  const st = getState();
  if (!digestDue(st)) return;
  const { start, end, day } = digestWindow();
  const rows = allOutcomes().filter((r) => r.ts >= start && r.ts < end && DIGEST_REASONS.has(r.suppressed));
  const { items, cutLine } = selectDigestItems(rows);
  // Fix 3: DIGEST-tier calendar events reach a reader here (routed via st.digestPool).
  const calItems = (st.digestPool || []).filter((e) => e.ts >= start && e.ts < end);
  // CONDITIONAL: no payload, no message. Most days this is silent, and that is not a
  // regression in falsifiability — the HEARTBEAT still fires daily with uptime, funnel,
  // bug counter and collector ages. Content is conditional; telemetry never is.
  // The day-marker is NOT set on an empty pool, so a catalyst arriving at 20:00 still
  // gets its digest today rather than waiting for tomorrow's window.
  if (!items.length && !calItems.length) {
    console.log(`[digest] nothing to report for ${day} — no message sent (heartbeat still carries liveness)`);
    return;
  }
  const lines = [];
  if (calItems.length) {
    lines.push('— calendar (digest tier, never pushed by design) —');
    for (const e of calItems) lines.push(e.title);
  }
  if (items.length) {
    lines.push('— deferred catalysts (tier-2 venue, awaiting liquidity evidence) —');
    for (const r of items) lines.push(`${r.type} ${r.symbol || ''} · ${r.severity} · deferred pending T+30m re-check`);
    if (cutLine) lines.push(cutLine);
  }
  lines.push('Digest = context, not pushes; nothing here carries a recommendation.');
  lines.push('C-tier price signals are recorded-only and deliberately absent — measured, not messaged.');
  const ids = await broadcast(formatAlert({
    source: 'SYS', type: 'DIGEST', severity: 'LOW',
    title: `Daily digest ${day} — ${items.length + calItems.length} item(s) · window ${new Date(start).toISOString().slice(5, 16)}Z → ${new Date(end).toISOString().slice(5, 16)}Z`,
    lines,
  }));
  const done = ids.length || !hasRecipients();
  if (done) { st.lastDigestDay = day; save(); }
  console.log(`[digest] ${done ? 'sent' : 'DELIVERY FAILED, will retry'}: ${items.length} signal + ${calItems.length} calendar item(s)`);
}

// Digest liveness, for the heartbeat. Narrowing the digest to calendar events and
// deferred catalysts means the send path can now go DAYS without executing — the
// CASCADE problem relocated: a rarely-exercised path whose failure is invisible,
// because a PPI event that never arrived looks exactly like a quiet day. So the
// heartbeat reports the pool alongside the last send: a non-empty pool with no send
// is immediately visible, and a long gap reads as "nothing qualified" rather than
// ambiguous silence. Same reasoning as per-collector last-success ages.
export function digestStatus(st, now = Date.now(), rows = null) {
  const { start, end, day } = digestWindow(now);
  const src = rows ?? allOutcomes();
  const pool = (st?.digestPool || []).filter((e) => e.ts >= start && e.ts < end).length
    + src.filter((r) => r.ts >= start && r.ts < end && DIGEST_REASONS.has(r.suppressed)).length;
  const last = st?.lastDigestDay;
  const daysAgo = last ? Math.round((Date.parse(day) - Date.parse(last)) / 86400e3) : null;
  const sentThisWindow = last === day;
  const overdue = pool > 0 && !sentThisWindow && new Date(now).getUTCHours() >= DIGEST_HOUR;
  return {
    pool, last, daysAgo, overdue,
    line: `Digest: pool ${pool} today · last sent ${last ? (daysAgo === 0 ? 'today' : `${daysAgo}d ago`) : 'never'}`
      + (overdue ? ' · ⚠️ POOL NON-EMPTY BUT NOT SENT — check the digest path' : ''),
  };
}

// ACCUMULATORS — things that accrue silently and are read WEEKS later: ADV (~30d to
// maturity), MFE/MAE (~2w), the FLOORED cohort, the passive rug calibration set, the
// mult stamp, and the daily backups. Every one has the write-only profile: it fails
// silently and the lapse is indistinguishable from success until the day you need the
// data and find three weeks missing. Backups are the highest-stakes member — an
// unverified backup is a belief, not a safeguard, and you discover it during a
// recovery, the worst possible moment and the one it exists for.
// Reported daily so a stall surfaces tomorrow instead of on day thirty.
export function accumulatorStatus(now = Date.now(), deps = {}) {
  const rows = deps.rows ?? allOutcomes();
  const st = deps.st ?? getState();
  const since = (h) => now - h * 3600e3;
  const count = (f, h) => rows.filter((r) => r.ts >= since(h) && f(r)).length;
  const acc = {
    floored: [count((r) => r.collectedUnder === 'FLOORED', 24), count((r) => r.collectedUnder === 'FLOORED', 48)],
    mfe: [count((r) => r.mfe !== undefined, 24), count((r) => r.mfe !== undefined, 48)],
    mult: [count((r) => r.mult !== undefined && r.mult !== null, 24), count((r) => r.mult !== undefined && r.mult !== null, 48)],
    rugcal: [count((r) => String(r.suppressed || '').startsWith('rug:'), 24), count((r) => String(r.suppressed || '').startsWith('rug:'), 48)],
  };
  let advCells = 0;
  for (const s of Object.values(st.adv || {})) advCells += Object.keys(s || {}).length;
  // STALLED = nothing in 48h. Anything genuinely intermittent (rugcal fires only on
  // blocked DEX candidates) would otherwise cry wolf, so 48h is the bar.
  // COMPANION (absence-of-observation class): a zero accumulator with ZERO rows in
  // 48h is a quiet funnel, not a broken recorder — the two need different responses
  // (investigate collectors vs investigate the accumulator), so the line says which.
  const rows48 = rows.filter((r) => r.ts >= since(48)).length;
  const stalled = rows48 > 0 ? Object.entries(acc).filter(([, [, d48]]) => d48 === 0).map(([k]) => k) : [];
  const b = deps.backup ?? backupStatus(now);
  return {
    acc, advCells, stalled, rows48, backup: b,
    lines: [
      `Accumulators (24h): floored +${acc.floored[0]} · mfe/mae +${acc.mfe[0]} · mult +${acc.mult[0]} · rugcal +${acc.rugcal[0]} · adv ${advCells} cells`
        + (stalled.length ? ` · 🚨 STALLED 48h: ${stalled.join(', ')} (${rows48} rows flowing — recorder problem, not a quiet market)` : '')
        + (rows48 === 0 ? ' · ⚠️ zero rows 48h — nothing to accumulate; check collectors, not accumulators' : ''),
      `Backup: ${b.newestAgeH === null ? '🚨 NONE FOUND' : `newest ${b.newestAgeH.toFixed(1)}h ago`} · ${b.count} retained`
        + (b.stale ? ' · 🚨 OVER 26h — daily snapshot did not run' : '')
        + ` · restore-verified ${b.drillAgeD === null ? '🚨 never recorded' : `${b.drillMark ? b.drillMark + ' ' : ''}${b.drillAgeD.toFixed(0)}d ago${b.drillAgeD >= 30 ? ' — re-run node restore-drill.js' : ''}`}`,
    ],
  };
}

export function backupStatus(now = Date.now(), dir = join(config.dataDir, 'backups')) {
  let newestAgeH = null, count = 0;
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'));
    count = files.length;
    let newest = 0;
    for (const f of files) { const m = statSync(join(dir, f)).mtimeMs; if (m > newest) newest = m; }
    if (newest) newestAgeH = (now - newest) / 3600e3;
  } catch { /* dir missing => newestAgeH stays null, which reports as NONE FOUND */ }
  // Read from the drill's OWN file, which restore-drill.js stamps on success. Not
  // state.json: a separate process writing that would be clobbered by the bot's next
  // save. And not hand-set — a remembered timestamp decays into a stale reassurance.
  let drill = null;
  try { drill = JSON.parse(readFileSync(join(config.dataDir, 'restore-drill.json'), 'utf8')).at; } catch { /* never run */ }
  // Drill age needs its own threshold, or "it ages from here" never actually goes
  // loud — same reasoning as 26h for backups and 48h for accumulators. Monthly:
  // 30d warns, 60d escalates, never-run is already the loudest state.
  const drillAgeD = drill ? (now - drill) / 86400e3 : null;
  const drillMark = drillAgeD === null ? '🚨' : drillAgeD >= 60 ? '🚨' : drillAgeD >= 30 ? '⚠️' : '';
  return {
    newestAgeH, count,
    stale: newestAgeH === null || newestAgeH > 26,
    drillAgeD, drillMark,
    drillStale: drillAgeD === null || drillAgeD >= 30,
  };
}

// Pure builder so the "fires on empty state" property is testable without a bot.
export function buildHeartbeat(now = Date.now(), deps = {}) {
  const rows = (deps.rows ?? allOutcomes()).filter((r) => r.ts >= now - 24 * 3600e3);
  const pushed = rows.filter((r) => !r.suppressed).length;
  const hoursCovered = new Set(rows.map((r) => new Date(r.ts).toISOString().slice(0, 13))).size;
  const d = deps.drops ?? dropStats(24);
  const supLine = Object.entries(d.byReason || {}).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v]) => `${v} ${k}`).join(' · ') || 'none';
  const bugs = deps.bugs ?? dispatchBugCount();
  const aliveH = ((now - (deps.startedAt ?? now)) / 3600e3).toFixed(1);
  return {
    title: `alive ${aliveH}h · row-coverage uptime ${Math.min(100, Math.round((hoursCovered / 24) * 100))}% (24h)`,
    lines: [
      `Candidates: ${rows.length} in · ${pushed} pushed (24h)`,
      (() => {
        const m = deps.counts ?? messageCounts();
        const factRows = rows.filter((r) => r.kind === 'FACT' && !r.suppressed).length;
        // Facts do not depend on expectancy, so they should never ALL stop. Zero facts
        // is a detector problem, not a quiet market — same instrument treatment as a
        // stale collector.
        return `Messages: ${m.facts} facts · ${m.calls} calls this run (${factRows} fact rows 24h)`
          + (factRows === 0 && rows.length > 20 ? ' · 🚨 ZERO FACTS with a live funnel — detector problem' : '')
          + (m.calls === 0 ? ' · no module has earned a call (expected)' : '');
      })(),
      `Suppressed: ${supLine}`,
      `Internal errors: ${bugs}${bugs ? ' 🚨 check the log' : ''}`,
      `Collectors (age of last success): ${deps.pulse ?? formatPulse()}`,
      // "Nothing happened" is only evidence with an "and we were looking" companion
      // (absence of observation isn't observation of absence — the windowObserved()
      // class). A zero here with no live text feed is a broken logger wearing a
      // clean bill of health. Text feeds = everything except dex/funding/macro.
      (() => {
        const u = deps.unclassified ?? unclassifiedStats(now);
        const looking = deps.feedLooking ?? feedWasLooking(/^(?!dex:|funding$|macro$).+/);
        return `Unclassified announcements: ${u.shapes} shapes · ${u.recurring} recurring · ${u.seen24h} seen 24h`
          + (u.recurring >= 5 ? ' · ⚠️ review: node review-unclassified.js' : '')
          + (u.seen24h === 0 && !looking ? ' · 🚨 zero with NO live text feed — not looking, not clean' : '');
      })(),
      (() => {
        // EXCLUDE is a silent drop; without this line a wrong exclusion is invisible.
        const x = deps.excluded ?? excludedStats(now);
        const looking = deps.feedLooking ?? feedWasLooking(/^(?!dex:|funding$|macro$).+/);
        return `Excluded symbols: ${x.total} (${x.leveraged} leveraged · ${x.equity} xStock) · ${x.seen24h} in 24h`
          + (x.overdue ? ` · ${x.mark} ${x.xstockSinceReview} xStock unreviewed ${x.reviewAgeD === null ? '(never reviewed)' : `for ${x.reviewAgeD.toFixed(0)}d`} — run node review-exclusions.js` : '')
          + (x.seen24h === 0 && !looking ? ' · 🚨 zero with NO live text feed — not looking, not clean' : '');
      })(),
      // Behavioural rows carry their falsifier; this line is the falsifier's own
      // pulse — a cadence watch that stops confirming must be visible, not assumed.
      (deps.cadence ?? cadenceStatus()).line,
      (deps.digest ?? digestStatus(getState(), now, deps.rows ?? null)).line,
      ...(deps.accumulators ?? accumulatorStatus(now, { rows: deps.rows ?? undefined })).lines,
      'Reading: healthy funnel + no pushes = correctly quiet. Empty funnel, a stale collector, an unsent non-empty digest pool, a stalled accumulator or a missing backup = broken — investigate.',
    ],
  };
}

// Fires on schedule EVEN WHEN EVERY NUMBER IS ZERO — a heartbeat that only appears
// when there is something to say is not a heartbeat. Marker persisted + delivery-
// gated, same rule as the digest. DM-only: telemetry is operator noise, not signal.
export async function heartbeat(startedAt) {
  if (!config.heartbeatHours) return;
  const st = getState();
  if (st.lastHeartbeatTs && Date.now() - st.lastHeartbeatTs < config.heartbeatHours * 3600e3) return;
  const hb = buildHeartbeat(Date.now(), { startedAt });
  const ids = await broadcast(formatAlert({
    source: 'SYS', type: 'HEARTBEAT', severity: 'LOW', title: hb.title, lines: hb.lines,
  }), { toChannel: false });
  if (ids.length || !hasRecipients(false)) { st.lastHeartbeatTs = Date.now(); save(); }
}
