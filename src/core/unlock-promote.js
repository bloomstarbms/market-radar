// PROMOTION CONSTRUCTS, NEVER PATCHES.
//
// When a row moves estimated -> verified, the new row is BUILT from verified fields
// only — a whitelist copy, same mechanism as recordAlert's row literal. The first
// live push (23 Aug) carried '~4.97% of market cap': a stale aggregator pctOfMcap
// inherited from the row's estimated era because promotion had edited the date in
// place. That field was caught by a human reading the message; the next stale field
// survives unless promotion itself refuses to carry anything unverified.
// "Verify the fields, not just the date" — enforced by shape, not vigilance.

// Fields a VERIFIED row may carry. Everything else from the estimated era is dropped.
// NOTE SPLIT (message diet, 2026-09-18): `note` is PUBLIC context and renders in the
// channel; `operatorNote` is the build log — architecture vocabulary, provenance
// mechanics — and renders only in the operator DM. Every live note was operator
// prose, so promote-unlock.js note-split moved them all; `note` starts empty.
export const VERIFIED_ROW_FIELDS = ['sym', 'name', 'monthlyDay', 'date', 'verified', 'note', 'operatorNote', 'events', 'retired', 'retiredAt', 'cadence', 'enforcement', 'reviewBy', 'stage', 'alsoObserve', 'sourceHistory', 'chain', 'token', 'contract', 'clusterSpec', 'cliffDates', 'upgradeable', 'falsifier'];
// Estimated-era fields that must NEVER appear on a verified row (boot-asserted).
export const ESTIMATED_ONLY_FIELDS = ['pctOfMcap'];

// SOURCED tier (2026-09-05): a NAMED third party publishes the schedule and the
// message says so. Not verified — it never carries events[] (that field means
// "independently confirmed") — and not estimated (it pushes, labelled). Its
// falsifier is the source itself: re-read weekly, stale at 21 days. A sourced row
// without source + sourceFetchedAt is refused at promotion and at boot, the same
// shape discipline as a verified row without a forward falsifier.
export const SOURCED_ROW_FIELDS = ['sym', 'name', 'provenance', 'source', 'sourceFetchedAt', 'sourceEvents', 'chain', 'token', 'stage', 'note', 'operatorNote', 'circSupply', 'totalLocked', 'maxSupply', 'mechanism', 'mechanismBasis'];
// MECHANISM (v0.30.1). Route 2 found by failing that a sourced date can describe
// three different things on chain: a custody batch, a cliff-gated claim, or NOTHING
// DISCRETE — a continuous-claim stream the index has discretised (L3), or a date the
// contract contradicts outright (REZ). A sourced row is therefore 'pending' (could
// still be verified by a route) or unverifiable BY MECHANISM — and the latter is not
// "the source is unreliable", it is "the event it names does not exist as an event".
// Unverifiable rows route to LOGGED: pushing a date that corresponds to nothing on
// chain is the defect, not the silence. The stamp is written through promote-unlock.js
// from the cliff-cluster report (evidence), never typed.
export const MECHANISMS = ['pending', 'continuous-claim', 'index-contradicted', 'cliff-gated', 'custody-batch'];
export const UNVERIFIABLE_MECHANISMS = ['continuous-claim', 'index-contradicted'];
// Pure: does the cluster report SUPPORT the mechanism label? continuous-claim needs a
// wide claimant base with claims on most days and no parameterisation reaching 2/3;
// index-contradicted needs every covered index cliff to show no cluster while the
// contract DID cluster elsewhere (otherwise it is merely quiet, which proves nothing).
export function mechanismEvidence(mechanism, results, pastCliffs) {
  const best = results.slice().sort((a, b) => (b.distinctRecipients || 0) - (a.distinctRecipients || 0))[0];
  if (!best) return { ok: false, why: 'no result rows' };
  const grid = best.grid || [];
  const maxFrac = Math.max(0, ...grid.map((g) => g.hits / g.n));
  if (mechanism === 'continuous-claim') {
    const ok = (best.distinctRecipients || 0) >= 100 && best.n >= 3 && grid.length >= 9 && maxFrac < 2 / 3 && (best.activeDayFrac ?? 1) >= 0.8;
    return { ok, why: ok ? '' : `needs >=100 claimants (${best.distinctRecipients}), n>=3 (${best.n}), full grid (${grid.length}), max replay <2/3 (${maxFrac.toFixed(2)})`,
      basis: `${best.distinctRecipients} distinct claimants pull from ${String(best.contract).slice(0, 10)} on ${Math.round((best.activeDayFrac ?? 1) * 100)}% of days; best replay ${maxFrac.toFixed(2)} of ${best.n} index cliffs across ${grid.length} parameterisations — a stream, not a cliff` };
  }
  if (mechanism === 'index-contradicted') {
    const none = (best.perCliff || []).length >= 3 && best.perCliff.every((c) => !c.cluster) && grid.every((g) => g.hits === 0);
    const off = best.offIndexClusters || [];
    const ok = none && off.length >= 1;
    return { ok, why: ok ? '' : `needs 0 on-index clusters at every parameterisation with >=3 cliffs (${best.hits}/${best.n}) AND >=1 off-index cluster (${off.length})`,
      basis: `0/${best.n} index cliffs (${pastCliffs.join(', ')}) show a claim cluster from ${String(best.contract).slice(0, 10)} at any of ${grid.length} parameterisations, while the contract clustered ${off.length}x off-index (${off.map((o) => o.from + ' ' + o.ratio + 'x/' + o.recipients + 'r').join(', ')}) — the listed dates are not where the claims are` };
  }
  return { ok: false, why: `mechanism '${mechanism}' is not stamped by this path` };
}
export function mechanismProblems(t) {
  const p = [];
  if (t.mechanism != null && !MECHANISMS.includes(t.mechanism)) p.push(`unknown mechanism '${t.mechanism}'`);
  if (t.mechanism && t.mechanism !== 'pending' && !t.mechanismBasis) p.push('a non-pending mechanism needs mechanismBasis (evidence from the cluster report)');
  if (UNVERIFIABLE_MECHANISMS.includes(t.mechanism) && t.stage !== 'LOGGED') p.push(`mechanism '${t.mechanism}' has no discrete event to announce — stage must be LOGGED`);
  return p;
}
export const SOURCE_STALE_DAYS = 21;

