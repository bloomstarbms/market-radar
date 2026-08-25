// Tier -> delivery-route registry, asserted at BOOT.
//
// Class-level guard for the second instance of "a tier exists in config but cannot
// reach a reader": DIGEST-tier macro events were computed, classified, and dropped —
// tier assignment without a route. (First instance: net-of-cost multipliers left the
// C tier with no population.) A tier with no reader is a CONFIG bug and must fail
// startup, not be discovered by a human noticing an absence in the channel days later.
//
// The registry is DECLARED, not inferred: adding a tier anywhere (calendar tiers,
// budget tiers) requires adding its consuming route here, which is exactly the moment
// to wire the route for real. Same discipline as the admit() boot self-test.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { FACT_TYPES } from './budget.js';
import { verifiedRowProblems } from './unlock-promote.js';

const CAL_PATH = join(process.cwd(), 'data', 'macro-calendar.json');

const ROUTES = {
  // macro-calendar event tiers -> who reads them
  macro: {
    FULL: 'pushed: t24h/t60m/t5m/t30m stages (macro.js)',
    STANDARD: 'pushed: t24h/t5m stages (macro.js)',
    DIGEST: 'daily digest via st.digestPool (macro.js -> telemetry.js)',
  },
};

// FACT types must each have a declared route, same discipline as tiers: a fact type
// that no path delivers is the Fix-3 bug in a new costume, and facts are exactly where
// it would hide because they are unscored (no tier to notice its absence).
const FACT_ROUTES = {
  LISTING: 'push at detection + T+30m depth edit',
  ANNOUNCE: 'push at detection',
  PERP: 'push at detection',
  UPBIT: 'push at detection',
  SUSPENSION: 'push at detection (routine vs open-ended distinguished)',
  DELIST_SCHEDULED: 'push at announcement + T-7d/T-1d reminders',
  UNLOCK: 'push at verified-date stages',
  TGE: 'push at detection',
  CPI: 'push via macro stages',
  MACRO: 'push via macro stages',
  DEPEG: 'push at detection',
  RUG: 'push at detection',
  FUNDING: 'push at detection (fact: rate + OI, no direction)',
  CASCADE: 'push at detection (producer lands in step 7)',
};

// Returns { ok, problems[] }. calendarEvents / tiers injectable for tests.
//
// Two failure modes, deliberately distinguished:
//   ACCIDENT — a tier appears with no reader and no declaration => FAIL BOOT.
//   INTENT   — a tier declared { push:false, digest:false, record:true } is
//              recorded-only ON PURPOSE and passes. Without this distinction the
//              only way to express "measured but not messaged" would be to route
//              around the gate, which defeats it.
export function checkTierRoutes({ calendarEvents, tiers, factTypes, tokens } = {}) {
  const problems = [];
  let events = calendarEvents;
  if (!events) {
    if (!existsSync(CAL_PATH)) events = [];
    else { try { events = JSON.parse(readFileSync(CAL_PATH, 'utf8')).events || []; } catch { events = []; } }
  }
  for (const ev of events) {
    if (!(ev.tier in ROUTES.macro)) problems.push(`calendar event '${ev.id}' has tier '${ev.tier}' with NO delivery route`);
  }
  // Every FACT type needs a reader. Injectable so the fixture can prove both directions.
  for (const t of (factTypes ?? [...FACT_TYPES])) {
    if (!FACT_ROUTES[t]) problems.push(`FACT type '${t}' has NO declared delivery route`);
  }
  // RETIRED unlock tokens are a POSITIVE state: a token marked retired (e.g. INJ,
  // fully unlocked Jan 2024) must never carry events[] or monthlyDay. Without this a
  // future session re-adding it from a stale aggregator list silently revives it;
  // with it, the revival fails boot and forces the question.
  let unlockTokens = tokens ?? null;
  if (!unlockTokens) {
    try { unlockTokens = JSON.parse(readFileSync(join(process.cwd(), 'unlocks.json'), 'utf8')).tokens || []; }
    catch { unlockTokens = []; }
  }
  for (const t of unlockTokens) {
    if (t?.retired && (t.monthlyDay || (Array.isArray(t.events) && t.events.length)))
      problems.push(`unlock token '${t.sym}' is RETIRED (${t.retired}) but carries ${t.monthlyDay ? 'monthlyDay' : 'events[]'} — a stale list revived it`);
  }
  // PROMOTION CONSTRUCTS, NEVER PATCHES: a verified row carrying an estimated-era
  // field (pctOfMcap et al.) means someone edited the date in place — that is how the
  // first live push shipped a stale '~4.97% of market cap'. Enforced by shape.
  problems.push(...verifiedRowProblems(unlockTokens));
  for (const [tier, decl] of Object.entries(tiers ?? config.tiers ?? {})) {
    if (decl?.push || decl?.digest) continue;        // has a reader
    if (decl?.record === true) continue;             // DECLARED recorded-only — intentional
    problems.push(`budget tier '${tier}' has NO delivery route and is not declared recorded-only`);
  }
  return { ok: problems.length === 0, problems };
}

// CLASSIFIERS-WIRED ASSERTION (v0.23.4).
//
// Third instance of the same class: a classifier that EXISTS but is not routed to a
// path that emits the thing it classifies. DIGEST-tier had no reader; the announcement
// path carried a parallel equity regex that drifted; and the ticker path emitted
// LISTING facts without ever calling an equity/leverage classifier — which is how
// TSLAX, CRCLX and four leveraged tokens reached the channel.
//
// The generalisable check: WHEN YOU ADD A CLASSIFIER, ENUMERATE EVERY PATH THAT EMITS
// THE THING IT CLASSIFIES, AND ASSERT EACH ONE CALLS IT. The tier assertion already
// does this for delivery routes; this does it for classifiers. Declared, not inferred,
// so adding an emitting path forces a decision here — which is the moment to wire it.
const EMITTERS = {
  'sources/cex/listings.js': { emits: 'LISTING (symbol-set diff)', mustCall: ['classifySymbol'] },
  'sources/cex/announcements.js': { emits: 'LISTING/PERP/SUSPENSION/DELIST (titles)', mustCall: ['classifyAnnouncementText'] },
  'core/dispatcher.js': { emits: 'all pushes', mustCall: ['allowPriceDetector'] },
};

export function checkClassifiersWired({ readFile } = {}) {
  const problems = [];
  const rd = readFile ?? ((rel) => {
    try { return readFileSync(join(process.cwd(), 'src', rel), 'utf8'); } catch { return null; }
  });
  for (const [file, spec] of Object.entries(EMITTERS)) {
    const src = rd(file);
    if (src === null) { problems.push(`emitter '${file}' not readable — cannot verify it classifies what it emits`); continue; }
    for (const fn of spec.mustCall) {
      if (!src.includes(fn)) problems.push(`'${file}' emits ${spec.emits} but never calls ${fn}()`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export function assertTierRoutes(opts) {
  const r = checkTierRoutes(opts);
  if (!r.ok) {
    console.error('[OPERATOR][BOOT] unroutable tier(s): ' + r.problems.join(' ; ') + ' — a tier with no reader is a config bug; refusing to start.');
  }
  return r.ok;
}
