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
export const VERIFIED_ROW_FIELDS = ['sym', 'name', 'monthlyDay', 'date', 'verified', 'note', 'events', 'retired', 'retiredAt', 'cadence', 'enforcement', 'reviewBy', 'stage', 'alsoObserve', 'sourceHistory', 'chain', 'token', 'contract', 'clusterSpec', 'cliffDates', 'upgradeable'];
// Estimated-era fields that must NEVER appear on a verified row (boot-asserted).
export const ESTIMATED_ONLY_FIELDS = ['pctOfMcap'];

// SOURCED tier (2026-09-05): a NAMED third party publishes the schedule and the
// message says so. Not verified — it never carries events[] (that field means
// "independently confirmed") — and not estimated (it pushes, labelled). Its
// falsifier is the source itself: re-read weekly, stale at 21 days. A sourced row
// without source + sourceFetchedAt is refused at promotion and at boot, the same
// shape discipline as a verified row without a forward falsifier.
export const SOURCED_ROW_FIELDS = ['sym', 'name', 'provenance', 'source', 'sourceFetchedAt', 'sourceEvents', 'chain', 'token', 'stage', 'note', 'circSupply', 'totalLocked', 'maxSupply'];
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
  pctOfMaxSupply: 0.061,
  percentile: 25,
  n: 180,
  basis: '25th percentile of tranche/maxSupply across 180 sourced batch events in 30 DefiLlama rows, index 2026-09-05T08:27; p10 0.005 p50 0.539 p75 1.511',
};
export const NON_PRESSURE_CATS = ['farming', 'staking'];
export function derivePressureFloor(tokens, percentile = 25) {
  const pcts = [];
  for (const t of tokens || []) {
    const evs = t.sourceEvents || t.sourceHistory?.sourceEvents || [];
    if (!t.maxSupply) continue;
    for (const e of evs) if (e.n > 0) pcts.push(100 * e.n / t.maxSupply);
  }
  pcts.sort((a, b) => a - b);
  if (!pcts.length) return null;
  return { pctOfMaxSupply: +pcts[Math.floor(pcts.length * percentile / 100)].toFixed(3), percentile, n: pcts.length };
}
// Pure: the stage the pressure rule assigns to a sourced row. LOGGED when the row's
// median tranche is below the floor, or when every tranche is farming/staking-only
// (emissions to stakers are not sell-side supply arriving at once). Otherwise the
// row's own stage. A row with no maxSupply cannot be sized -> its own stage (we did
// not look is not "small").
export function pressureStage(t, floor = SOURCED_PRESSURE_FLOOR) {
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

export function sourceIsStale(t, now = Date.now()) {
  const at = Date.parse(t.sourceFetchedAt);
  return !Number.isFinite(at) || (now - at) > SOURCE_STALE_DAYS * 86400e3;
}

// Pure constructor for a sourced row — whitelist copy, same discipline as promoteRow.
export function sourceRow(oldRow, { source, sourceFetchedAt, sourceEvents, chain, token = null, stage = 'STANDARD', note = '', circSupply = null, totalLocked = null, maxSupply = null }) {
  if (!oldRow?.sym) throw new Error('sourceRow: no sym');
  if (oldRow.retired) throw new Error(`sourceRow: ${oldRow.sym} is RETIRED`);
  if (Array.isArray(oldRow.events) && oldRow.events.length) throw new Error(`sourceRow: ${oldRow.sym} is VERIFIED — a verified row is not downgraded to sourced by this path`);
  const row = { sym: oldRow.sym, name: oldRow.name, provenance: 'sourced', source, sourceFetchedAt, sourceEvents, chain, stage, note };
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
// next cliff's post-cliff claim cluster), and backtested cliff dates. Until this
// session the label was claimable by nobody; ORDER's LockedTokenVault is the first.
export function clusterSpecProblems(spec) {
  if (!spec || typeof spec !== 'object') return ['missing clusterSpec'];
  const p = [];
  for (const k of ['windowDays', 'minRatio', 'minRecipients', 'baselineDaily']) if (!(spec[k] > 0)) p.push(`clusterSpec.${k} required (>0)`);
  if (!spec.basis) p.push('clusterSpec.basis required — parameters are derived, not asserted');
  if (!(spec.n >= 3)) p.push('clusterSpec.n >= 3 required (backtested cliffs)');
  return p;
}
export function forwardFalsifierProblems(t) {
  if (t.enforcement === 'contract') {
    const p = [];
    if (!/^0x[0-9a-fA-F]{40}$/.test(t.contract || '')) p.push("enforcement:'contract' requires a full contract address (resolved, never typed)");
    for (const q of clusterSpecProblems(t.clusterSpec)) p.push(`enforcement:'contract' requires a cluster falsifier: ${q}`);
    if (!Array.isArray(t.cliffDates) || t.cliffDates.filter((c) => c.cluster).length < 2) p.push("enforcement:'contract' requires >=2 backtested cliff dates with clusters");
    if (typeof t.upgradeable !== 'boolean') p.push("enforcement:'contract' requires an explicit upgradeable flag (proxies are upgradeable — schedule a re-read)");
    return p;
  }
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
export function promoteRow(oldRow, { events, monthlyDay = null, date = null, note = '', cadence = null, enforcement = null, reviewBy = null, stage = null, alsoObserve = null, contract = null, clusterSpec = null, cliffDates = null, upgradeable = null }) {
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
  // A sourced row promoted to verified is SUPERSEDED, not deleted: the source's
  // events travel as history, and the chain/token resolution survives.
  if (oldRow.provenance === 'sourced') {
    row.sourceHistory = { source: oldRow.source, sourceFetchedAt: oldRow.sourceFetchedAt, sourceEvents: oldRow.sourceEvents, supersededAt: new Date().toISOString().slice(0, 10) };
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