export function sourcedRowProblems(t) {
  const p = [];
  if (!t.source) p.push('sourced row has no source name');
  if (!t.sourceFetchedAt || !Number.isFinite(Date.parse(t.sourceFetchedAt))) p.push('sourced row has no parseable sourceFetchedAt');
  if (!Array.isArray(t.sourceEvents) || !t.sourceEvents.length) p.push('sourced row has no sourceEvents');
  if (Array.isArray(t.events) && t.events.length) p.push('sourced row carries events[] — that field means VERIFIED; a row cannot be both');
  if (t.verified === true) p.push('sourced row is marked verified:true');
  if (!t.chain) p.push('sourced row has no chain (use "unconfirmed" until resolved — a wrong chain reads as "no locked supply", silently)');
  if (t.stage === 'FULL') p.push('sourced rows cannot be FULL: T-14 and T+3 assume observation a sourced row cannot make');
  p.push(...mechanismProblems(t));
  return p;
}
// SOURCED PRESSURE FLOOR (Route 2, Part 6). FORT went LOGGED by hand in v0.29.0 —
// weekly 0.005%-of-supply farming drips are not pressure — and a hand rule is a
// second undischarged constant. The floor is DERIVED from the index distribution and
// recorded here as a static, with its basis, exactly like a cadence tolerance: the
// 25th percentile of tranche / maxSupply over every sourced event ingested.
// Re-derive with derivePressureFloor() when the index is refreshed; record the new
// value, do not let the floor move under the rows at runtime.
export const SOURCED_PRESSURE_FLOOR = {
  pctOfMaxSupply: 0.0585,
  percentile: 15,
  n: 30,
  basis: '15th percentile of PER-ROW MEDIAN tranche/maxSupply across 30 sourced rows, index 2026-09-15T03:49 (p5 0.0137 p25 0.1419 p50 0.824); statistic is per-row because the floor is APPLIED to a row median. Re-derived 2026-09-15 when ORDER (median 0.05) returned to the sourced population by tier correction: was 0.0688/n29; CFG (0.0585) now sits exactly AT the floor — its stored LOGGED stage is unchanged, a re-ingest would default it STANDARD',
};
export const NON_PRESSURE_CATS = ['farming', 'staking'];
// PER-ROW, not per-event. The first derivation (v0.30.0) took the percentile over
// every sourced EVENT, which meant a protocol listing 155 daily drips (TIA) counted
// 155 times and a protocol listing 5 quarterly cliffs counted 5. The 2026-09-07
// index refresh exposed it: the per-event floor moved 0.061 -> 0.014 on a snapshot
// whose population had not changed, while the per-row figure was identical on both
// snapshots (p25 0.2775, p50 0.824, n=29). The deeper reason it was wrong: the floor
// is APPLIED to a row's median tranche, so it must be DERIVED from the distribution
// of row medians — the old version compared two different quantities.
// The PERCENTILE (15) is a declared choice, not a derived one: it was picked to hold
// the reviewed silence set constant across the statistic change (FORT, TIA, ASTER,
// CFG by size; FXN by category). Same status as WEAK_CHANCE — the numbers are the
// fact, the cut is a decision.
export function derivePressureFloor(tokens, percentile = 15) {
  const meds = [];
  for (const t of tokens || []) {
    const evs = t.sourceEvents || t.sourceHistory?.sourceEvents || [];
    if (!t.maxSupply || !evs.length) continue;
    const pcts = evs.filter((e) => e.n > 0).map((e) => 100 * e.n / t.maxSupply).sort((a, b) => a - b);
    if (pcts.length) meds.push(pcts[Math.floor(pcts.length / 2)]);
  }
  meds.sort((a, b) => a - b);
  if (!meds.length) return null;
  return { pctOfMaxSupply: +meds[Math.floor(meds.length * percentile / 100)].toFixed(4), percentile, n: meds.length };
}
// Pure: the stage the pressure rule assigns to a sourced row. LOGGED when the row's
// median tranche is below the floor, or when every tranche is farming/staking-only
// (emissions to stakers are not sell-side supply arriving at once). Otherwise the
// row's own stage. A row with no maxSupply cannot be sized -> its own stage (we did
// not look is not "small").
export function pressureStage(t, floor = SOURCED_PRESSURE_FLOOR) {
  if (UNVERIFIABLE_MECHANISMS.includes(t?.mechanism)) return 'LOGGED';
  const evs = t?.sourceEvents || [];
  if (!evs.length) return t?.stage ?? 'STANDARD';
  const catsOf = (e) => String(e.cats || '').split('+').filter(Boolean);
  const nonPressure = evs.every((e) => { const c = catsOf(e); return c.length && c.every((x) => NON_PRESSURE_CATS.includes(x)); });
  if (nonPressure) return 'LOGGED';
  if (!t.maxSupply) return t.stage ?? 'STANDARD';
  const pcts = evs.map((e) => 100 * e.n / t.maxSupply).sort((a, b) => a - b);
  const median = pcts[Math.floor(pcts.length / 2)];
  return median < floor.pctOfMaxSupply ? 'LOGGED' : (t.stage ?? 'STANDARD');
}

