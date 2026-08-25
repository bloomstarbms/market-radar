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
export const VERIFIED_ROW_FIELDS = ['sym', 'name', 'monthlyDay', 'date', 'verified', 'note', 'events', 'retired', 'retiredAt'];
// Estimated-era fields that must NEVER appear on a verified row (boot-asserted).
export const ESTIMATED_ONLY_FIELDS = ['pctOfMcap'];

// Pure. oldRow supplies IDENTITY only (sym, name); everything else must be provided
// explicitly by the promoter, because explicit is what "verified" means.
export function promoteRow(oldRow, { events, monthlyDay = null, date = null, note = '' }) {
  if (!oldRow?.sym) throw new Error('promoteRow: old row has no sym');
  if (oldRow.retired) throw new Error(`promoteRow: ${oldRow.sym} is RETIRED (${oldRow.retired}) — a retired token is not promoted, it is re-opened deliberately`);
  if (!Array.isArray(events) || !events.length) throw new Error('promoteRow: a verified row requires events[] with provenance');
  for (const e of events) {
    if (!e.date || !e.source) throw new Error('promoteRow: every event needs date and source');
    if (!Number.isFinite(Date.parse(e.date))) throw new Error(`promoteRow: unparseable event date '${e.date}'`);
  }
  const row = { sym: oldRow.sym, name: oldRow.name, verified: true, events, note };
  if (monthlyDay) row.monthlyDay = monthlyDay;
  if (date) row.date = date;
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
  }
  return problems;
}
