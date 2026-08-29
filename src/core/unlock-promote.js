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
export const VERIFIED_ROW_FIELDS = ['sym', 'name', 'monthlyDay', 'date', 'verified', 'note', 'events', 'retired', 'retiredAt', 'cadence', 'enforcement', 'reviewBy'];
// Estimated-era fields that must NEVER appear on a verified row (boot-asserted).
export const ESTIMATED_ONLY_FIELDS = ['pctOfMcap'];

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
  if (!/^0x[0-9a-fA-F]{40}$/.test(spec.wallet || '')) p.push('cadence.wallet must be a full address');
  if (!spec.monthEnd && !(Number.isInteger(spec.expectDay) && spec.expectDay >= 1 && spec.expectDay <= 28))
    p.push('cadence needs expectDay 1-28 or monthEnd:true');
  if (!(spec.meanAmount > 0)) p.push('cadence.meanAmount required (qualifying threshold = 50% of it)');
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
export function forwardFalsifierProblems(t) {
  if (t.enforcement === 'contract') return [];
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
export function promoteRow(oldRow, { events, monthlyDay = null, date = null, note = '', cadence = null, enforcement = null, reviewBy = null }) {
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
  if (monthlyDay) row.monthlyDay = monthlyDay;
  if (date) row.date = date;
  if (cadence) row.cadence = cadence;
  if (enforcement) row.enforcement = enforcement;
  if (reviewBy) row.reviewBy = reviewBy;
  const ff = forwardFalsifierProblems(row);
  if (ff.length) throw new Error(`promoteRow: ${ff.join('; ')}`);
  return row; // constructed — nothing from the estimated era survives except identity
}

// Boot-assertion helper: a row with events[] carrying any estimated-only field is a
// patched-not-constructed promotion.
export function verifiedRowProblems(tokens) {
  const problems = [];
  for (const t of tokens || []) {
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