// STALENESS LADDER (v0.31.1). The 21-day cliff is correct but silent until it bites:
// on day 20 the heartbeat says nothing and on day 22 twenty-nine rows have gone
// quiet. Warn BEFORE biting, same shape as the reviewBy ⚠️T-14/🚨T-3 ladder. The
// refresh is a manual browser-pane operation (defillama.com 403s from both the
// sandbox and the desktop), so the warning states the action, not just the fact.
export const SOURCE_WARN_DAYS = 14;   // ⚠️  one week of slack left
export const SOURCE_URGENT_DAYS = 18; // 🚨  three days of slack left
export function sourceFreshness(t, now = Date.now()) {
  const at = Date.parse(t?.sourceFetchedAt);
  if (!Number.isFinite(at)) return { level: 'UNPARSEABLE', ageDays: null, daysLeft: null };
  const ageDays = Math.floor((now - at) / 86400e3);
  const daysLeft = SOURCE_STALE_DAYS - ageDays;
  const level = ageDays > SOURCE_STALE_DAYS ? 'STALE' : ageDays >= SOURCE_URGENT_DAYS ? 'URGENT'
    : ageDays >= SOURCE_WARN_DAYS ? 'WARN' : 'FRESH';
  return { level, ageDays, daysLeft };
}
// The cliff DELEGATES to the ladder. They were two implementations of one rule and
// disagreed at exactly 21 days (ms-vs-whole-days), which is how a row could be
// silenced while the heartbeat still showed URGENT. One rule, one place.
export function sourceIsStale(t, now = Date.now()) {
  const { level } = sourceFreshness(t, now);
  return level === 'STALE' || level === 'UNPARSEABLE';
}

// Pure constructor for a sourced row — whitelist copy, same discipline as promoteRow.
// TIER CORRECTION (2026-09-15): a verified row may return to sourced ONLY with a
// stated reason, and the verification it held travels as tierHistory — recorded, not
// deleted, the same discipline as a voided verdict. ORDER was the first: its
// falsifier margin (0.17; best point on its own grid 0.26) sits outside the verified
// population (EIGEN 0.76, ENA 0.67, MOVE 0.64) — see MIN_FALSIFIER_MARGIN.
export const TIER_CORRECTION_MIN_REASON = 20;
export function sourceRow(oldRow, { source, sourceFetchedAt, sourceEvents, chain, token = null, stage = 'STANDARD', note = '', circSupply = null, totalLocked = null, maxSupply = null, mechanism = 'pending', mechanismBasis = null, tierCorrection = null, operatorNote = null }) {
  if (!oldRow?.sym) throw new Error('sourceRow: no sym');
  if (oldRow.retired) throw new Error(`sourceRow: ${oldRow.sym} is RETIRED`);
  const wasVerified = Array.isArray(oldRow.events) && oldRow.events.length > 0;
  if (wasVerified && !(typeof tierCorrection?.reason === 'string' && tierCorrection.reason.trim().length >= TIER_CORRECTION_MIN_REASON)) {
    throw new Error(`sourceRow: ${oldRow.sym} is VERIFIED — a verified row returns to sourced only as a TIER CORRECTION with a stated reason (>=${TIER_CORRECTION_MIN_REASON} chars)`);
  }
  if (!wasVerified && tierCorrection) throw new Error(`sourceRow: ${oldRow.sym} is not verified — nothing to correct`);
  const row = { sym: oldRow.sym, name: oldRow.name, provenance: 'sourced', source, sourceFetchedAt, sourceEvents, chain, stage, note, mechanism };
  if (operatorNote) row.operatorNote = operatorNote;
  if (wasVerified) {
    // The verification the row held travels whole — events, spec, per-cliff replay,
    // stamped falsifier — the same way a sourced row superseded by a verified one keeps
    // its source events. And the EVIDENCE the decision was made on (the grid with a
    // margin per point, against the bar) sits beside the reason: a row that carried a
    // clusterSpec is refused without it, because "the grid" as a reason with no grid
    // on the row is a claim a future session cannot check without re-deriving it.
    const retracted = {};
    for (const k of ['events', 'note', 'enforcement', 'contract', 'clusterSpec', 'cadence', 'reviewBy', 'falsifier', 'cliffDates', 'upgradeable', 'alsoObserve']) if (oldRow[k] !== undefined) retracted[k] = oldRow[k];
    const ev = tierCorrection.evidence ?? null;
    if (oldRow.clusterSpec && !(ev?.grid?.points?.length)) throw new Error(`sourceRow: ${oldRow.sym} carried a clusterSpec — its tier correction must carry the grid margins as evidence (clusterGridMargins over data/cliff-cluster-report.json)`);
    row.tierHistory = { from: 'verified', retractedAt: new Date().toISOString().slice(0, 10), reason: tierCorrection.reason.trim(), retracted };
    if (ev) row.tierHistory.evidence = { bar: MIN_FALSIFIER_MARGIN, ...ev };
  }
  if (mechanismBasis) row.mechanismBasis = mechanismBasis;
  if (token) row.token = token;
  if (circSupply != null) row.circSupply = circSupply;
  if (totalLocked != null) row.totalLocked = totalLocked;
  if (maxSupply != null) row.maxSupply = maxSupply;
  const p = sourcedRowProblems(row);
  if (p.length) throw new Error(`sourceRow: ${p.join('; ')}`);
  return row;
}

// CADENCE PROVENANCE IS INDUCTIVE: a vesting contract is a COMMITMENT (enforced);
// a 13-month metronome is a HABIT (nothing binds custody to continue it). It is the
// one provenance class that can go stale SILENTLY, so a row verified by cadence must
// carry a machine-checkable spec — cadence-watch.js demotes it automatically when a
// window passes empty. A prose demote-trigger in `note` is memory-dependent, which is
// the quarantine-lapse shape. Enforced here BY SHAPE: onchain-cadence without a spec
// cannot be promoted, and verifiedRowProblems() re-asserts it at boot.
export function cadenceSpecProblems(spec) {
  if (!spec || typeof spec !== 'object') return ['missing cadence spec'];
  const p = [];
  // A FAMILY spec (wallets[]) exists so the falsifier covers what the message
  // claims: watching one wallet while asserting a family total leaves a silent
  // wallet undetectable. Single-wallet specs remain valid when the claim is
  // single-wallet too.
  if (Array.isArray(spec.wallets)) {
    if (!spec.wallets.length) p.push('cadence.wallets is empty');
    for (const w of spec.wallets) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(w?.addr || '')) p.push(`cadence.wallets[].addr must be a full address (got '${w?.addr}')`);
      if (!(w?.meanAmount > 0)) p.push(`cadence.wallets[${w?.addr?.slice(0, 10)}].meanAmount required`);
    }
    if (spec.tolerance !== undefined && !(spec.tolerance > 0 && spec.tolerance < 1)) p.push('cadence.tolerance must be between 0 and 1');
    if (spec.tolerance !== undefined && !spec.toleranceBasis) p.push('cadence.tolerance needs toleranceBasis — a band with no stated derivation is a constant fitted to whichever row it was written for');
  } else if (!/^0x[0-9a-fA-F]{40}$/.test(spec.wallet || '')) {
    p.push('cadence needs wallet (full address) or wallets[]');
  } else if (!(spec.meanAmount > 0)) {
    p.push('cadence.meanAmount required (qualifying threshold = 50% of it)');
  }
  if (!spec.monthEnd && !(Number.isInteger(spec.expectDay) && spec.expectDay >= 1 && spec.expectDay <= 28))
    p.push('cadence needs expectDay 1-28 or monthEnd:true');
  if (!(spec.monthsObserved >= 4)) p.push('cadence.monthsObserved >= 4 required — it is the evidence the message cites');
  return p;
}

// ADDRESSES ARE RESOLVED, NEVER TYPED. Two fabricated address tails reached promotion
// commands in one day — recalled from context instead of copied from tool output. A
// rule ("always copy") is memory-dependent; this makes fabrication structurally
// impossible: the wallet argument is a REFERENCE (prefix or full address) resolved
// against addresses that discovery/cadence tools actually wrote. An address absent
// from every report cannot be promoted, however plausible it looks. EIP-55 checksum
// would not catch this class (lowercase fabrications pass), so provenance is the fix.
// Pure — knownAddresses injected by the caller from the report files.
export function resolveWalletRef(ref, knownAddresses) {
  if (!ref || !/^0x[0-9a-fA-F]{4,40}$/.test(ref)) throw new Error(`resolveWalletRef: '${ref}' is not an address or address prefix`);
  const matches = [...new Set(knownAddresses || [])].filter((a) => a.toLowerCase().startsWith(ref.toLowerCase()));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`resolveWalletRef: '${ref}' matches no address in any discovery/cadence report — addresses come from tool output, never from memory. Run the discovery tool first.`);
  throw new Error(`resolveWalletRef: '${ref}' is ambiguous (${matches.length} report addresses match) — give more characters`);
}

// THE PROVENANCE LABEL DESCRIBES DISCOVERY, NOT ENFORCEMENT. EIGEN's
// 'announcement+onchain-backtest' sounded stronger than ENA's 'onchain-cadence' —
// but the backtest verified the PAST, and nothing contractual binds a custody wallet
// forward. The rule generalizes past the label: any schedule not enforced by a
// contract carries an automatic falsifier —
//   cadence spec      where emissions are observable (preferred), or
//   reviewBy date     a dead-man's switch where they are not (ZRO: omnichain, no
//                     Ethereum emission path — a cadence spec would false-demote by
//                     construction; the row instead demotes if the date passes
//                     without deliberate re-promotion).
// A row may declare enforcement:'contract' ONLY when the schedule is enforced
// on-chain; everything else must carry one of the two. Boot refuses the rest.
// ROUTE 2 (2026-09-05): enforcement:'contract' is EARNED, never declared. A row may
// carry it only with a contract address, a cluster spec (the forward falsifier: the
// next cliff's post-cliff claim cluster), and backtested cliff dates. ORDER's
// LockedTokenVault was the first — and (2026-09-15) the last so far: its margin never
// cleared the admission bar, so the label is again CLAIMABLE BY NOBODY. The method
// stands (clusterVerdicts, chanceRate, clusterMargin all remain and are tested); it
// has not yet produced a row that clears the bar. clusterSpecProblems is kept so a
// future spec is still shape-checked before anyone argues about its margin.
export function clusterSpecProblems(spec) {
  if (!spec || typeof spec !== 'object') return ['missing clusterSpec'];
  const p = [];
  for (const k of ['windowDays', 'minRatio', 'minRecipients', 'baselineDaily']) if (!(spec[k] > 0)) p.push(`clusterSpec.${k} required (>0)`);
  if (!spec.basis) p.push('clusterSpec.basis required — parameters are derived, not asserted');
  if (!(spec.n >= 3)) p.push('clusterSpec.n >= 3 required (backtested cliffs)');
  return p;
}
// A presence test on an index date is near-vacuous when the contract clusters so
// often that a random window of the same length would catch one anyway. Chance
// rate = clusters (on + off index) x windowDays / covered span. ORDER: 13 clusters
// over 113 days, w5 -> 0.58; its 6/8 = 0.75 replay was barely above chance
// (margin 0.17). Derived, recorded, not felt — and, since 2026-09-15, below the
// admission bar: such a row is sourced, not "verified but weak".
export function chanceRate(spec) {
  if (!spec || !(spec.spanDays > 0) || !Number.isFinite(spec.offIndex)) return null;
  return +Math.min(1, (spec.hits + spec.offIndex) * spec.windowDays / spec.spanDays).toFixed(2);
}
// The whole grid, with a margin per point — the evidence a tier decision is made on.
// Pure over a cliff-cluster report result ({grid:[{windowDays,minRatio,hits,n,off}],
// spanDays}). Recorded beside the decision (tierHistory.evidence) so a future session
// that re-derives the grid finds the question already settled, with the numbers.
export function clusterGridMargins(res) {
  if (!res || !Array.isArray(res.grid) || !(res.spanDays > 0)) return null;
  const points = res.grid.map((g) => {
    const spec = { windowDays: g.windowDays, hits: g.hits, offIndex: g.off, spanDays: res.spanDays, n: g.n };
    return { w: g.windowDays, r: g.minRatio, hits: g.hits, n: g.n, replay: +(g.hits / g.n).toFixed(2), chance: chanceRate(spec), margin: clusterMargin(spec) };
  });
  const best = points.filter((p) => p.margin !== null).sort((a, b) => b.margin - a.margin)[0] ?? null;
  return { spanDays: res.spanDays, points, best: best ? { w: best.w, r: best.r, margin: best.margin } : null };
}
// margin of a cluster spec = its own replay record minus its chance rate. Rounded
// ONCE, from the raw quantities: subtracting two already-rounded figures drifted
// 0.01 at three of ORDER's nine grid points (0.27 for 0.26) against the recorded table.
export function clusterMargin(spec) {
  if (chanceRate(spec) === null || !(spec.n > 0) || !Number.isFinite(spec.hits)) return null;
  const raw = Math.min(1, (spec.hits + spec.offIndex) * spec.windowDays / spec.spanDays);
  return +(spec.hits / spec.n - raw).toFixed(2);
}
// FALSIFIER STRENGTH on every verified row (v0.30.2). chanceRate: how often a window
// of the watch's own width would pass by accident; replayRate: the falsifier's own
// record; margin = replay - chance.
// ADMISSION BAR (2026-09-15). A verified row's falsifier must clear a minimum margin.
// The bar is DECLARED, not derived; its basis is the observed distribution: the three
// cadence rows sit at 0.64-0.76, and the one contract-cliff row (ORDER) at 0.17 with
// 0.26 the best point on its own 9-cell grid — two populations with nothing between
// them. There is no "verified but WEAK" state any more: below the bar a row is
// SOURCED (tier correction, reason recorded), above it VERIFIED. A stored WEAK
// verdict is refused at boot. A verified row whose falsifier has no derived strength
// is refused too: an unmeasured falsifier is not a strong one.
export const MIN_FALSIFIER_MARGIN = 0.40;
export const MIN_FALSIFIER_MARGIN_BASIS = 'declared 2026-09-15 against observed margins (replay − chance): EIGEN 0.76, ENA 0.67, MOVE 0.64 admitted; ORDER 0.17 (best grid point w3/r2 0.26) retracted to sourced';
export const FALSIFIER_VERDICTS = ['STRONG', 'NONE'];
export function falsifierProblems(t) {
  if (!t?.verified || t.retired || !(t.cadence || t.enforcement === 'contract' || t.reviewBy)) return [];
  const f = t.falsifier;
  if (!f || typeof f !== 'object') return ['verified row has no derived falsifier strength (derive-falsifier-strength.js → promote-unlock.js strength=auto)'];
  const p = [];
  if (f.verdict === 'WEAK') p.push(`falsifier.verdict WEAK is no longer a verified-tier state — below the ${MIN_FALSIFIER_MARGIN} margin bar a row is SOURCED (tier correction), not verified`);
  else if (!FALSIFIER_VERDICTS.includes(f.verdict)) p.push(`falsifier.verdict '${f.verdict}' unknown`);
  if (f.verdict !== 'NONE') {
    if (!(f.chanceRate >= 0 && f.chanceRate <= 1)) p.push('falsifier.chanceRate must be in [0,1]');
    if (!(f.replayRate >= 0 && f.replayRate <= 1)) p.push('falsifier.replayRate must be in [0,1] — a verified row has a replay record');
    const m = +(f.replayRate - f.chanceRate).toFixed(2);
    if (!(Number.isFinite(f.margin) && Math.abs(f.margin - m) < 0.011)) p.push(`falsifier.margin ${f.margin} disagrees with replay−chance ${m}`);
    if (!(f.margin >= MIN_FALSIFIER_MARGIN)) p.push(`falsifier margin ${f.margin} is below the verified-tier admission bar ${MIN_FALSIFIER_MARGIN} — this row belongs in the sourced tier (promote-unlock.js SYM provenance=sourced source=<name> reason="...")`);
  }
  if (!f.basis) p.push('falsifier.basis required');
  return p;
}
// COMPOUND: chance rate is per window — how much each new stamp adds. The row's
// evidentiary weight is the replay SERIES: P(>= hits of n windows pass by chance
// alone) = binomial tail at chanceRate. EIGEN 11/11 at 0.24 -> 1.5e-7; ORDER 6/8 at
// 0.58 -> 0.42. Shown next to the per-window figure so a strong row is not
// discounted because its per-window number looks soft.
export function compoundChance(chanceRate, hits, n) {
  if (!(n > 0) || !(chanceRate >= 0 && chanceRate <= 1)) return null;
  const C = (nn, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (nn - k + i) / i; return r; };
  let p = 0;
  for (let k = hits; k <= n; k++) p += C(n, k) * chanceRate ** k * (1 - chanceRate) ** (n - k);
  return Math.min(1, p);
}
export function stampStrength(row, rep) {
  if (!rep) throw new Error(`stampStrength: ${row.sym} has no entry in data/falsifier-strength.json — run derive-falsifier-strength.js`);
  // The verdict is DERIVED here from the margin, never copied: the report says what
  // it measured; the bar decides the tier.
  const f = { verdict: rep.verdict === 'NONE' ? 'NONE' : 'STRONG', basis: rep.basis, at: rep.at, kind: rep.kind };
  if (rep.verdict !== 'NONE') Object.assign(f, { chanceRate: rep.chanceRate, replayRate: rep.replayRate ?? null, replayN: rep.replayN ?? null, windowDays: rep.windowDays, qualifyingDays: rep.qualifyingDays, spanDays: rep.spanDays, margin: rep.replayRate != null ? +(rep.replayRate - rep.chanceRate).toFixed(2) : null,
    replayHits: rep.replayHits ?? (rep.replayRate != null && rep.replayN ? Math.round(rep.replayRate * rep.replayN) : null) });
  if (f.replayHits != null && f.replayN) f.compound = +compoundChance(f.chanceRate, f.replayHits, f.replayN).toPrecision(2);
  const out = {};
  for (const k of VERIFIED_ROW_FIELDS) if (row[k] !== undefined) out[k] = row[k];
  out.falsifier = f;
  const p = falsifierProblems(out);
  if (p.length) throw new Error(`stampStrength: ${p.join('; ')}`);
  return out;
}
export function falsifierLine(t) {
  const f = t?.falsifier;
  if (!f) return `${t?.sym} underived`;
  if (f.verdict === 'NONE') return `${t.sym} none`;
  const series = f.replayHits != null ? `${f.replayHits}/${f.replayN}${f.replayHits === f.replayN ? ' consecutive' : ''}` : '?';
  return `${t.sym} ${Math.round(f.chanceRate * 100)}%/window · ${series}${f.compound != null ? ` · p≈${f.compound.toExponential(1).replace('e-', 'e-').replace('e+0', '')}` : ''}${f.verdict === 'WEAK' ? ' WEAK' : ''}`;
}
export const CONTRACT_ENFORCEMENT_RETRACTED = `enforcement:'contract' is claimable by nobody (retracted 2026-09-15): the one row that earned it, ORDER, carried a falsifier margin of 0.17 against the ${MIN_FALSIFIER_MARGIN} admission bar, and no point on its grid cleared it. Ingest the row as sourced; the claim-cluster method stays available as evidence, not as a tier.`;
export function forwardFalsifierProblems(t) {
  if (t.enforcement === 'contract') return [CONTRACT_ENFORCEMENT_RETRACTED];
  // Observable emissions demand the stronger falsifier: a row DISCOVERED by cadence
  // cannot substitute a reviewBy for the spec — that would be a downgrade in disguise.
  if (t.events?.some((e) => e.source === 'onchain-cadence')) {
    return cadenceSpecProblems(t.cadence).map((p) => `onchain-cadence provenance requires a cadence spec (${p})`);
  }
  if (t.cadence) return cadenceSpecProblems(t.cadence).map((p) => `cadence spec invalid: ${p}`);
  if (t.reviewBy) {
    return Number.isFinite(Date.parse(t.reviewBy)) ? []
      : [`reviewBy '${t.reviewBy}' is not a parseable date`];
  }
  return [`no forward falsifier: schedule is not contract-enforced and carries neither a cadence spec nor a reviewBy dead-man's switch — "verified" would rest on trust aging silently`];
}

// Pure. oldRow supplies IDENTITY only (sym, name); everything else must be provided
// explicitly by the promoter, because explicit is what "verified" means.
// alsoObserve: addresses that emit around the same date but IRREGULARLY — deliberately
// NOT part of the cadence falsifier (an irregular emitter inside a family band would
// false-demote every quiet month), but summed for the RETROSPECTIVE stage. Forward
// stages can only claim what is predictable, so they quote the metronome as a floor;
// T+3 reports what was actually observed. Predict the floor, report the total.
export function promoteRow(oldRow, { events, monthlyDay = null, date = null, note = '', operatorNote = null, cadence = null, enforcement = null, reviewBy = null, stage = null, alsoObserve = null, contract = null, clusterSpec = null, cliffDates = null, upgradeable = null }) {
  if (stage && !['FULL', 'STANDARD', 'LOGGED'].includes(stage)) throw new Error(`promoteRow: unknown stage '${stage}'`);
  for (const a of alsoObserve || []) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`promoteRow: alsoObserve entry '${a}' is not a full address`);
  }
  if (!oldRow?.sym) throw new Error('promoteRow: old row has no sym');
  if (oldRow.retired) throw new Error(`promoteRow: ${oldRow.sym} is RETIRED (${oldRow.retired}) — a retired token is not promoted, it is re-opened deliberately`);
  if (!Array.isArray(events) || !events.length) throw new Error('promoteRow: a verified row requires events[] with provenance');
  for (const e of events) {
    if (!e.date || !e.source) throw new Error('promoteRow: every event needs date and source');
    if (!Number.isFinite(Date.parse(e.date))) throw new Error(`promoteRow: unparseable event date '${e.date}'`);
  }
  if (events.some((e) => e.source === 'onchain-cadence')) {
    const p = cadenceSpecProblems(cadence);
    if (p.length) throw new Error(`promoteRow: onchain-cadence provenance requires a machine-checkable cadence spec (auto-demote is not optional for behavioural verification): ${p.join('; ')}`);
  }
  const row = { sym: oldRow.sym, name: oldRow.name, verified: true, events, note };
  if (operatorNote) row.operatorNote = operatorNote;
  // A sourced row promoted to verified is SUPERSEDED, not deleted: the source's
  // events travel as history, and the chain/token resolution survives.
  if (oldRow.provenance === 'sourced') {
    row.sourceHistory = { source: oldRow.source, sourceFetchedAt: oldRow.sourceFetchedAt, sourceEvents: oldRow.sourceEvents, supersededAt: new Date().toISOString().slice(0, 10) };
  } else if (oldRow.sourceHistory) {
    row.sourceHistory = oldRow.sourceHistory; // a RE-promotion must not lose where the row came from (dropped once, v0.30.1)
  }
  if (oldRow.chain) row.chain = oldRow.chain;
  if (oldRow.token) row.token = oldRow.token;
  if (monthlyDay) row.monthlyDay = monthlyDay;
  if (date) row.date = date;
  if (cadence) row.cadence = cadence;
  if (enforcement) row.enforcement = enforcement;
  if (reviewBy) row.reviewBy = reviewBy;
  if (stage) row.stage = stage;
  if (alsoObserve?.length) row.alsoObserve = alsoObserve;
  if (contract) row.contract = contract;
  if (clusterSpec) row.clusterSpec = clusterSpec;
  if (cliffDates) row.cliffDates = cliffDates;
  if (typeof upgradeable === 'boolean') row.upgradeable = upgradeable;
  const ff = forwardFalsifierProblems(row);
  if (ff.length) throw new Error(`promoteRow: ${ff.join('; ')}`);
  return row; // constructed — nothing from the estimated era survives except identity
}

// NOTE SPLIT, pure: a row whose `note` predates the split (no operatorNote yet) has
// its note MOVED to operatorNote — nothing is deleted, it changes audience. A row that
// already has an operatorNote is left alone (its note is post-split and public by
// decision). Returns the new row and whether it changed.
export function splitNote(row) {
  if (!row || typeof row !== 'object') return { row, moved: false };
  if (!row.note || row.operatorNote) return { row, moved: false };
  const out = { ...row, operatorNote: row.note };
  delete out.note;
  return { row: out, moved: true };
}

// Boot-assertion helper: a row with events[] carrying any estimated-only field is a
// patched-not-constructed promotion.
export function verifiedRowProblems(tokens) {
  const problems = [];
  for (const t of tokens || []) {
    // Sourced rows have their own gate: source + fetch time, or boot refuses.
    if (t?.provenance === 'sourced') {
      for (const p of sourcedRowProblems(t)) problems.push(`unlock token '${t.sym}' (sourced): ${p}`);
      continue;
    }
    if (!Array.isArray(t?.events) || !t.events.length) continue;
    for (const f of ESTIMATED_ONLY_FIELDS) {
      if (f in t) problems.push(`unlock token '${t.sym}' is VERIFIED but carries estimated-era field '${f}' — promotion patched instead of constructing`);
    }
    for (const p of falsifierProblems(t)) problems.push(`unlock token '${t.sym}': ${p}`);
    // Behavioural verification without its automatic falsifier is a prose trigger
    // waiting to be forgotten. Boot refuses it, same as promotion refuses it — and
    // the rule keys on ENFORCEMENT, not the provenance label (the EIGEN asymmetry:
    // the most-verified-sounding row had the least ongoing falsification).
    for (const p of forwardFalsifierProblems(t)) {
      problems.push(`unlock token '${t.sym}': ${p}`);
    }
  }
  return problems;
}
