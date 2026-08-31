<!-- PREMISE
Written against: v0.18.3 (header) — body is an APPEND-ONLY LOG through v0.26.0.
Reviewed: 2026-08-29
Assumes:
- Entries are dated and never rewritten; a later entry supersedes an earlier one.
  Read bottom-up for current state, top-down for how it was reached.
- The population caveat below still holds: executable depth medians sit BELOW the
  $25k gate, so every multiplier is measured on a population thinner than the gate.
-->

# READ THIS FIRST — POPULATION CAVEAT (top-level, v0.18.3)

Both cohort medians of executable depth sit BELOW the $25k gate ($8k single,
$5k multi, where known). The ENTIRE canonical corpus — every multiplier now
governing live behaviour (PUMP 0.730, DUMP 0.757, all five), the PUMP-HIGH
distribution, the stops-hurt finding, the expectancy ordering, the
conjunction test — was measured on a population the system NO LONGER ALERTS
ON. These findings may transfer to gate-passing symbols or may not; nothing
in this corpus can say which.

EVERY MULTIPLIER IS PROVISIONAL-BY-POPULATION, not merely provisional-by-
sample-size. The FLOORED cohort (gated, accruing since v0.14) is the only
one that will ever answer it. SCHEDULED: re-derive every module statistic
on gate-passing FLOORED rows the moment gated n>=100 per module; until
then, treat all numbers below as describing the population we USED to
alert on.

---

# Reconciliation notes for REMAINING-WORK.md (updated 2026-08-10)

Live version is v0.17.0 (public channel @radaralert22 receives all signal
alerts; heartbeats DM-only). Update Part 0's version line when pasting.

## Storage: JSON-in-OneDrive is DEFENSIBLE, not a mistake to fix

Part 0's "node:sqlite in %LOCALAPPDATA%" describes the spec. The
implementation is zero-dep JSON inside OneDrive, and that design is sound
on its own terms: the original corruption warning was about SQLITE on a
synced path (WAL files, hot page writes, sync scanning mid-transaction).
JSON with atomic temp-write-plus-rename has no such failure mode — rename
is atomic on the same volume, so OneDrive only ever sees closed, complete
files. Different design, not a worse one. A fresh agent must NOT "correct"
this to match Part 0.

Residual risks that atomic rename does NOT cover — narrower, named:
  1. OneDrive CONFLICT COPIES if the file appears modified in two places
     (e.g. cloud restore racing a local write). Watch for
     "outcomes-<machine>.json" siblings; their presence means reconcile.
  2. Transient locks during sync scans — already mitigated by the
     EBUSY-retry in store.js, but new writers must use the same pattern.

## Migration trigger (converts a standing question into a threshold)

JSON rewrites the whole corpus per append — O(n) per write. At 20k rows
that is nothing. Revisit node:sqlite ONLY when append latency or resident
memory becomes measurable in the logs, not before. Until a number trips,
the answer is "no migration".

Also: "config in JSON, hot-reloadable" in Part 0 — actual is .env +
config.js, restart to apply. Same rule: a decision, not a correction.

## Budget semantics corrected in v0.17.1 (supersedes Part 0's ≤12/day line)

"Top 12 of a day" is unimplementable online — push decisions are
irreversible and made one at a time. Corrected to tier-based exemption:
RISK + A-tier bypass; B-tier hard-capped, rolling 24h; C-tier digest-only.
No queue exists anywhere in dispatch (verified by grep); nothing defers.
Replay under new semantics: 3,544 -> 80 pushes / 25.4d (3.2/day), breaker
never trips, 206 C-tier singles reclassified digest-only. Floor-clearance
is a PROXY for quality, not proof — FUNDING clears it at 41% win. The
outcome loop exists to fix exactly that calibration.

## CANONICAL BENCHMARK (fixed 2026-08-10, v0.17.2) — use this, nothing else

Denominator: the frozen UNFILTERED cohort — outcomes rows recorded BEFORE
the first suppression reason appears (epoch 2026-08-09T00:26Z, derived
from data at every load, clobber-proof). 2,119 rows / 24.1 wall-clock days.

  BEFORE (pre-floor, everything pushed):  87.9 pushes/day
  AFTER  (v0.17.2 tier semantics):        see replay output in session log
  All future before/after comparisons replay THIS cohort only. It never grows.

Two corrections shipped with v0.17.2:
  1. Regime tags are now DERIVED at load (first-suppressed-row epoch), after
     a file-edit backfill was silently clobbered by the running bot's save().
     Editing outcomes.json while the bot runs is FORBIDDEN.
  2. modulePrecision dedupes one sample per (module, symbol, UTC day). The
     Aug-9 duplicate flood had pushed REVIVAL's multiplier to 1.15 (58% "win"
     from ~673 copies of a few tokens). Deduped: REVIVAL 0.774, PUMP 0.729.
  3. The daily digest EXISTS as of v0.17.2 (DIGEST_HOUR_UTC, default 18:00):
     C-tier "digest-only" now reaches the channel once a day. Before this it
     was functionally a silent drop, which contradicted the tier's name.

## FROZEN (v0.17.3, verified with deduped multipliers)
Benchmark: UNFILTERED 2,119 rows / 24.1d = 87.9/day BEFORE -> 2.86/day
AFTER (69 pushes: LISTING 62, RUG 6, CONFLUENCE 1). Computed AFTER the
symbol-day dedup; re-verified identical on a second run.
Deduped multipliers (all five survive the n>=100 gate — closest REVIVAL n=148):
  DUMP 0.869 (n=339, 43%) | FUNDING 0.835 (n=308, 41%) | VOLUME 0.811 (n=224, 40%)
  REVIVAL 0.774 (n=148, 37%) | PUMP 0.729 (n=301, 36%)
Lost-update guard is STRUCTURAL as of v0.17.3: every outcomes save checks file
mtime vs our last write; external modification -> .conflict sidecar + operator
log, never a clobber. The "never edit while running" rule no longer relies on
anyone remembering it.

## Expectancy deep-checks (v0.18.1, 2026-08-10) — all figures GROSS
NO fees/slippage anywhere in the pipeline; subtract ~0.2-0.4%/round trip.
Q1 top-of-distribution: WORSE, not better. FUNDING HIGH (n=109): -1.22% vs
-0.44% all — dead at the top of its own distribution, "wrong threshold"
diagnosis REJECTED. PUMP HIGH (n=23): -12.2% — inverted; fading pump-HIGH
was ~+12% gross on this sample. The most promising number in the corpus;
feed to step 8 as a candidate BEARISH input, do not trade on n=23.
Q2 crude stop (-2% at h1, else h24): HURTS PUMP/DUMP/REVIVAL (early
drawdown tends to recover by h24), helps only FUNDING (+0.50). The
"fixed-horizon is the worst rule" hypothesis is NOT supported at -2%/h1;
proper answer needs MFE/MAE, now being tracked (3-point path, v0.18.1).
Q3 score-decile: unanswerable yet — scores are null on UNFILTERED rows;
becomes answerable as the FLOORED cohort accrues alpha. Re-run in ~2 weeks.

## v0.18.2 — flip-sign, feasibility, cost model
FLIP-SIGN — RETRACTED AS EVIDENCE (v0.18.3): E_short == -E_long identically
(median antisymmetry); the mirror table was arithmetic restating the prior
result, not corroboration. The exact decimal symmetry was the tell. What
STANDS as evidence for mean reversion: (1) PUMP-HIGH distribution — median
-13.5, IQR [-34.0,-1.1], n=26, only a small minority of strong pumps
continue; (2) stops hurting PUMP/DUMP/REVIVAL (drawdowns recover by h24).
STEP 8 DIRECTIONS: price-family modules enter UNSIGNED by default; only
PUMP-HIGH carries a distribution-grounded bearish prior. REVIVAL is noise
around zero net of costs — unsigned, let conjunction decide.
SHORT-SIDE ASYMMETRY: a short's loss is unbounded; medians cannot see the
tail that kills it. See right-tail query in session log. Perp FUNDING
payments are NOT in the cost model (spot round-trip only) — any short-side
evaluation must add funding/borrow before being believed.
PUMP-HIGH robustness: median -13.5%, IQR [-34.0,-1.1], mean -16.4 (n=26).
Not a one-token artifact. (The -12.17 was the median-based composite.)
FEASIBILITY: PUMP-HIGH ∩ gate ∩ perp = 2 of 23 (binance ESP, ETH). The
inversion is real and 91% UNHARVESTABLE — thin books are what make 20%/5m
candles possible. Prime directive in a new costume. The harvestable slice
grows naturally: post-universe-gate, new PUMP-HIGH candidates increasingly
come from gate-passing symbols; re-measure the tradeable subset in 2 weeks.
COST MODEL: expectancy is now NET (2x taker + 2x half-spread, per-venue
table, stored alphas stay gross). Every future figure is net by default.

## Step-8 premise test + two corrections (v0.18.3)
TAIL FLOOR: n=30 cannot characterize a tail. The observed PUMP-HIGH max
(+39.2%) is the largest of thirty draws, not the distribution's max —
microcap pumps of +200% exist and are simply absent from this window.
"1-in-10 shorts sit through +16..+39%" is the FLOOR on fade risk, not the
estimate. Do not treat 39% as a bound.
STOPS ASYMMETRY: "stops hurt" is a LONG-side finding (truncating drawdowns
that recover). On the SHORT side a stop protects against the unbounded
continuation — the only thing that can seriously hurt a fade. The
conclusion does NOT transfer across sides.
CONJUNCTION PREMISE (verdict scoped after confound check): single -0.81%
vs multi-family -1.62% net (n=94), pre-registered +0.5% threshold not met.
BUT the multi-family subset is CONSISTENT WITH a liquidity confound (depth
known for only 13 of 94 multi rows / 250 of 1348 singles — n=13 cannot
confirm it; do not read as settled), and gate-restricted n collapses — so the honest verdict is
"UNDETERMINED FOR THE POPULATION WE NOW ALERT ON", not "conjunction doesn't
help". Ship CONJUNCTION_BONUS=1.0; earn per family-pair from live gated
outcomes. Do NOT let a future session read this as a tested negative on the
relevant population.
MAGNITUDE-NOT-DIRECTION (live hypothesis for cross-cutting A): win rate is
36% in BOTH subsets — agreement adds zero directional accuracy; it selects
for LARGER moves. If confirmed on gated data, co-occurrence belongs in
position sizing / stop width / volatility expectation ("will move hard,
direction unknown"), not in entry conviction.

## UPTIME — first MEASURED cost of desktop-only hosting (2026-08-12)

The $5/month VPS argument stopped being hypothetical on the Aug 12 CPI (FULL
tier, the module's highest-signal event class):
- T-60m warning MISSED: the desktop was off 11:30-12:15 UTC. Correctly
  suppressed by missed-not-late — but the miss itself is a hosting artifact.
- No pre-print basis snapshot (bot down at T-10m), so T+5m/T+30m reaction
  reports had an empty numerator even after recovery.
- T+5m and T+30m then fired at 13:11 UTC into a dead network and were LOST
  (broadcast swallowed rejected sends — fixed in v0.19.2, delivery is now
  part of "dispatched" and retries within per-stage freshness windows).
Macro stages are pinned to exact clock times we do not control; every other
module tolerates gaps because markets re-emit their signals — the calendar
does not. One measured instance = log it; two = move the bot. (Constraint
reminder: $0/month is the standing budget — a VPS is a USER decision, not
one a session may make.)
MEASURED (same day, analyze-uptime.js, 25 full days of outcomes-row coverage,
median row gap 1.0m so empty hours = real downtime): the awake profile is
FLAT ~44-60% at EVERY UTC hour — there is no reliably-awake window at all.
Against the remaining 2026 calendar: 10/28 FULL-tier stages fall in hours
awake <50% of days, but the honest statistic is expected misses = sum(1-cov)
= ~14 of 28 FULL stages (~half of every CPI/FOMC cycle), FOMC worst (18-19Z
= 44-48% awake). STANDARD: ~8 of 18. On this hardware the macro module is a
coin flip per stage. Caveat: profile mixes the pre-autostart development era
(Jul 15-31) with the current always-on config — re-run after 2 clean weeks
if a cheaper answer is wanted before deciding. Decision remains the USER's.
RESOLVED $0 (same day): event log showed the failure mode is SLEEP, not
shutdown — last true boot Aug 2; the CPI-killing 15.8h gap was Modern
Standby (slept 22:11Z, woke 13:11Z). Fixes applied: sleep-on-AC set to
never (powercfg), autostart confirmed (Startup\market-radar.vbs), and 28
Task Scheduler WAKE TIMERS registered (\MarketRadar\), one at T-15m before
every remaining FULL-tier stage, generated from macro-calendar.json by
gen-wake-timers.js — RERUN gen-wake-timers.js + SETUP-WAKE-TIMERS.bat
whenever the calendar changes. Wake timers verified Enabled on AC; DC
(battery) enable attempted best-effort. The 117 short scattered gaps were
S0 idle-sleep naps, which never-sleep-on-AC removes when plugged in.
Re-measure with analyze-uptime.js after 2 clean weeks; the $5 VPS question
is now conditional on that number, not on waiting for a second miss.

## META-FINDING — delivery layer untested (2026-08-13 fix session, v0.20.0)

Two days of reading live channel output produced FOUR delivery-layer bugs
none of which any test caught: double digest (in-memory sent-flag re-armed
by restart), heartbeat not delivering its telemetry payload, DIGEST-tier
macro events computed-classified-dropped (tier with no reader, second
instance of the class), MEXC flooding the listing carve-out (3 micro-cap
pushes in one minute; 62/69 historical pushes were LISTING). The suite
validated that alerts are CONSTRUCTED correctly, never that they are
ROUTED to a reader and arrive exactly once. Construction has weeks of
coverage; delivery had two days and yielded four bugs — assume more.
Fixed in v0.20.0: fixed-UTC-day digest with persisted delivery-gated
marker; heartbeat = separate telemetry message (uptime, funnel, collector
last-success ages via pulse.js, bug counter) that fires even on all-zeros;
boot assertion in routes.js (unroutable tier = startup failure, same
discipline as the admit self-test); listing carve-out venue-tiered —
tier-1 (upbit/bithumb/coinbase/binance) push immediately, everything else
defers to digest + T+30m liquidity re-check, promoted only past a $25k
executable floor with the delay disclosed and conviction derived from
measured depth. PPI promoted to STANDARD (operator revealed preference),
future PPI dates entered from the official BLS schedule (verified).
Wake-SELFTEST housekeeping: the machine never slept before the trigger
passed, so the wake MECHANISM remains UNTESTED, not failed. Reframe:
sleep-on-AC=never is the PRIMARY uptime fix; the wake timers are the
battery/lid backstop. All fixtures permanent in test-delivery.js (21).
MULT SNAPSHOT WAS A NO-OP FOR TWO DAYS (v0.20.2 -> fixed v0.21.5).
recordAlert() builds each row from an explicit FIELD WHITELIST, so `mult`
was stamped by the dispatcher and silently DISCARDED on write. Nothing
complained; rows kept accruing. Found only because the accumulator
instrument was built and immediately printed "floored +113 · mult +0".
The stamp therefore begins 15 Aug, NOT 14 Aug — rows between are
multiplier-unknown like everything before them (see cohort markers).
LESSON: any new per-row field must be added to recordAlert's row literal
as well as the call site, and "I'll confirm on the next recorded row" is
not verification — it was said and then not done.
MULT SNAPSHOT (intent, v0.20.2): every outcome row carries `mult` — the
module's precision multiplier AT DECISION TIME. Multipliers recompute
hourly, so identical candidates score differently hour to hour (observed
same-day spread: FUNDING-MEDIUM 35/48/58). Rows recorded before v0.20.2
have no `mult`; the FLOORED re-derivation must control for it and treat
pre-0.20.2 rows as multiplier-unknown.
COHORT MARKERS — now THREE, all load-bearing for the re-derivation:
  1. collectedUnder: UNFILTERED | FLOORED (regime, epoch-derived)
  2. Aug 10 digest-only hole (~dozens of C-tier rows vanished unrecorded
     under the broken admit tail; FLOORED's earliest day is thin)
  3. pre-/post-v0.20.2 `mult` stamp: rows before the stamp are
     FLOORED-BUT-MULTIPLIER-UNKNOWN and must be their OWN category in the
     re-derivation — do not fold them in with fully-stamped rows and do
     not back-fill a guessed multiplier onto them. Same reasoning that
     created collectedUnder: cheap to record at the boundary, impossible
     to reconstruct honestly later.
LABEL DRIFT (14 Aug, v0.20.3): Bybit renamed equity perps "TradFi
Perpetual Contract" — six Korean-equity perps (SAMSUNGEM, LGELECTRONICS,
NAVER, HANMI, KODEX200, ZHONGJI) walked past all three equity checks
(drifted label regex, US-only name list, symbol set too new to contain
them) and pushed individually at 10:34. Instance fix: 'tradfi' + 'etf'
added to the marker regex. CLASS fix: batch collapse — 3+ same-type
announcements from one venue in one poll cycle now dispatch as ONE
message; whatever the next unrecognized label is, it arrives as a batch
and floods as a single alert. Fixtures in test-delivery.js (41).
CATALYST DOOR WIDENED (v0.20.4): Fix 4 tiered LISTING by venue but PERP
and ANNOUNCE kept unconditional RISK bypass — the 14 Aug Bybit equity
perps came through the door Fix 4 had not closed. catalystRoute() now
covers LISTING+PERP+ANNOUNCE: tier-1 (upbit/bithumb/coinbase/binance)
pushes, everything else defers. Spot listings with a book keep the T+30m
liquidity re-check and promotion path; announcement-time catalysts have
no book to check, so they route to st.digestPool (their reader — a tier
without one is the Fix-3 bug). EXEMPT: delists (risk runs toward holders,
same logic as RUG/DEPEG) and already-promoted alerts.
ONE EQUITY CLASSIFIER (v0.20.4): the announcement path had its own
tokenized-equity regex that drifted out of sync with taxonomy.js — a
direct cause of the TradFi miss. isEquityText() now lives in
core/taxonomy.js and is the single owner of label markers, company-name
and symbol-set checks. When a venue invents the next product-line name,
add it THERE and nowhere else.

## BUG CLASS — "unconditional bypass wearing a justification"

Third instance in two days, so it gets named. Every bypass is granted for
a stated reason, and that reason implies a QUALIFYING CONDITION. If the
condition is never checked, the bypass is unconditional and becomes a
flood vector the moment a venue does something at volume.

  1. LISTING carve-out — "gate the trade, not the catalyst". Condition:
     the listing is a rare, repricing event. Never checked → MEXC listed
     constantly, 62/69 historical pushes were LISTING. Fixed v0.20.0 by
     venue tiering.
  2. PERP/ANNOUNCE RISK bypass — "announcements are catalysts". Condition:
     same rarity premise. Never checked → six Bybit equity perps in one
     minute, 14 Aug. Fixed v0.20.4 by extending the same tiering.
  3. DELIST exemption — "the risk runs toward HOLDERS". Condition: you
     hold it. NOT TESTABLE — position awareness is cross-cutting B,
     unbuilt. MEXC/Gate run batch delist sweeps of 10-20 tokens, so this
     was one RISK-tier push about tokens never held. Fixed v0.20.5 with
     an INTERIM PROXY: tier-2 delists push only on a symbol the universe
     has VERIFIED tradeable ($25k executable); tier-1 delists still push
     unconditionally (a Binance/Upbit delist repriced the asset for
     everyone). Known limitation: a held-but-never-swept token routes to
     digest. Replace the proxy with a real position check when B lands.

RULE GOING FORWARD: any new bypass must state its qualifying condition
AND the check that tests it. If the condition can't be tested yet, ship
the narrowest available proxy and record the limitation here — never the
bare exemption.

REMAINING AUDIT (bypasses still in admit()) — CORRECTED. Distinguish
three states, because "safe" and "never tested" look identical in an
audit and that is how the next bypass gets waved through:

  STRUCTURAL (condition holds by construction):
    UPBIT  — Korean listings are genuinely rare, venue-limited.
    DEPEG  — fires only on a peg break, bounded by stablecoin count.
    UNLOCK / CPI / MACRO / TGE — calendar-driven, so push volume is
      bounded by the calendar file itself, which we hand-maintain.

  CONTINGENT (rarity is a side effect of something else being quiet, and
  has a KNOWN EXPIRY):
    RUG — fires on blocked DEX candidates. Its low volume (6 of 69) is
      NOT a property of RUG: it is a side effect of DEX being near-silent
      because REVIVAL self-silenced on expectancy. RUG push volume scales
      DIRECTLY with DEX candidate volume, so re-enabling DEX revival in
      STEP 11 removes the thing keeping it quiet. ==> RE-EVALUATE RUG'S
      BYPASS AS PART OF STEP 11, before shipping it, not after the
      channel floods. Whoever ships step 11 must trip over this line.

  UNTESTED (premise has never been exercised at all):
    CASCADE — in RISK_TYPES with NO PRODUCER until step 7. It has never
      fired, so its rarity premise is unverified rather than verified.
      Not a bug; but do not read its silence as evidence of safety.
      State and check its qualifying condition when step 7 lands.

  *** THIS WHOLE TABLE IS SUPERSEDED BY v0.23.0 — READ THIS FIRST ***
  Every RISK_TYPES member is now ALSO a FACT_TYPES member, so the
  RISK-bypass branch inside admit() is UNREACHABLE: facts return above it.
  The table above describes a DEAD BRANCH and is kept only as the record of
  how the class was found. The bypass question has MOVED, not vanished:
    - Facts are unbudgeted because their volume is "naturally bounded by
      how often things happen". That is the new qualifying condition, and
      it is currently TRUE ONLY BECAUSE every fact type is driven by an
      external event (a venue posts a notice, a print lands).
    - The first fact type whose volume is set by a THRESHOLD WE CHOOSE
      rather than by an external cadence breaks that premise. CASCADE
      (step 7) is exactly that, and FUNDING already is — its threshold is
      ours (FUNDING_MIN_PCT), and it fired 455 times in the corpus.
      ==> AUDIT ITEM: FUNDING-as-fact is the live test of the unbudgeted
      premise. Watch fact volume; if it exceeds ~25/day the threshold is
      wrong, and the fix is the threshold or the classifier, NEVER a cap
      (a cap on facts reintroduces the queue by another name).
  Re-run the three triggers against FACT volume, not just RISK bypasses.

RE-RUN THIS AUDIT ON ANY OF THREE TRIGGERS:
  1. a type joins RISK_TYPES;
  2. a silenced module is re-enabled (RUG/step 11 is the live example);
  3. a GATE OR THRESHOLD that a bypass's qualifying condition REFERENCES
     is changed — the delist proxy is defined by the $25k executable
     gate, so moving that number silently moves the proxy's coverage,
     and rug-screen strictness feeds RUG volume the same way.

Trigger 3 is the quietest of the three: threshold tuning feels local and
its effects are not. Threshold definition sites carry a back-reference
comment (grep AUDIT-TRIGGER) so the person changing the number trips over
this without having to remember the notes exist.

## DIGEST NARROWED — C-tier is recorded-only (v0.21.0, 14 Aug)

C-tier price signals no longer appear in the digest. On 13 Aug, 11 of 12
slots were WHALE — a module below the n>=100 gate carrying NO precision
multiplier (unshrunk 60) while every measured module was scaled down —
and they were the same tokens (EIGEN, ZRO, SHIB) already auto-suppressed
from pushes. They had not stopped; they had relocated into a daily
message. Digest payload is now DIGEST-tier calendar events + deferred
tier-2 catalysts only, and the digest is CONDITIONAL: no payload, no
message. Most days that is silence.
This does NOT weaken silence-is-falsifiable: the HEARTBEAT still fires
daily with uptime, funnel, bug counter and collector ages. Content is
conditional; TELEMETRY IS NOT. Keep that split.
RECORDED-ONLY MEANS STILL RECORDED — C-tier candidates keep entering
outcomes with suppression reason and mult stamp; the FLOORED cohort and
the re-derivation depend on it. Only the digest's SOURCE QUERY changed
(fixture asserts the 13/08 window row count is unchanged: 58 C-tier rows
present, 0 drawn).
config.tiers now DECLARES delivery per tier, and the boot assertion
distinguishes a declared recorded-only tier (passes) from an accidental
no-reader (fails). Without that distinction the only way to express
"measured but not messaged" would be to route around the gate.

## BUG CLASS — "asserts the environment while appearing to assert logic"

Second class named this week, three instances in three days. A guard or
fixture that fails for a NON-CODE reason is a guard that eventually gets
commented out, and its failures are worse than useless: they look like
regressions.

  1. BOOT SELF-TEST was data-dependent (v0.20.1) — admit()'s below-floor
     case depended on LIVE multipliers, which recompute hourly. A fresh or
     RESTORED data dir scored FUNDING-MEDIUM at 58 and FAILED BOOT, i.e.
     the safety gate blocked startup exactly in the restore-from-backup
     scenario the backups exist for. Fixed: inject synthetic multipliers
     (withMultipliers); live-data condition became a non-fatal [diag] line.
  2. `state.json untouched` FIXTURE compared mtime (v0.21.1) — but the
     LIVE bot saves state every poll cycle, so it could not distinguish
     "the test wrote" from "the bot wrote" and failed whenever a save
     landed mid-run. Fixed: assert the actual property (no thread opened,
     no alert marker written) from in-memory state.
  3. 13/08 ROW-COUNT FIXTURE read the live outcomes table (v0.21.2) —
     historical windows are immutable, so concurrent appends were safe,
     but the table caps at 20k with evict-to-archive. When it fills those
     rows leave the file and the fixture fails for a reason unrelated to
     the code under test. Fixed: frozen snapshot at
     fixtures/outcomes-2026-08-13-window.json (69 rows, 8KB); live read
     retained as a NON-FATAL diagnostic that reports eviction.

RULE (full form — the second clause matters as much as the first):
  "Can this fail without anyone changing code?" If YES, it is testing the
  environment — which is FINE ONLY IF THE ENVIRONMENT IS THE SUBJECT.

  GATES must be deterministic: frozen inputs, injected clocks, in-memory
  state. They block boot/deploy, so a non-code failure makes them noise
  and then makes them deleted.

  CANARIES are SUPPOSED to fail when the world moves — that is their
  entire job. They run on their own schedule, alert the OPERATOR, and
  NEVER block a deploy or a boot.

DO NOT "FIX" A CANARY BY FREEZING ITS INPUT. Freezing the BLS page would
convert a working canary into a fixture that can never tell you anything.
A future session applying only the first clause would delete these for
rule violation, so they are inventoried:

  CANARIES (environment IS the subject — keep them live and failing-loud):
    - verifyCalendar() (macro.js): weekly compare of hand-entered CPI
      dates against bls.gov. MUST fail on reformat/date change; logs
      [macro][OPERATOR], never mutates the calendar, never blocks.
    - GoPlus rug screen (rugscreen.js): fail-CLOSED on endpoint change,
      status UNVERIFIABLE rather than a silent pass.
    - Exchange announcement parsers (announcements.js) + Upbit dual
      detector: feed-shape canaries. The 14 Aug 'TradFi' drift was one
      firing correctly-ish; batch collapse bounds the blast radius.
    - [boot][diag] live-multiplier line and the frozen-window sync
      diagnostic in test-delivery.js: report drift, never fail.

  GATES (deterministic, may block): admit() boot self-test (injected
  multipliers), tier-route assertion (declared config), test-delivery.js
  assertions (frozen snapshot + injected clocks/state), property-test.js
  monotonicity (replayed log prefix).
SWEPT 14 Aug: property-test.js / replay-dedup.js read data/bot.log
(append-only, historical prefix immutable — safe, and they are analysis
scripts rather than pass/fail gates). replay-budget.js reads the live
outcomes table but is a REPLAY TOOL, not a gate. test-delivery.js is now
hermetic apart from the declared diagnostics.

## THREE-STATE ANNOUNCEMENT CLASSIFIER (v0.21.3, 14 Aug)

isEquityText() was BINARY while every other classifier here is three-state
(unlocks verified/estimated/unverifiable · rug PASS/BLOCKED/UNVERIFIABLE/
NOT_APPLICABLE · bypass audit structural/contingent/untested). Binary meant
an unrecognised product line degraded to "not equity => crypto => push",
which is why 'TradFi' surfaced as six pushes instead of one operator line:
the classifier had no way to say I DON'T RECOGNISE THIS.
Now EQUITY | UNRECOGNISED | CRYPTO. UNRECOGNISED never pushes — it routes
to the digest pool and logs [announce][OPERATOR] naming the novel token(s),
the same shape as unlocks' `estimated` (recorded, never alerted).
Detection = novel-token against a rolling vocabulary (core/vocab.js,
data/announcement-vocab.json), seeded from 245 historical announcement
titles (31 tokens; 'tradfi' deliberately EXCLUDED from the seed so the
case that motivated this is caught).
GRADUATION IS AN EXPLICIT ACT, NOT A TIMEOUT (corrected same day).
The first cut quarantined new tokens for 7 days then trusted them
automatically — which expires on TIME, not on REVIEW. Away for a week, or
the operator line scrolls past during a busy stretch, and the token
graduates itself: equity perps push again and nobody decided that. Same
"safeguard whose lapse is indistinguishable from its success" pattern as
the data-dependent boot gate, the mtime fixture and the live-table
fixture. Now the vocabulary is a REVIEWED ARTIFACT, not an accumulating
cache: approved{} (a human put it there, trusted) vs pending{} (seen,
NEVER trusted regardless of age or count — a token seen 90 days and 40
times is still novel). Promote with `node approve-token.js <token>`;
bare `node approve-token.js` lists what awaits review and warns not to
approve equity labels. Unreviewed sightings ESCALATE rather than fade:
⚠️ new -> 🚨 repeat (>=1d or >=3 hits) -> 🚨🚨 UNREVIEWED-STALE (>=7d or
>=10 hits), in both the operator log and the digest entry.
ORDERING — found by running the seeded vocab against the LIVE Bybit feed
before deploy: novelty is checked LAST, only on titles that would
otherwise PUSH. Checked first, three promotional "Token Splash" posts
(no catalyst pattern, always correctly dropped) became UNRECOGNISED and
generated operator noise. A non-catalyst is a non-catalyst whatever words
it contains; novelty matters only when it changes a push decision. The
UNRECOGNISED record carries `would:` so the operator sees what it would
have been.


## PREDICTED CLASS — write-only accumulators (v0.21.5, 15 Aug)

Fifth instance of "a safeguard whose lapse is indistinguishable from its
success", and the first found by PREDICTION rather than by being bitten.
Things that accrue silently and are read WEEKS later share the profile:
ADV (~30d to maturity), MFE/MAE (~2w), the FLOORED cohort, the passive rug
calibration set, the mult stamp, and the daily backups. A stall is
invisible until the day the data is needed and three weeks are missing.
BACKUPS are the highest-stakes member: an unverified backup is a BELIEF,
not a safeguard, and the discovery moment is a recovery — exactly when it
must not fail.
Instrument (heartbeat, alongside collector ages and the digest line):
  Accumulators (24h): floored +N · mfe/mae +N · mult +N · rugcal +N · adv N cells
  Backup: newest Nh ago · N retained · restore-verified Nd ago
Escalates on: any accumulator at zero for 48H (48h not 24h, so genuinely
intermittent ones like rugcal do not cry wolf), newest backup OVER 26H, no
backup at all, or a restore drill never recorded.
IT PAID FOR ITSELF ON FIRST RUN, printing "mult +0" against "floored +113"
and exposing the whitelist bug above. The heartbeat is now the general
instrument for anything HEALTHY BY BEING QUIET — collectors, digest path,
accumulators, backups. Put the next such thing there too.
OPEN: st.lastRestoreDrill is not recorded, so the heartbeat says
"restore-verified never recorded". Run a restore drill on a COPY and set
it; do not fake the timestamp — the point is that the drill happened.

## WHITELIST GUARD + SELF-STAMPING DRILL (v0.21.6, 15 Aug)

WHITELIST: recordAlert's row literal is deliberate schema control and
STAYS — but it will drop the NEXT field exactly as it dropped `mult`, and
the next one will not happen to be instrumented; the discovery would be a
query returning nulls weeks later. Now droppedFields() diffs producer keys
against ROW_FIELDS ∪ NOT_PERSISTED and names anything discarded on an
[outcomes][OPERATOR] line, ONCE PER PROCESS (not per row). Adding a
persisted field = row literal + ROW_FIELDS; a transient one = NOT_PERSISTED
to silence it. Same move as everywhere this week: keep the safe default,
make the lapse noisy. The check is PURE (droppedFields) precisely so the
fixture need not call recordAlert against the live module — doing so pushes
rows into memory and can flush them to the real outcomes file, which is how
outcomes.json was torn once before.

RESTORE DRILL: `node restore-drill.js` restores the newest backups into a
temp dir, checks they parse, carry the fields the analyses need, span more
than a day, are less than 48h stale, and retain suppressed rows — then
STAMPS ITSELF to data/restore-drill.json on success. Self-stamping because
a hand-set timestamp gets set once and decays into a stale reassurance
saying "verified" about August; the number must be earned each time. The
stamp lives in its own file, NOT state.json, because a separate process
writing state would be clobbered by the running bot's next save (the
lost-update class). First run: 4,051 rows, 30.7d span, 1,927 suppressed —
all passed, heartbeat now reads restore-verified 0d ago and AGES from
there, so a forgotten drill goes loud on its own.
FUNCTIONAL CHECK ADDED (v0.21.7) — the automated drill was WEAKER than
the hand-run one from session 1, whose real proof was that
modulePrecision() computed FROM THE RESTORED ROWS matched live to within
0.002: downstream code actually ran off the backup. The first eight
automated checks were all structural (parse, fields, span, staleness,
suppressed retained) — they prove the file LOADS, not that the ANALYSES
WORK. A backup can pass all of them and still be subtly unusable: a field
present but empty, schema drift the parser tolerates, rows retained with
the wrong collectedUnder. Now the drill runs modulePrecision() AND
moduleExpectancy() off the restored rows and asserts both within 0.02 of
live (tolerance, not equality: the newest backup is up to a day behind).
Measured 16 Aug: drift 0.0000 on both, 5 modules each. The drifts are
recorded in the stamp so a future session can see the drill was
functional rather than structural.
INDEPENDENCE TEST (v0.21.7b) — the 0.0000 drift above was WEAKER THAN IT
LOOKED: the newest backup is minutes old, so comparing it to live is close
to comparing a file to itself, and it would return ~0 even if the restore
path silently fell through to the LIVE file — the one failure the drill
most needs to exclude. Ask what an assertion would FAIL on; if the answer
is "nothing plausible", it is not testing yet (same instinct that caught
the mtime fixture). So the drill now ALSO runs against the OLDEST retained
snapshot, where drift must be NON-ZERO (proves the archive was read) and
BOUNDED <0.4 (proves an old backup is still usable — what the tolerance
was written for). Measured 16 Aug against a 7d-old snapshot: precision
drift 0.0967, expectancy 0.0357, 3512 vs 4117 rows. Both stamped.
CALIBRATION FINDING from that measurement: multipliers move ~0.10 in a
WEEK, so the 0.02 tolerance is only valid for a SAME-DAY backup — do not
reuse it for older snapshots, and do not read a 0.09 drift on a week-old
file as a fault. It also bounds how stale the FLOORED re-derivation inputs
may be before the multipliers they produce are materially different.
DRILL AGE THRESHOLD (v0.21.7): 30d ⚠️, 60d 🚨, never-run 🚨 — without one,
"it ages from here" never actually went loud. Sits alongside 26h for
backups and 48h for accumulators.
RE-RUN THE DRILL periodically; it is the only check that proves the
backups are a safeguard rather than a belief.

## CONVERGENCE — multipliers are NOT settled, and expectancy is SATURATED
## (measured 16 Aug from the drill's two-snapshot comparison; PRE-STEP-8)

The 0.10/week drift is a CONVERGENCE measurement, not just a staleness
bound, and the per-module breakdown is the part that matters — a worst-case
aggregate could have been a thin module and would have said nothing:

  module    n     precision drift/wk   precision (09 Aug -> 16 Aug)
  PUMP      394   0.0967               0.7296 -> 0.6329
  DUMP      391   0.0460               0.8683 -> 0.8224
  FUNDING   327   0.0390               0.8344 -> 0.7954
  VOLUME    280   0.0552               0.8115 -> 0.8667
  REVIVAL   163   0.0313               0.7665 -> 0.7978

The WORST drift is the HIGHEST-n module (PUMP, n=394), which is the wrong
way round for an estimator settling as 1/sqrt(n). At these n, Beta(10,10)
shrinkage should be holding it far tighter. A module sitting near the 55
floor therefore flips push/no-push on roughly a weekly cadence — the
quantified form of the 35/48/58 FUNDING-MEDIUM spread the boot diagnostic
showed. TWO SNAPSHOTS IS NOT A TREND; the drill now keeps a SERIES
(history[] in data/restore-drill.json, drift normalised per week + deduped
n per module) and prints a 1/sqrt(n) expectation each run. Re-run weekly.
Falsification: if drift/week is still ~0.09 once n passes ~800, the
estimator is misbehaving rather than merely young, and step 8 must not
inherit it.

SEPARATE AND MORE URGENT — EXPECTANCY MULTIPLIERS ARE CLAMP-SATURATED:
  PUMP    E=-4.593  mult 0.6000 -> 0.6000
  DUMP    E=-1.630  mult 0.6000 -> 0.6000
  FUNDING E=-0.915  mult 0.6000 -> 0.6000
Their 0.0000 drift is NOT stability — it is the clamp floor. mult =
clamp(1 + E/E_SCALE, 0.6, 1.4), and these E values sit at or below the
floor, so the multiplier CANNOT MOVE no matter what the data does. For
three of five modules the expectancy weight currently carries ZERO
information: it is a constant 0.6 wearing the appearance of a measurement.
Only VOLUME (0.6395->0.6753) and REVIVAL (0.6408->0.6739) are still inside
the range and actually responsive.
STEP 8 DEPENDENCY: conjunction weights inherit these multipliers. Building
conjunction scoring on three constants and two live values would produce
weights that look derived but are mostly fixed. BEFORE step 8, decide
whether the clamp floor is right (is a 0.6 floor meaningful when E is -4.6,
i.e. four whole percent of negative net alpha?) or whether saturated
modules should be DISABLED via the 7.3 ladder rather than floored — a
saturated multiplier and a disabled module are different claims, and right
now the system makes the weaker one silently.

## LADDER WINDOWING BUG + FLOOR REDESIGN (v0.22.0, 16 Aug) — STEP-8 BLOCKER CLEARED

CHECK FIRST — had the ladder tripped PUMP? YES: PUMP and DUMP were both
TIGHTENED (badWeeks=3). The ladder works. But the check exposed WHY it
never finished, and why the clamp had become load-bearing:

  LADDER WINDOWED CALENDAR WEEKS, NOT QUALIFYING WEEKS. Weeks with n<25
  were neither counted as bad NOR excluded — they simply OCCUPIED A SLOT
  in the last-4 window. PUMP weeks 28/29/31 were all negative (E -0.81,
  -3.13, -11.47) but week 30 had n=17, so bad.length stuck at 3 and
  DISABLED was UNREACHABLE. Projected forward it is worse: as weeks
  advance a thin week DILUTES the window and can silently revert
  TIGHTENED -> OK with no improvement in performance. A quiet market or a
  day of downtime acted as a permanent shield against the ladder.
  FIXED: window over the last 4 QUALIFYING weeks (n>=25); thin weeks are
  dropped from the window entirely. "Complete week" now means "enough
  samples to judge". Live effect: PUMP/DUMP stay TIGHTENED at 3 and will
  reach DISABLED on the next qualifying bad week instead of never.

FLOOR REDESIGN. The fixed 0.6 floor was RESCUING, not protecting: at
n=401 PUMP's unclamped multiplier is ~0.0 (E=-4.79) and the floor lifted
it, overriding a CONFIDENT, strongly negative measurement — the opposite
of a noise floor's purpose. Uncertainty is a function of n, so the floor
is now too: 0.6 at n<100, interpolating to 0.1 at n>=300. Disabling is the
LADDER's job; the multiplier's job is continuous weighting. Two mechanisms,
two distinct jobs, neither pretending to be the other.
  module  n    E       floor   mult(was 0.6-clamped)  now
  PUMP    401  -4.791  0.100   0.600                  0.100
  DUMP    399  -1.641  0.100   0.600                  0.180
  FUNDING 329  -0.938  0.100   0.600                  0.531
  VOLUME  283  -0.652  0.143   0.640                  0.674
  REVIVAL 165  -0.648  0.438   0.641                  0.676
LIVE PUSH IMPACT: NONE. All five already scored below the 55 floor under
the 0.6 clamp (PUMP 41.6), so no module changes push/no-push today. What
changes is that the numbers are now honest, the ladder can finish, and
step 8 inherits live values.

STEP 8 UNBLOCKED: moduleExpectancy() now returns multRaw alongside mult.
WEIGHT COMPOSITES ON multRaw (unclamped by the floor); apply the floored
`mult` only to the push decision. "How much should this contribute to a
composite" and "can this alone clear the floor" are different questions
and one clamped value cannot answer both. multRaw is clamped BELOW AT ZERO:
E=-4.79 gives 1+E/E_SCALE = -1.40, and a negative weight would INVERT a
module's contribution — a claim ("predicts the opposite") that is not
earned and that the magnitude-not-direction finding argues against. Zero =
"contributes nothing" is the honest floor for a weight.

## v0.23.0 — FACTS vs CALLS (16 Aug). Why the channel was silent.

ROOT CAUSE was not a bug: eight sessions of individually-correct decisions
summed to removing almost everything. Two errors underneath:
 1. THE DIGEST BECAME A QUEUE. The standing rule is "never delay — deliver
    or suppress, never defer", and tier-2 catalysts were routed to an 18:00
    digest. A 06:40 listing surfacing at 18:00 is 11h stale: a queue in the
    one category where latency IS the value. DELETED in v0.23.0.
 2. "IS THIS TRADEABLE" was conflated with "IS THIS WORTH KNOWING". Every
    expectancy number measures the first. "Shorts pay longs 1.02%/8h" is
    TRUE regardless of whether trading it profits — the measurement never
    argued against being told.

THE SPLIT. Every message is a FACT or a CALL.
  FACT (listing, delisting, suspension, funding rate, CPI print, unlock):
    pushes IMMEDIATELY; NO conviction, NO tier, NO directional claim; not
    multiplied, not laddered, not budgeted. Conviction is a property of a
    PREDICTION — printing "conviction 78" on "MEXC listed PLUMBER" was a
    category error. Keeps recurrence suppression + cooldown + thread
    escalation, which are about not saying the same thing twice.
  CALL (conjunction, cascade setup, funding squeeze): keeps the whole
    apparatus — expectancy, ladder, tiers, conviction, HARD gate, budget.
  This dissolves the deadlock: the price suite measuring negative means it
  cannot make CALLS; it never meant you should not be told funding hit -1%.

EXECUTABILITY becomes an ANNOTATION for facts ("Executable: ~$800 at 50bps
— not sizeable at your range"), a HARD GATE only for calls. Suppressing a
thin listing spent the reader's decision for them.
T+30m LIQUIDITY RE-CHECK SURVIVES but now EDITS the already-published
message instead of gating it — immediacy and evaluation both.

NOISE CLASSES ADDED (suppressed entirely, no digest, no operator line):
promos/tournaments/prize pools/Earn campaigns, and operational housekeeping
(tick size, contract params, margin tiers, maintenance). Checked BEFORE the
novelty classifier so a rebranded promo makes no review noise either.
CROSS-SOURCE DEDUP on (venue, asset, event-type) for 6h — two pollers saw
the same MEXC UTILITY listing and the reference channel posted it twice.

NEW DETECTORS: SUSPENSION (deposits/withdrawals halted; ROUTINE when a
resumption time or named chain upgrade is stated, OPEN-ENDED otherwise and
that is the signal) and DELIST_SCHEDULED (dated forward delisting, treated
like an unlock with T-7d/T-1d reminders; cross-venue notices escalate one
thread rather than opening two).

TWO BUGS FOUND BY REPLAYING THE REFERENCE WINDOW, not by reading code:
 - SUSPEND_RX used the literal "suspend", which does NOT occur inside
   "suspension" (suspen-D vs suspen-SION). Every real Bithumb/Upbit notice
   says "Suspension", so the detector matched NOTHING. Now stems on
   "suspen" and accepts both word orders.
 - The spot-listing pattern had "new spot" and "listing of" but NOT
   "new listing" / "gets listed" / "now listed" — the commonest phrasings.
   The PERP branch matched "new listing", so equity perps classified while
   plain spot listings fell through to null and VANISHED.
 - Also: novelty gating had to be SCOPED to PERP/ANNOUNCE. Applied to every
   type it masked both new detectors outright (their titles contain ordinary
   words a 31-token seeded vocabulary has never seen). The gate exists for
   PRODUCT-LINE labels like "TradFi", not as a general unknown-word filter;
   equity risk elsewhere is already covered by the EQUITY check, which runs
   first.

FIXTURE: fixtures/reference-window-2026-08-13.json — the real 24-message,
21-hour capture, frozen. Asserts each message's routing individually plus
the 8-11 pushed-fact envelope. Measured on the live Bybit feed after the
change: 4 promos dropped by name, 12 non-catalysts dropped, 4 facts kept.
HEARTBEAT gains "Messages: N facts · N calls", and ZERO FACTS with a live
funnel for 48h is loud — facts do not depend on expectancy, so they should
never all stop. Boot assertion extended: every FACT type needs a declared
route (routes.js FACT_ROUTES), since an unscored type has no tier whose
absence would be noticed.
COHORT NOTE: rows now carry kind (FACT|CALL). Pre-v0.23.0 rows have
kind=null — do not read null as CALL. And `listing-deferred` is a
DISCONTINUED suppression reason: rows carrying it are the deferral era
(20-23 Aug window in v0.20.0-v0.22.0) and must not be pooled with
gate-suppressed rows, since the deferral was a routing decision rather
than a quality one.
IF VOLUME OVERSHOOTS: fix the Part 4 noise classifier, never cap facts.
A cap would reintroduce the queue by another name.

## v0.23.2 — STARVED DETECTORS FED, FUNDING THRESHOLD MADE RELATIVE (17 Aug)

STARVED DETECTORS. v0.23.0 shipped SUSPENSION and DELIST_SCHEDULED whose
every motivating example came from venues we DO NOT POLL for announcements:
POKT/ALLO suspensions were Bithumb; STORJ/TT/JASMY delistings were Upbit
AND Bithumb; we had only Binance/OKX/Bitget/Bybit. Both detectors had no
input for the exact events that justified them. ADDED: Upbit
(api-manager announcements), Bithumb (api.bithumb.com/v1/notices), KuCoin
(api/v3/announcements). MEXC and Gate have no free public notice endpoint
(MEXC 400 api-key-required, Gate 7 invalid-pair) — still symbol-diff only,
which is a KNOWN REMAINING GAP for their suspensions and delistings.
KOREAN PATTERNS were mandatory, not optional: Upbit and Bithumb publish in
Korean, so adding the feeds without them buys NOTHING. 입출금 중지/중단
(deposit+withdrawal suspension), 거래지원 종료/상장폐지 (delisting), 재개
(resumption => ROUTINE), 네트워크 업그레이드/점검 (upgrade => ROUTINE).
VERIFIED LIVE on both feeds: 14 suspensions + 3 delistings classified from
40 real titles, including the exact POKT/ALLO/STORJ/JASMY/TT events.

FUNDING THRESHOLD — the unbudgeted-fact premise, made to hold.
455 firings over ~30 days is ~15/day from ONE fact type: enough to take the
channel from silent to noisy in a single step, which is its own failure.
Facts are unbudgeted because volume is "bounded by how often things
happen", and FUNDING breaks that because ITS THRESHOLD IS OURS. So the
threshold does the work a budget is not allowed to do:
  1. PERCENTILE, NOT ABSOLUTE. Fire at the 99th percentile of THAT PAIR'S
     OWN 90d funding distribution (270 settlements), absolute floor kept as
     backstop, cached 7d, one call per surviving candidate (cheap absolute
     gate first — gate before you invest). Unknown distribution falls back
     to the floor; it must never mean "fire freely".
     MEASURED: of 9 pairs over a 0.10% test floor, 8 dropped as routine for
     themselves — ACEUSDT at -0.279% has p99 1.334% (nothing), while
     BMTUSDT at -0.237% exceeds its own p99 of 0.184% (genuinely unusual).
     Exactly the "routinely -0.4% is not extreme at -0.4%" argument.
  2. STATE-ENTRY, NOT STATE-PRESENCE. fundingDecision() (pure, fixtured)
     fires on ENTERING the extreme state, on a 50%+ intensification, or on
     a SIGN FLIP — never on persistence. Hysteresis at 0.8x threshold so a
     pair oscillating around the bar cannot re-enter each cycle. Fixture
     asserts a pair parked at extreme funding fires ONCE, not six times.
     This is the recurrence lesson applied to facts.
Also removed directional editorialising from the FUNDING fact ("squeeze
fuel", "flush risk") — a fact states who pays whom, the annualised rate and
the pair's own percentile, and asserts nothing about direction.
WATCH: fact volume for 48h. Suspensions look FREQUENT on Korean venues (14
in one 20-item feed pull, though most were historical and baselined out).
If facts exceed ~25/day the fix is the threshold or the classifier, never a
cap.

## v0.23.3 — routine suspensions must EARN the channel; parse failures go loud

SPEC CORRECTION (operator's own): "routine -> low prominence, still push"
was WRONG. A scheduled wallet halt with a stated resumption during a chain
upgrade is OPERATIONAL HOUSEKEEPING — the same category as the tick-size
updates we already suppress — and Korean venues publish many (14 in one
20-item pull). A routine suspension now reaches the channel ONLY if it
carries information a holder could act on:
  OPEN-ENDED     no resumption stated (the original signal)
  UNLOCK OVERLAP verified unlock within 7d — supply cannot move, distorting it
  PENDING DELIST asset already has a scheduled delisting (the sequence that
                 traps holders: halt first, delist after)
  CROSS-VENUE    same asset halted on 2+ venues inside 12h — not maintenance
Everything else goes to the REVIEW LOG, not the channel. The message states
WHICH condition earned it, so a reader never wonders why a routine notice
arrived. suspensionInterest() is injectable and fixtured on all four.

PARTIAL PARSE FAILURE HAS ITS OWN STATE (three-state discipline applied to
FIELDS, not just classes). The null log only catches titles matching
NOTHING; it would never see a delisting that matches the pattern but whose
DATE extraction fails. Both degradations are bad — a dateless delisting
alert asserts less than it appears to, a silent drop loses a real event.
Now: pattern matched + scheduling language present + no parseable date =>
PARSE_FAILED -> [OPERATOR] line naming the field + review-log entry, and
NOTHING is pushed. A genuinely dateless "Delisting of FOO" (no scheduling
language) still uses the immediate path, so the distinction is between
"a date exists and we failed to read it" and "no date exists".

TWO BUGS FOUND BY THE SUITE CRASHING, not by reading code:
 1. store.js save() used a FIXED `${FILE}.tmp`. Any second writer — a
    fixture, a replay script, a second bot after a bad restart — shared one
    scratch file with the running bot: A writes tmp, B writes the same tmp
    and renames it away, A's rename throws ENOENT and state can be left
    half-written. Now per-process (`${FILE}.${pid}.tmp`), so concurrent
    writers are independent and rename stays atomic per writer. This is a
    PRODUCTION bug, not a test artefact.
 2. The ladder fixture called evaluateLadder() -> save(), writing a
    SYNTHETIC module into the live bot's state.json — the same read-only
    breach that tore outcomes.json in v0.17. evaluateLadder now takes an
    injectable state which also suppresses the save; the fixture asserts
    live ladder state is untouched afterwards.

## v0.23.4 — SYMBOL-LEVEL CLASSIFICATION (18 Aug)

## BUG CLASS — "a classifier that exists but isn't ROUTED to a path that emits
## what it classifies" (THIRD instance, now named)

  1. DIGEST tier existed with NO READER (v0.20.0).
  2. The announcement path carried its OWN equity regex, which drifted out of
     sync with taxonomy.js and let 'TradFi' through (v0.21.x).
  3. The TICKER path (symbol-set diffing) emitted LISTING facts without ever
     calling ANY equity/leverage classifier — TSLAX, CRCLX, WDC3L/3S,
     AXTI3L/3S reached the channel (v0.23.4). isEquityText() was built for
     announcement TITLES, and a brand-new listing has no title AND no ticker
     data, so classification had to run on the SYMBOL STRING.
GENERALISABLE CHECK, now enforced at boot: WHEN YOU ADD A CLASSIFIER,
ENUMERATE EVERY PATH THAT EMITS THE THING IT CLASSIFIES AND ASSERT EACH ONE
CALLS IT. checkClassifiersWired() in routes.js declares emitter -> required
classifier and FAILS STARTUP otherwise; it would have caught this the moment
the ticker path was written. Same idea as the tier-route assertion, applied
to classifiers instead of delivery.

CONTAMINATION MEASURED (Fix 3 first, for this reason):
  outcomes rows: 14 of 4,309 leveraged-token rows (0.3%), 12 carrying alpha
    and feeding multipliers (~0.7% of the deduped sample) — real but BOUNDED;
    it has not meaningfully skewed expectancy. Includes SKHYNIX3L and
    CSOPSKHYNIX2L, i.e. KOREAN EQUITY leveraged tokens, so both leaks compound.
  state.universe: 8 leveraged entries (ETH5L/5S, UNI5L, SOXL3L, XAG5S, SNDK3L/3S)
  state.adv: 429 of 3,061 symbols are EXCLUDE-class (394 leveraged + 35 xStock)
  baselines: 0 — clean.
LEVERAGED_TOKEN is now a taxonomy class, excluded from listing facts AND from
every price detector: a 3x product's series is a DECAYING DERIVATIVE (daily
rebalance, volatility drag) and moves violently for structural reasons.

FALSE POSITIVE CAUGHT ON LIVE DATA BEFORE DEPLOY — the important one.
GMX classified EXCLUDE: it decomposes to stem 'GM' + X, and GM (General
Motors) is in the equity list. GMX is a major crypto protocol. Stem LENGTH
cannot separate the cases — MCDX, WMTX, SPYX and PGX are GENUINE xStocks with
2-3 char stems while GMX is a false positive with a 2-char stem. So the
discriminator must be the WHOLE SYMBOL: a CRYPTO_EXCEPTIONS guard is checked
BEFORE the X rule (GMX, MAX, IMX, AVAX, DYDX, CVX, FLUX...). This is the
inverse of, and enforcement for, "a ticker match ALONE must never block".
EXTEND CRYPTO_EXCEPTIONS whenever a genuine crypto is caught by the X rule.
Lesson: the rule was written to the spec and still had to be validated
against live symbols — the spec's own warning about ticker collisions was
correct and the first implementation violated it anyway.

DEFAULT DIRECTION INVERTS, DELIBERATELY (written into the code comment so a
future session does not "fix" the inconsistency): announcements default
CLOSED (UNRECOGNISED diverts, most titles are noise); symbols default OPEN
(UNRECOGNISED PUSHES and is logged, because most new symbols are genuine
crypto listings and blocking on ambiguity would suppress the thing we want).
Same three states, opposite default, driven by BASE RATES.

FIX 5 RESOLVED BY CHECKING, NOT ASSUMING: OKX X-Perps are a MIXED product
line — CHIP and ACU are not in OKX's USD-swap instrument list while ETHFI is
genuine crypto (EtherFi). A blanket rule on the product NAME would have
suppressed real crypto perps. Per-symbol classification is correct, which is
what Fix 1 does anyway.
BATCH COLLAPSE now runs on the ticker path too (3+ listings from one venue in
one poll cycle = ONE message); the mechanism should not differ by which
poller saw the event.

## v0.23.5 — EXCLUDE is now LOGGED; ADV purged

THE INSTRUMENT HAD THE GAP, NOT JUST THE RULE. A review log existed for
UNRECOGNISED — the AMBIGUOUS case, which pushes anyway — while EXCLUDE, a
SILENT DROP, went unrecorded. That is backwards: confidence is exactly what
makes a wrong exclusion invisible. GMX was caught only because 3,061 live
symbols happened to be swept before a deploy; the next collision would have
been suppressed and appeared nowhere. And CRYPTO_EXCEPTIONS is
hand-maintained, so wrong exclusions are GUARANTEED, with a failure mode
(a listing that never arrives) indistinguishable from a quiet day.
Now every EXCLUDE is recorded with symbol, matched rule, class and venue
(data/excluded-symbols.json), reviewed via `node review-exclusions.js`
(xStock section flagged HIGHEST COLLISION RISK — that is where a real
crypto name would appear), and counted in the heartbeat:
  Excluded symbols: N (N leveraged · N xStock) · N in 24h
RULE: build the review instrument for the CONFIDENT branch too. An
uncertain verdict announces itself; a confident wrong one does not.

ADV PURGED: 433 EXCLUDE-class symbols removed of 3,065 (now 2,632), and
universe.js no longer accumulates them going forward. They were harmless to
other symbols' denominators but inflated the heartbeat's `adv N cells`
figure — an instrument you have to mentally discount is a degraded
instrument. Run INSIDE the bot's own process as a self-marking startup
migration, not an external script: a separate process writing state.json
would race the bot's saves (the lost-update class).
The 12 contaminated OUTCOME rows are LEFT IN PLACE with this note. At 0.3%
of the corpus, purging would move the canonical benchmark for a rounding
error — and the benchmark's stability is worth more than the rounding.

## ═══ MILESTONE — §7.3 CLOSED LOOP COMPLETE (21 Aug 2026) ═══

THE LADDER FORMALLY RETIRED PUMP AND DUMP ON MEASURED EVIDENCE — the
original bot's two loudest voices, DISABLED by a mechanism that required
three qualifying bad weeks of negative net expectancy, survived a
windowing bug that would have shielded them forever, and completed
exactly as predicted five days earlier. First end-to-end operation of the
closed loop the spec promised: measure -> weight -> tighten -> remove.

DISABLED IS NOT DELETED — confirmed on live data, not asserted from code:
both modules keep recording to outcomes as suppressed='ladder-disabled'
with their mult stamp and FLOORED tag, so the cohort keeps accruing
labelled negatives on them. If gate-passing PUMP signals ever measure
differently from the sub-gate population that condemned them (OPEN
QUESTION — every module statistic is provisional-by-population), the
re-derivation can reopen the case. RETIREMENT ON EVIDENCE, REVERSIBLE ON
EVIDENCE.

Deferred, after step 6: one sweep of the boot gates for a THIRD live-state
clock (multipliers struck 17 Aug, ladder struck 21 Aug — both found by the
gate refusing to boot on a Tuesday).

## ═══ STEP 6 SESSION (21 Aug 2026) — TRIAGE DONE, UNLOCK MODULE LIVE ═══

BUCKET TABLE (protocol predicted ~half in D; result: 7 of 12, plus one retiree):
  EIGEN  D  BitGo custody — WalletFactory->WalletSimple (EIP-1167 clones), 21
            wallets, 484M EIGEN. NOT a vesting-contract family: OZ selectors
            null, bEIGEN clean (1.55B in wrap backing + EigenStrategy only).
            The protocol's warning held: the "vesting contracts" were custody.
  ARB    C  hundreds of on-chain vesting wallets + DAO treasury proxy (2.56B);
            enumeration deferred — announcement path used (92.65M monthly,
            16th, documented since launch, Aug 16 2026 event confirmed).
  STRK   D* vesting on Starknet L2 (no eth_call path in our stack); project
            docs give 127M monthly on the 15th through Mar 2027.
  ZRO    D  GnosisSafes hold allocations (top 3 holders). Aggregator: monthly
            ~20th. NEEDS project-source confirmation before shipping.
  OP     D  GnosisSafes (1.29B + 460M). Published schedule exists; date needs
            project-source confirmation.
  ENA    D? top holders EOAs/custody + one large unverified contract (1.19B)
            unprobed. Aggregator: ~171.9M on Aug 5. Needs one probe + source.
  SUI    D  foundation custody; aggregator: 24.1M on Sep 3. Needs project src.
  SEI    D  foundation, off-chain schedule. Needs project source.
  TIA    C  Cosmos-native vesting accounts (LCD-readable, bespoke).
  APT    C  aptos_framework::vesting (REST-readable, bespoke); famously
            regular monthly ~11th/12th.
  JUP    C  Jupiter Lock program on Solana (bespoke).
  INJ    —  RETIRED: fully unlocked since Jan 2024, deflationary buybacks.
            Flagged never-alert in unlocks.json. The gate-passing 12 are 11.

EIGEN BACKTEST (bucket-D form: announced schedule vs custody outflows):
  10 consecutive month-end distributions, 2025-10-30 -> 2026-07-30, from the
  custody family. Wallet 0x34BcF805: 7.94-7.95M on the 30th, metronomic.
  0x3De6b6b1: 1.44-1.70M month-end. Aggregate ~9.6M EIGEN/mo (~0.6% of
  supply). Largest wallet 0x22eC5211 (176.7M) near-dormant = later tranches.
  Decimals asserted (1e18; implied initial 65.9M < circulating bound).
  RECIPIENT-TYPE SPLIT IS NOT ON-CHAIN for custody — sum is by wallet family
  only; the team/investor split lives in the foundation's books, not the
  chain. Stated as a limit, not silently skipped.

SHIPPED (verified only — aggregator dates are NOT project announcements and
did NOT ship): EIGEN monthlyDay 30 (announcement+onchain-backtest, next
2026-08-30 — T-7 fires 23 Aug), ARB monthlyDay 16 (announcement), STRK
monthlyDay 15 (announcement). unlocks.json is read-only to the bot (1h
cache) so the edit is race-free; module goes from 0 verified to 3.

TWO BUGS found the day the first real events[] shipped — loadUnlockEvents
(the suspension unlock-overlap check) read data/unlocks.json (ENOENT; file
is at ROOT) and Object.entries'd an ARRAY (keys '0','1'... so symbol lookups
could never match). The overlap condition was STRUCTURALLY EMPTY since it
shipped. The fixtures injected `unlocks` and never exercised the loader —
hermetic tests cut both ways: an untested integration point is an untested
premise. End-to-end now verified through the real file.

NEXT (unlock work): confirm project-source dates for ZRO/OP/ENA/SUI/SEI
(minutes each); TIA/APT/JUP bespoke reads when wanted; ARB contract
enumeration optional (announcement path suffices). ADV at 13d — severity
bands wait ~2.5 more weeks; pressure_vs_book stays ordinal.

## v0.24.1 — bucket-D backtest named; e2e companion clause; INJ retirement asserted

BUCKET-D BACKTEST FORM, named for reuse: for custody-held schedules,
"ANNOUNCED vs OBSERVED OUTFLOWS" is the backtest. Ten consecutive
month-ends with one wallet metronomic at 7.95M is arguably STRONGER than a
contract read — it verifies BEHAVIOUR, not intent. The protocol's rule
survives translation: no forward date trusted until a past one replayed
on-chain. EIGEN's replayed ten times.

E2E COMPANION CLAUSE to the hermetic rule: fully hermetic fixtures never
exercise the LOADER, so a condition can be structurally empty for weeks
while its tests pass (loadUnlockEvents: wrong path + array-as-object,
found only when the first real events[] shipped). Countermeasure is NOT
less hermeticity: gates stay hermetic, plus ONE end-to-end fixture per
module that runs loader-included through a FROZEN copy of the real schema
(fixtures/unlocks-schema-sample.json). "Hermetic against one input is not
hermetic" + "hermetic everywhere proves nothing is plumbed" are the two
halves of the same rule.

INJ RETIREMENT is now a POSITIVE STATE: retired:'fully-unlocked' in
unlocks.json, boot-asserted (a stale aggregator list re-adding monthlyDay
or events[] to a retired token FAILS STARTUP), belt-guarded in pollUnlocks
and loadUnlockEvents. An absence can be silently reverted; a state that
something asserts against cannot.

WATCH: 23 Aug = the unlock module's FIRST VERIFIED PUSH EVER (T-7 on
EIGEN's Aug 30 emission). Delivered => step 6's core loop proven live
(verified date -> staged fact -> delivered). Not delivered => the delivery
instruments say why. ADV at 13d of 30 — unlock facts push without severity
bands until ~7 Sep; message context states amounts (9.6M/mo) honestly.

## ═══ MILESTONE — FIRST VERIFIED UNLOCK PUSH DELIVERED (23 Aug 2026) ═══

[ALERT FACT] EIGEN unlock in 7 days — 2026-08-30, T-7 on the custody
emission, delivered to the channel (proven by the delivery-gated counter:
fired++ requires dispatch()===true requires confirmed message ids — the
v0.19.2 instrument doing its job). VERIFIED DATE -> STAGED FACT ->
DELIVERED: the loop the project exists for, closed live for the first
time, on a date that replayed ten times on-chain before it was trusted.
The module simultaneously held 168 estimated-only rows SILENT — pushing
the one earned date while suppressing 168 guesses is the whole design.

ONE WRONG NUMBER RODE ALONG (fixed v0.24.2 before the T-3 on the 27th):
the message printed '~4.97% of market cap' — the STALE pctOfMcap from the
estimated-era row, an aggregator full-tranche figure ~an order of
magnitude above the actual ~9.6M monthly emission. Verified entries now
drop pctOfMcap (events[].detail carries the measured size), and the
confidence line states the real provenance ('Date verified — source:
announcement+onchain-backtest') instead of a generic calendar claim.
Lesson attached to the milestone: when a row is PROMOTED from estimated
to verified, every field of the old row is suspect — verify the fields,
not just the date. Fields left from the estimated era are stale by
construction.

NEXT STAGES: T-3 fires 27 Aug, emission 30 Aug (watch actual custody
outflow ~9.5M as the closing confirmation), ARB T-7 ~9 Sep, STRK T-7
~8 Sep. Then the five one-probe confirmations (ZRO/OP/ENA/SUI/SEI).

## v0.24.3 — PROMOTION CONSTRUCTS, NEVER PATCHES (structural, 24 Aug)

The 4.97% blemish made structural: estimated -> verified promotion now
BUILDS the new row from verified fields only (promoteRow whitelist copy,
same mechanism as recordAlert's row literal) instead of editing the date
in place and inheriting the estimated era. promote-unlock.js is the tool
for the five pending confirmations — hand-editing unlocks.json for a
promotion is what shipped the stale number. Boot-asserted: a verified row
carrying an estimated-only field (pctOfMcap et al.) FAILS STARTUP.
promoteRow also refuses promotions without provenance and refuses retired
tokens (a retired token is re-opened deliberately, not promoted past).
"Verify the fields, not just the date" — by shape, not vigilance.

## VPS MIGRATION QUEUED (24 Aug) — see VPS-MIGRATION.md

Operator decision: migrate now (before the 27th T-3), closing the
two-week uptime re-measure by decision rather than measurement. Prompt
file written with three corrections to the sketch (repo is ~40 versions
stale — step 0 is the push; storage is JSON not node:sqlite; no
RADAR_TRANSPORT flag exists), the geo-block smoke test as a hard gate,
systemd StartLimitBurst=5 (boot gates exit(1) by design — bare
Restart=always reproduces the 21 Aug crash-loop shape unattended), SSH
hardening day-one, and a decommission CHECKLIST ending with the desktop's
new stated role: offsite backup target and nothing else.
SOMEDAY ITEM (new safeguard-class instance, named): the repo's staleness
is indistinguishable from freshness until something clones it. Heartbeat
line `last push: N versions behind` if pushes stay manual.
BLOCKED ON: the operator provisioning the box (EU region) and handing the
session an IP.

## THE $5 DECISION — closed 24 Aug, and the order it was done in matters

Opened 12 Aug with a MEASURED miss (CPI stages lost to a sleeping desktop),
not a hypothetical. Answered first at $0 — sleep-never on AC plus 54 wake
timers — and that remediation WORKED: the wake mechanism was never even
exercised, because sleep-never held on its own. Closed now NOT because the
desktop failed, but because the module worth protecting finally exists:
verified unlock dates on a live calendar, backtested ten times before they
were allowed to speak.
THE ORDER IS THE POINT. The VPS carries PROVEN CARGO, not hope. Buying
uptime in August would have been protecting a channel that had nothing
scheduled to say; buying it now protects a T-3, an emission confirmation,
and three verified schedules with five more behind them. Any future
infrastructure question should be asked in the same order: measure the
loss, exhaust the free fix, and spend only when the thing being protected
has earned protection.

## STEP 0 DONE + PROVENANCE FIXES (25 Aug)

PUSHED 2ac5876..d171c2e — repo went v0.17.0-era -> v0.24.3. This was
DISASTER RECOVERY first, migration prerequisite second: the desktop had
been a single point of failure for ~40 versions, and what GitHub held was
a bot from before the delivery layer, the boot gates and the unlock module
existed. It would have cloned, started fine, and been wrong everywhere.
FULL-HISTORY SECRET SWEEP (not just HEAD — the bat's guard protects the
CURRENT push and says nothing about the v0.9.x-era ones): .env NEVER
committed, data/ NEVER committed, no key-shaped file in any of 95 distinct
paths across 84 commits. Clean, including the early pushes.

COMMIT MESSAGE WAS LYING BY CONSTRUCTION: hardcoded "v0.9.4 -> v0.17.0" in
PUSH-TO-GITHUB.bat, so every future commit would carry the same false
label regardless of contents. Now DERIVED from src/config.js at push time
(and the push tags v<VERSION>). package.json had ALSO drifted — 0.3.0
against config.js's 0.24.3 — so deriving from package.json would have
swapped one lie for another; synced, and fixture 29 now fails if the two
files diverge or if the bat reverts to a hardcoded message.
This is the same class as the stale-repo problem itself: a label whose
wrongness is indistinguishable from rightness until someone reads it.
MIGRATION TIMING DECIDED (25 Aug): migrate on the 31st or after — NOT
before. The 27th/30th are the unlock module's first live calendar run;
migrating into it would change two variables at once and make any failure
ambiguous between module and platform. Run the T-3 and the emission
confirmation on the desktop (reliable since sleep-never, 12 Aug), then
migrate a twice-proven pipeline. Step 0 already closed the urgency
argument — repo current, backups exist. Steps 1-4 can be done any time;
the 31st is then just step 5.

## ═══ 27 AUG — T-3 DELIVERED, AND THE FIX PROVEN BY COMPARISON ═══

Both EIGEN messages, same token, four days apart:
  T-7 (23 Aug, v0.24.1): "scheduled token unlock (~4.97% of market cap)"
                         "Date verified against the public unlock calendar."
  T-3 (27 Aug, v0.24.3): "scheduled token unlock"
                         "Date verified — source: announcement+onchain-backtest."
Stale aggregator field gone, real provenance stated. 308 estimated-only rows
held SILENT in the same cycle (up from 168 at T-7). The verified-vs-guess
ratio is the design working.

## FACTS WERE STILL TALKING THEIR BOOK (v0.24.4)

Reading the milestone message rather than admiring it found the contradiction:
the T-3 header said "fact · no directional call" and its body said
"🔔 Close now — the days just before an unlock are where the drift usually
shows." An IMPERATIVE plus an UNEARNED EDGE CLAIM, in one message.
Sweep found ELEVEN such lines across SIX fact-emitting modules: "usually dump
hard and fast", "often marks a local capitulation bottom", "reversal risk",
"markets often front-run them", "typically sell off sharply".
WHY IT SURVIVED: the FACT/CALL split (v0.23.0) removed conviction scores and
tier labels — the STRUCTURED fields — and left the PROSE untouched. I audited
the modules that were TALKING; unlocks had been silent since the split, so its
defect was invisible until it spoke. A SILENT MODULE'S DEFECTS ARE INVISIBLE
is now a third face of the same coin as the write-only accumulators and the
untested loader.
THE LINE, drawn by the project's OWN measurement: agreement predicts
MAGNITUDE, not DIRECTION (36% win rate both sides). Volatility language is
evidence-backed and stays ("expect wider swings", "first minutes are
violent"); DIRECTION language is not and is gone.
ENFORCED ON PROSE by fixture 30 — a lint over string literals in every
fact-emitting module, with a self-test proving the guard can fire and that
volatility phrasing still passes. Structured-field gates could never have
caught this; the defect lived in English.

## v0.24.5 — the lint hardened, and it caught the ORIGINAL defect (27 Aug)

Both drift questions answered structurally:
  STATIC over source files (not emitted output) — silent modules covered.
    An output lint would reproduce the exact bug it guards against:
    CASCADE unproduced, REVIVAL silenced, PUMP/DUMP disabled all have
    prose nothing watches.
  AUTO-DISCOVERED file set (directory walk of src/sources + core message
    builders) — not a hardcoded list, not even a registry. A new module
    is covered the moment its file exists. The hardcoded list in the
    first cut was the CRYPTO_EXCEPTIONS defect reproduced inside the
    guard built to prevent defects.
SECOND RULE ADDED (all modules, calls included): frequency claims
("usually/typically/historically/often") REQUIRE evidence on the same
line (n=, N of M, measured, percentile). Volatility/mechanism language
stays; unsupported statistics go.
THE AUTO-DISCOVERY PAID IMMEDIATELY: it found pump.js still carrying
"⚠️ Historically these fade — treat as exit/fade candidate, not an
entry" — THE LITERAL PHRASE FROM THE FIRST CRITIQUE of this project,
alive three weeks into the fixes because pump.js is ladder-disabled
(silent => invisible) and was never on the hardcoded list. RESOLVED BY
CITATION, NOT DELETION: the claim was true and had since been measured —
"Fade measured on this corpus: 22 of 30 PUMP-HIGH reverted within 24h,
median alpha −13.5% (n=30, sub-gate population — provisional)". The
oldest open item in the project closed by giving the sentence the
statistics it always owed.

## 27 AUG (later) — push provenance live; SECOND autostart entry discovered

PUSH-TO-GITHUB.bat needed two repairs before the derived commit worked —
both were BATCH QUOTING failures that killed the parser silently (result
file contained only the header). First the nested-PowerShell attempt, then
delims=' colliding with the apostrophe-quoted command. Lesson recorded:
cmd.exe CANNOT BE TESTED from the agent sandbox, so clever batch is
untestable batch — the fix was to stop being clever (node emits the
version to a temp file, set /p reads it). Verified live: commit 517719b
"v0.24.5", tagged, pushed. History tells the truth from here.

STARTUP FOLDER HAS TWO BOT LAUNCHERS: market-radar.vbs (ours, 17/07) AND
start-bot-on-boot.vbs (25/08 05:52 — NOT created by the agent, NOT in the
repo; provenance unknown, presumably the operator). Currently exactly one
cmd+node pair is running (verified via CHECK-STATUS), so no live double
instance — but if both scripts start run-hidden.bat, the NEXT REBOOT runs
two loops: getUpdates 409 fight + state.json races on one machine.
Cutover checklist updated: step 5's check is now "Startup folder EMPTY of
bot entries", not "no market-radar.vbs". ASK THE OPERATOR what
start-bot-on-boot.vbs is before deleting it.
STARTUP MYSTERY RESOLVED (27 Aug): start-bot-on-boot.vbs launches
Desktop\infoxchange-bot\run-bot-forever.bat — a DIFFERENT project of the
operator's, not a market-radar duplicate. No getUpdates/state hazard.
Machine last booted 13 Aug, so the file has never executed. The hazard
FLIPPED: the decommission rule "Startup empty of bot entries" would have
deleted the OTHER project's launcher. Corrected to "no MARKET-RADAR
launcher remains" — scope removal rules precisely; an over-broad cleanup
breaks a neighbour. (Also confirmed: 14 days uptime, consistent with
sleep-never working — the machine sleeps, it does not reboot.)

## THE SCHEDULED RE-MEASURE, RUN ON TIME (27 Aug) — the $5 gate, answered

Nearly skipped the gate built to gate this exact decision — the migration
was scheduled without the measurement that was scheduled to justify it.
Run before the 30th as directed.

CLEAN-ERA RESULT (rows since 13 Aug, sleep-never config, 13 full days):
  overall hour-coverage 88.1% · worst hours 77% (08:00, 10:00)
  vs the mixed-era profile's ~50% coin flip: the free fix took expected
  FULL-stage misses from ~14 of 28 to ~3 of 28.
PROXY CAVEAT, stated: row density varies 1.2-9.4/hr by day, so hour-
coverage UNDER-counts uptime on quiet days. True availability is somewhat
above 88%.
BUT THE HEADLINE INCIDENT IS REAL, not proxy noise: Aug 23 04:32 ->
Aug 24 06:15, ~26 HOURS DARK, corroborated by the run-hidden restart
marker at 06:15:56. Cause almost certainly UNPLUGGED -> battery -> sleep
(sleep-never is AC-only; wake timers are enabled on DC but nothing
scheduled fired in that window). The T-7 survived by four hours of luck:
it fired ~00:00, the machine died ~04:32. Had the emission or T-3 fallen
in that window, the module's first calendar run would have carried a miss.

VERDICT, honestly framed: the desktop is NOT a coin flip anymore and NOT
99% either. The free fix solved the systematic problem (S0 idle naps);
what remains is the HUMAN one — a laptop is sometimes a laptop. ~12%
expected stage-miss risk, concentrated in exactly the windows nobody
plans. The VPS is now OPTIONAL on uptime grounds alone: it buys the last
~12%, freedom from the machine's other uses (a second bot now shares it),
and the streaming option. The 25 Aug principle stands re-ordered as
applied: loss measured, free fix exhausted AND VERIFIED, spend now a
choice rather than a necessity. DECISION IS THE OPERATOR'S; the 31st
window remains open either way.

## UPTIME RESIDUAL CLOSED FURTHER + TWO REFRAMES (27 Aug, Session A pt3 preamble)

DC SLEEP-NEVER SET (was AC-only — the exact hole the Aug 23-24 26h outage
fell through). Expected: 88.1% clean-era coverage into the mid-90s, free.
Cannot fix: lid-close, battery exhaustion, true shutdown.

STAGE-vs-EVENT REFRAME (operator's): "3 of 28 stages at risk" OVERSTATES
the loss. Each unlock event emits FOUR stages; a missed T-3 still leaves
T-0 and T+3, macro's T+5m/T+30m both cover a print. The honest residual is
"occasionally one fewer reminder on an event you are still told about" —
which moves the VPS case almost entirely OFF uptime and onto the two real
grounds: independence from a machine that also runs the infoxchange bot,
and streaming later. The post-30th decision is made on THOSE grounds.

NEW SAFEGUARD-CLASS VARIANT, named: A FILTER WHOSE JUSTIFICATION HAS
EXPIRED STILL RUNS. The 12-token unlock list came from gate-passing ∩
has-schedule, built when unlocks were going to be TRADE SIGNALS. The
FACT/CALL split made the gate an annotation — tradeability stopped being
the constraint — and nothing announced that the list no longer matched
its own rationale. It did not break; it quietly kept enforcing a dead
premise. Same shape as the contingent bypass; same countermeasure: RECORD
WHY A FILTER EXISTS NEXT TO THE FILTER, so an architectural change trips
over the stale premise instead of inheriting it. The real constraint for
unlock coverage is VERIFICATION COST, which is what discovery automation
attacks.

## SESSION A PART 2 — five promotion attempts, ONE qualified (27 Aug)

ZRO PROMOTED (verified count now 4: EIGEN, ARB, STRK, ZRO): monthly on the
20th, derived from the LayerZero FOUNDATION'S OWN published rule (TGE
2024-06-20 + 1yr lock + monthly over 2yrs => 20th; fully vested
2027-05-20) — the day follows from the project source arithmetically, not
from aggregators. Bucket-D backtest ATTEMPTED and honestly recorded as
non-confirming, non-contradicting: the three top GnosisSafes show
irregular ops movements, no monthly cadence — the emission path was not
located. Demote-trigger written into the note: no market-visible event on
Sep 20 => back to estimated.

FOUR STAY ESTIMATED, reasons recorded:
  OP  — the docs page that carried the unlock chart was reorganised away;
        no project source reachable in minutes. Retry later.
  SUI — official schedule EXISTS (sui.io/token-schedule + circulation
        API) but publishes monthly AMOUNTS, not the day; aggregators
        split (1st vs 3rd); foundation reserves adjustments. PATH: the
        API's month-step observed at the boundary would pin the day
        empirically — an automation candidate.
  SEI — aggregator-tier only (15th monthly per trackers). No project src.
  ENA — PROBED (the brief's requirement): the 1.19B contract is an EIP-
        1167 clone of an UNVERIFIED implementation, OZ selectors null,
        irregular small outflows => bucket D custody, no readable
        schedule, no project-published calendar found. Estimated.
Aggregator dates did not ship. One of five is what the standard costs;
the alternative was four guessed days feeding T-3s that mistime.

## PART 3 PRE-REGISTRATION (before discovery runs — falsification lines stated)

Universe: 135 distinct gate-passing symbols. Discovery v1 is ETHEREUM-ONLY
(Blockscout+Etherscan); non-EVM chains (Sui/Sei/Aptos/Solana/Cosmos) are
out of v1 scope and stated as such in every report it emits.
PREDICTIONS:
  1. 50-70 of 135 resolve to a canonical Ethereum ERC-20 (>$500k DEX
     liquidity guard against symbol-squatters).
  2. Of resolvable tokens, 15-30% return bucket A/B readable vesting.
     FALSIFICATION: <10% => the selector battery is too narrow (per the
     brief), not "the ecosystem is unreadable". >50% => the classifier is
     too loose and is matching non-vesting contracts.
  3. Bucket D (custody/safes) will be the LARGEST bucket among tokens
     that have locked supply at all — modern launches custody their
     vesting (EIGEN pattern).
  4. Validation: EIGEN reproduces bucket D/custody with the 0xa7198f48
     WalletFactory family; INJ yields a retirement proposal; ENA
     reproduces bucket D (unverified clones).

## DISCOVERY BUILT, VALIDATED, FIRST BATCH RUN (27 Aug) — pre-registration honoured

discover-vesting.js automates the EIGEN sequence: holders -> contracts ->
1167-clone impl lookup -> selector battery -> bucket. Ethereum-only v1,
read-only, report to data/vesting-discovery.json.

VALIDATION CAUGHT THREE REAL DEFECTS before any new token was trusted:
 1. DexScreener symbol resolution sent EIGEN to a SYMBOL-SQUATTER (a fake
    EIGEN with >$500k liq). Fix: authoritative KNOWN_TOKENS map for known
    tokens; search-resolution is a flagged fallback only. (AAVE later
    failed to resolve at all — the fallback is weak both ways.)
 2. BRIDGED TOKENS show their escrow as a 50% holder (INJ). Fix:
    NON_NATIVE map -> honest verdict "vesting lives on <chain>; v1 cannot
    read this token — do NOT mistake for NO-LOCKED-SUPPLY". My
    pre-registration #4 was WRONG on mechanism: INJ's retirement cannot
    be machine-proposed from Ethereum; it came from public docs.
 3. Pools/staking/OFT-bridges polluted verdicts -> skip classes added.

RESULTS (12 tokens through v2):
  D-CUSTODY: EIGEN, ENA, ZRO, LINK, UNI — prediction #3 (custody
    dominates) STRONGLY confirmed. Bonus: ZRO's custody family fully
    enumerated (27 contracts, GnosisSafes + BitGo WalletSimple clones —
    the same BitGo pattern as EIGEN); LINK shows the known 30M-chunk
    Chainlink safes.
  NON-NATIVE: INJ (honest).
  NO-LOCKED-SUPPLY + retirement proposal: CRV, DEXE, PENDLE, ONDO.
    ONDO is the live caveat-in-action: it HAS locked supply per its
    published schedule — held in EOAs or below-threshold contracts, so
    invisible here. The proposal text's warning ("absence of readable
    locks is not proof of full unlock") is not boilerplate; ONDO is the
    example. NEVER auto-retire from this signal alone.
  A/B READABLE: ZERO of 12 — BELOW the pre-registered 10% line.
    Stated interpretation applies: the selector battery is too narrow
    (no live Sablier/stream probe validated, no custom-vesting selector
    set) AND the sample skewed to majors where custody dominates. Next
    battery expansion: Sablier stream lookup validated against a known
    Sablier token, plus common custom selectors (cliff(),
    getVestingSchedule(), vestingSchedules(address)). Do not conclude
    "the ecosystem is unreadable" until the wider battery has run over
    the mid-cap range where OZ-shaped vesting actually lives.

QUEUE (next sitting): battery expansion -> full 135-symbol sweep ->
generic reader for whichever bucket surfaces -> stage tiering BEFORE bulk
addition. Stage tiering is not yet needed: verified count is 4 and daily
unlock-fact volume is ~0.3/day.

## 2026-08-28 — Zero-A/B diagnostic answered; cadence detection built; ENA promoted

**Three-way diagnostic (asked before widening the battery):**
1. Wrong chain? NO — 10 of 12 scanned were Ethereum-native ERC-20s (INJ correctly
   excluded as NON-NATIVE, AAVE failed resolution). The falsification line fired on a
   sample that DID test the claim.
2. D-by-nature? YES — every scanned token that has locked supply at all came back
   custody (EIGEN, ZRO, LINK, UNI, ENA: BitGo WalletSimple / GnosisSafe / EOA sets).
   Zero OZ-shaped vesting among large caps. D dominates by nature at this size.
3. Narrow battery? Untested for mid-caps, but irrelevant to the zero: the scanned
   set's locked supply was all custody. Battery widening DEFERRED, not refuted.

**Conclusion → built `detect-cadence.js`** (the bucket-D backtest as a discovery
method): family wallets from data/vesting-discovery.json → Blockscout outbound
transfers (date-span-driven pagination, >=14mo) → dominant-class cadence detection
(MONTH-END or FIXED-DAY, >=4 consecutive months, cv<1.0, off-schedule moves reported
not fatal) → data/cadence-report.json. Never promotes; a human confirms.

**Validation defects caught by the EIGEN gate (the tool's real curriculum):**
- Pagination is a failure mode, not a knob: 4 pages = 3 months of a batched emitter
  → INSUFFICIENT on the known metronome. Depth must be date-span-driven.
- Largest-per-month clustering broke on ONE off-schedule treasury move (Nov 19 8.53M
  outsized Nov 30) → dominant-CLASS detection; ad-hoc moves become an offSchedule
  honesty line.
- FIXED-DAY tolerance-center reported day "7" for a wallet that NEVER emitted on the
  7th (ENA: 6th, weekend→Monday) → modal observed day.

**Results:**
- EIGEN: reproduced hand-derived schedule AND resolved it finer — TWO metronomes,
  0x34BcF805 7.82M/mo + 0x3De6b6b1 1.69M/mo, both MONTH-END day 30 x11mo (≈9.6M
  family total, matching the manual sum). No Aug emission yet — Aug 30 watch stands.
- ZRO: 14-wallet family scan, NO cadence anywhere (most lockups dormant, actives
  irregular). Manual top-3 non-confirmation now confirmed at family scale. Caveat:
  Ethereum outflows only (ZRO is omnichain). Sep 20 demote trigger now the sole leg;
  cadence rescan is its on-chain arm.
- LINK: top custody wallets fully dormant (NO-OUTFLOWS). UNI: irregular (governance
  treasury, no metronome).
- **ENA: PROMOTED (5th verified token).** 0x54B8c65f06: 13 consecutive months,
  ~12.07M/mo, cv 0.26, day 6 with weekend→Monday roll (3/3 observed). Old estimated
  row said day 2 — behaviour says 6. Caveats in row note (busy ops wallet, 23
  off-schedule moves, largest holder irregular — metronomic tranche only). DEMOTE
  TRIGGER: no ~12M emission Sep 4–9 → rescan and demote.

**Verified:** EIGEN, STRK, ARB, ENA, ZRO. Suite ALL GREEN.
**Watches:** Aug 30 EIGEN (~9.5M, closes first calendar loop) · Sep 4–9 ENA demote
window · Sep 20 ZRO demote trigger · ARB/STRK T-7s ~Sep 8–9.
**Deferred with reasons:** battery widening (mid-caps only, after cadence method
proves out on watches) · OP/SUI/SEI cadence scans (non-Ethereum-native, need chain
support in outflow reader first).
**Operator action:** run PUSH-TO-GITHUB.bat (new tool + unlocks.json change; DR rule).
Bot hot-reloads unlocks.json within 1h — no restart needed for the ENA row.

## 2026-08-28 (later) — v0.25.0: the demote trigger runs itself; provenance class named

Reviewer: a prose demote-trigger is memory-dependent (the quarantine-lapse shape,
fourth recurrence prevented rather than fixed this time), and cadence provenance is
INDUCTIVE — a contract is a commitment, a metronome is a habit; they fail differently
and the message must say which one it rests on.

**Shipped (v0.25.0):**
- `src/sources/calendar/cadence-watch.js`: after each expected emission window
  (expectDay + weekend roll, or monthEnd clamp; grace 3d) closes, reads the custody
  wallet's actual outflows. Qualifying (>=50% of mean) -> CONFIRM stamped; empty ->
  row DEMOTED automatically + operator DM ("coverage change, not a market event").
  Demotions are an OVERLAY in data/cadence-watch.json — unlocks.json keeps its single
  human writer; re-promotion with newer evidence supersedes. Previous-month windows
  checked too (restart straddling a close must not skip it forever).
- Enforced BY SHAPE at both ends: promoteRow refuses onchain-cadence events without a
  machine-checkable `cadence` spec, and verifiedRowProblems re-asserts it at boot.
  Behavioural verification cannot exist without its automatic falsifier.
- Message provenance class: cadence-verified rows now say "schedule inferred from N
  months of observed emissions (behavioural, not contractually enforced; auto-demotes
  if the pattern breaks)" instead of letting "verified" imply contract grade.
- Heartbeat line `Cadence watch: ...` — the falsifier's own pulse (demoted rows 🚨,
  stale confirms ⚠️, per the lapse-indistinguishable-from-success rule).
- ENA re-promoted with the spec (wallet 0x54B8c65f0635... — first promotion carried a
  FABRICATED address tail, second time that defect appeared today; always copy
  addresses from the report, never from memory).

**Defect during bootstrap (fixture-pinned):** first pollCadence run FALSELY DEMOTED
ENA — a 3-page fetch of the busy ops wallet never reached the Aug window, and
truncated data was indistinguishable from an empty window. Fixed: date-span-driven
pagination + `windowObserved()` evidence gate ("we did not look" must never demote).
Same pagination lesson as detect-cadence.js, same day, different fetcher — page caps
on busy wallets are a defect class, not a tuning choice. Re-run: ENA Aug window
CONFIRMED (Aug 6, 13.32M). Suite: +19 fixtures (section 31), ALL GREEN. Version gate
caught the config/package drift on the bump (built for exactly that).

**First real windows:** ENA Sep 7 (6th is a Sunday), auto-checked ~Sep 11. EIGEN Aug 30
remains announcement-provenance — candidate for a cadence spec after the Aug 30
emission confirms (would give it the auto-falsifier too).
**Operator actions:** FORCE-RESTART (bot must load v0.25.0 for the watch to run) then
PUSH-TO-GITHUB.bat.

## 2026-08-28 (later still) — address provenance by construction; absence-class sweep; v0.25.0 LIVE

- `resolveWalletRef()` (unlock-promote.js): promotion wallet args are now REFERENCES
  resolved against addresses discovery/cadence tools actually wrote (103 currently).
  Prefix resolves if unique; ambiguity refuses; a fabricated address — including
  today's actual fabrication, now a fixture — cannot be promoted. EIP-55 rejected as
  the fix (lowercase fabrications pass checksum); provenance-by-construction is it.
- Named class: ABSENCE OF OBSERVATION ISN'T OBSERVATION OF ABSENCE (windowObserved()
  is the prototype). Swept the "nothing happened" signals:
  * unclassified/excluded zero lines now carry `feedWasLooking()` companions — zero
    with no live text feed says "not looking, not clean" instead of reading clean.
  * accumulator STALLED now distinguishes "rows flowing, recorder problem" from
    "zero rows 48h — check collectors, not accumulators".
  * already covered: collector pulse ages, backup NONE FOUND, digest pool line.
- Suite +12 fixtures (sections 32–33), ALL GREEN.
- FORCE-RESTART executed via Run dialog (history-click pattern; typing still blocked
  at click tier — dropdown + zoom-verify before OK). Log confirms: "Market Radar
  v0.25.0 starting", no boot refusals, cadence watch state intact (ENA Aug CONFIRM).
- Operator: PUSH-TO-GITHUB.bat still pending for today's work (v0.25.0 tag).

Next calendar points: EIGEN Aug 30 (~9.5M, first calendar-loop close; then consider
cadence spec for EIGEN too) · ENA window Sep 4–9, auto-checked ~Sep 11 · ZRO Sep 20.

## 2026-08-28 (final) — v0.25.1: enforcement decides the falsifier, not the label

Reviewer: EIGEN was the most-verified-sounding token with the least ongoing
falsification — 'announcement+onchain-backtest' verified the PAST; custody enforces
nothing forward. Rule generalized past the provenance string:

**Any schedule not contract-enforced carries an automatic falsifier** (boot-refused
otherwise, `forwardFalsifierProblems()`):
- cadence spec — where emissions are observable (reviewBy is refused as a downgrade
  on cadence-discovered rows);
- reviewBy dead-man's switch — where they are not: past the date without deliberate
  re-promotion, the row demotes via the overlay + operator DM. No network needed —
  the calendar is the evidence.
- enforcement:'contract' may be declared only for genuinely on-chain-enforced rows
  (none currently qualify — we have read no vesting contract end-to-end).

**Rows updated (all via promote-unlock.js; addEvent/keepEvents added for attaching
falsifiers without fabricating provenance):**
- EIGEN: cadence spec (0x34BcF805A503..., monthEnd day 30, mean 7.82M, 11mo; wallet
  resolved from report by prefix — resolver's first production use). onchain-cadence
  event PREPENDED, announcement event retained as history. The Aug 30 emission is now
  the first LIVE auto-check (window Aug 29–Sep 2, evaluated ~Sep 3).
- ZRO: reviewBy 2026-09-22 — the Sep 20 prose trigger is now structural. No cadence
  spec on purpose: omnichain, no Ethereum emission path; a spec would false-demote
  by construction.
- ARB / STRK: reviewBy 2026-11-30 (announcement path, enforcement unverified by us;
  quarterly re-attestation or self-demotion).

Suite: +12 fixtures (section 34) incl. live-file assertion; two section-28 fixtures
updated to the new constructibility rule. ALL GREEN. v0.25.1 restarted via Run dialog
(pre-filled from last use, zoom-verified), boot clean.

**Standing:** verified = EIGEN·STRK·ARB·ENA·ZRO — every one now carries a live
falsifier. Watches: EIGEN Aug 30 (auto ~Sep 3) · ENA Sep 4–9 (auto ~Sep 11) · ZRO
Sep 22 dead-man · ARB/STRK T-7s ~Sep 8–9, reviewBy Nov 30.
**Operator:** PUSH-TO-GITHUB.bat (v0.25.1 tag) covers today's three sessions.

## 2026-08-28 (v0.25.2) — the dead-man's switch warns before it bites
Reviewer: a switch that fires without warning makes demotion a discovery, not a
decision (restore-drill shape). cadenceStatus reviewBy rows now show days remaining,
⚠️ at T-14, 🚨 at T-3. +4 fixtures, 251 PASS. Restarted; v0.25.2 live — warning path
active well before ZRO's T-14 (Sep 8). PUSH-TO-GITHUB.bat still pending (one tag,
whole day).

## 2026-08-29 — BULK SCAN PRE-REGISTRATION (written before the scan ran)

UNIVERSE RULE (recorded, deterministic): base symbols (quote suffix stripped)
with >=3 unsuppressed gate-passing outcome rows, taxonomy EXCLUDE dropped (4
leveraged), minus already-scanned (12) and unlocks.json rows = QUEUE 156
(data/scan-queue.json). The historical "135" was an Aug 21 count; corpus grew.
Queue visibly contains memecoins, majors (BTC/ETH/SOL), and xStock bases —
resolution is expected to shed those, and their verdicts are triage noise,
not signal.

PREDICTIONS + FALSIFICATION LINES:
 1. RESOLUTION: 55–85 of 156 resolve to a canonical Ethereum ERC-20 via the
    CoinGecko top-mcap rule. <40 ⇒ the resolution layer itself is broken/too
    strict — diagnose resolution before concluding anything about vesting.
 2. LOCKED SUPPLY: 20–40% of resolved tokens show a non-skip contract holding
    >=0.3% supply. <10% ⇒ discovery mis-tuned for mid-caps (NOT "ecosystem
    unreadable"); >60% ⇒ classifier matching non-vesting contracts.
 3. CADENCE: 15–40% of locked-supply tokens yield a detectable consecutive-
    month cadence. If DeFi-infra cadence yield is near ZERO ⇒ the detector is
    narrower than EIGEN/ENA suggested (brief's line, adopted).
 4. PROMOTIONS this session: 3–8.
 5. CHAIN SPLIT (brief's priors, adopted to beat or falsify): DeFi-infra good
    yield (ERC-20, Ethereum custody) · L2 ~half reachable · L1 near-zero
    (native-chain vesting, Ethereum tooling structurally blind — ONDO finding
    generalised). L1 yield materially >0 ⇒ chain assumption WRONG — stop and
    understand before trusting any L1 result.

## 2026-08-29 — BULK SCAN RESULTS: 156/156 scanned, ZERO promotions, 3 of 5
## falsification lines fired. The measurement is the deliverable.

SCAN COMPLETE: 156 queued, 156 done, 0 outstanding errors. Two passes
(bulk-scan.js discovery → cadence-pass.js) both checkpointed per token.

PRE-REGISTERED vs ACTUAL — honoured, not rationalised:
 1. RESOLUTION 55–85 predicted → **39**. Below the <40 line ⇒ the line's own
    instruction is to DIAGNOSE RESOLUTION before concluding anything about
    vesting. Diagnosis: the resolver is NOT broken — 63 UNRESOLVED-LOWCAP are
    genuine sub-top-2000 microcaps, and 54 NON-NATIVE are correctly classified
    (BSC 20, own-chain 15, Solana 6, **Robinhood 5 = xStock equities**, Base 4).
    The low count is QUEUE COMPOSITION, not resolver failure. THE REAL FINDING:
    the gate-passing universe is dominated by MEXC-listed microcaps and
    tokenised equities — it is NOT the universe where unlock alerts matter.
    Selecting the scan queue from gate-passers was itself the mis-step.
 2. LOCKED SUPPLY 20–40% predicted → **97% (38/39)**. Above the >60% line ⇒
    "classifier matching non-vesting contracts", and that reading is correct:
    GROVE 94.3%, CAP 93.1%, RIF 90% held is UNDISTRIBUTED TREASURY on a
    microcap, not vesting. The 0.3%-threshold + skip-classes do not separate
    "contract holds supply" from "contract vests supply" at the low end.
 3. CADENCE 15–40% of locked → **0 of 30**. Families: INSUFFICIENT 15,
    NO-OUTFLOWS 8, IRREGULAR 7. Combined with #2 the honest reading is NOT
    "detector too narrow" alone — most of this population never had a vesting
    schedule to detect.
 4. PROMOTIONS 3–8 predicted → **0**. Stated plainly.
 5. CHAIN SPLIT: L1 near-zero CONFIRMED. **DeFi-infra "good yield" FALSIFIED**
    — BAL, LRC, DODO, OGN, SKL, SPELL, EUL, GTC, SYN all tested, zero cadence.
    The cadence method works on large-cap professionally-custodied treasuries
    (EIGEN, ENA) and does not generalise downward.

NOTABLE FINDS (logged, not chased — coverage-session rule):
 - **WLD is the only A-READABLE**: three sequential OZ VestingWallets
   (2026-07-24→2029, 2029→2032, 2032→2038, 1096d each, same GnosisSafe
   beneficiary), 72.5% of supply, genuinely CONTRACT-ENFORCED — the first row
   that could ever claim enforcement:'contract'. NOT PROMOTED, and the reason
   is an inversion worth keeping: **OZ VestingWallet releases CONTINUOUSLY,
   so there is no dated event to alert on.** Zero release calls to date. For a
   date-alerting system, bucket A is WORSE than bucket D: custody batches
   produce dated events, contracts produce a smooth curve. "A-READABLE is the
   gold standard" was backwards for this use case.
 - B-STREAM x2: GTC (Hedgeys), TREE (Sablier V2 Lockup Dynamic) — the first
   live stream contracts the battery has seen; both sub-1% of supply.
 - Tool defects fixed as BLOCKERS only: unguarded CLI IIFEs (importing either
   tool ran its CLI), no fetch timeout (one stalled connection ate a whole
   slice), no per-token deadline (a monster family livelocked the pass),
   FETCH-FAILED frozen into the checkpoint as if settled (retryable ≠ done).
 - Logged NOT fixed: 0.3% threshold does not distinguish treasury from
   vesting; Blockscout ~7s/page under load makes truncation a real
   false-negative risk on busy wallets; taxonomy passes xStock BASES
   (SAMSUNG, SONY, BRKB, EBAY, GEV) that the equity classifier catches only
   in announcement text.

PART 5 — L1 DECISION (recorded, not drifted past): **(a) + (c)**.
 (a) ACCEPT that unlock coverage is an Ethereum/EVM feature — now stated in
     the module's own coverage line, so absence never reads as "no unlocks".
 (c) ANNOUNCEMENT PATH for individually high-pressure L1s only, manual, with
     reviewBy switches (the STRK pattern, already proven).
 (b) per-chain readers REJECTED for now: this scan found no evidence the L1
     pile contains alertable schedules we would otherwise miss — 15 own-chain
     symbols are mostly microcaps. Revisit only if a top-20 L1 by pressure
     needs it.

STAGE TIERING LIVE (before any bulk promotion, as ordered): STAGES
FULL[14,3,0,-3] / STANDARD[3,0] / LOGGED[]. Assigned: EIGEN+ENA FULL
(cadence-verified, largest observed emissions), ARB/STRK/ZRO STANDARD.
**Deliberate behaviour change**: the old fixed [7,3] is gone — STANDARD rows
lose T-7 and gain T-0; FULL rows get T-14/T-3/T-0/T+3. T+3 required a new
backward-looking date helper (lastMonthlyDate) — negative leads were
structurally dead code as first wired, caught by fixture, never shipped.
Bands PROVISIONAL until ADV matures (~Sep 7).

NEXT SESSION'S DECISION IS NOW DATA-BACKED: do NOT widen the selector battery
for this universe (the population lacks schedules, not readability). The
higher-yield question is whether to scan a DIFFERENT universe — top-200 by
mcap rather than gate-passers — where professional custody vesting actually
lives, i.e. the EIGEN/ENA/ZRO/LINK/UNI population the first 12-token pass
already sampled at 5/5 custody.

## 2026-08-29 (post-scan) — two corrections the scan forces

**1. THE BUCKET PRIORITY IN REMAINING-WORK.md WAS WRONG — CORRECTED IN PLACE.**
That document ranked A (OZ VestingWallet) as the clean prize and D
(multisig/custody) as "NOTHING TO READ". The scan refutes it structurally:
bucket A releases CONTINUOUSLY, so it emits no dated event; WLD's three
contract-enforced VestingWallets have made zero release calls. Bucket D
batches monthly, and a batch IS the event — all five verified rows are D.
For a date-alerting system D > A. Taxonomy kept, implied priority discarded.
A dated ⛔ correction block now sits above the ordering so a future session
cannot follow the dead plan (expired-filter class: the justification died
while the document still read as authoritative — third instance in this
project, and the first one caught in a PROMPT rather than in code).

**2. CANDIDATE PROVENANCE ≠ DATE PROVENANCE — the rule I over-generalised.**
"Aggregator dates never qualify as verified" is about the provenance of the
DATE. I generalised it to "no aggregators at all", and that is what aimed
this scan at the wrong universe: 156 gate-passers, mostly MEXC microcaps and
tokenised equities, 0 promotions. The gate never selected for schedules —
the original 12 were tokens ALREADY KNOWN to have schedules that also passed
the gate. Prior knowledge was doing the selecting all along.
  ILLEGITIMATE: shipping an aggregator's date as verified. Unchanged.
  LEGITIMATE:   using an aggregator's list of tokens-with-upcoming-unlocks
                as a CANDIDATE INDEX — where to point discovery. Dates still
                established independently (contract read / observed cadence /
                project announcement), and every row still needs a forward
                falsifier. Discipline intact; population problem solved.

**NEXT SESSION'S QUEUE (decided, not deferred):** rebuild scan-queue.json from
a candidate index of tokens with KNOWN upcoming unlocks (CryptoRank's free
unlock calendar list = names only, never dates; CRYPTORANK_API_KEY already in
.env), intersected with nothing — the gate is not a filter for this purpose.
Fall back to top-200-by-mcap if the list is paywalled. Then: discover →
cadence → promote with falsifier + stage. Expect a materially higher hit rate
than 0/30 because the population is selected for having something to find;
pre-register that expectation with a falsification line before running.
Do NOT widen the selector battery — this scan showed the limit was population,
not readability.

## 2026-08-29 (v0.26.1) — PREMISE headers: the countermeasure for "documents get obeyed"

Reviewer: the doc set is now large enough that expired premises are a standing
hazard, and the countermeasure is the rule already applied to code — record WHY
next to WHAT. Every .md now opens with a machine-checked PREMISE block:
version-written-against, review date, and the assumptions it depends on.
Fixture 36 auto-discovers *.md (never a hardcoded list — that is the
CRYPTO_EXCEPTIONS defect, and the point is a NEW document is covered the moment
it exists) and asserts: block present · version parses · at least one non-empty
assumption. Both guards carry self-tests proving they can fail.

Honest correction to the brief: UNLOCK-EXPANSION.md and FACTS-ENGINE-ROADMAP.md
do not exist as files — they were session briefs pasted into chat, so their
premises were never on disk to expire. The real doc set is five files, now all
headed. This is itself the argument for the mechanism: a plan that lives only in
a chat transcript cannot be audited at all.

Header verdicts recorded: NEXT-SESSION.md marked mostly EXECUTED/SUPERSEDED (its
section 5, the bucket-D announcement path, survives and was vindicated);
REMAINING-WORK.md carries the corrected bucket priority and the candidate-index
rule; VPS-MIGRATION.md unchanged in substance (still valid, migration on/after
31 Aug); NOTES marked append-only, read bottom-up for current state.

## 2026-08-29 (final) — Part 0 corrected in place; brief files not reachable

**Part 0 fixed, not flagged.** Reviewer's argument accepted: a KNOWN-STALE marker
depends on the reading session noticing it, and Part 0 is the one block pasted
VERBATIM into every session — precisely where a warning gets skimmed. Corrected:
"Alpha Radar at v0.16.3" -> "Market Radar at v0.26.1"; "Storage is node:sqlite /
%LOCALAPPDATA%\alpha-radar / VACUUM INTO" -> JSON files under data/, whole-file
daily snapshots to data/backups/, restore-verified by restore-drill.js, with an
explicit "the sqlite migration was planned and never done — do not migrate a
database that does not exist" (the exact failure mode the reviewer predicted: a
future session helpfully migrating a nonexistent DB). Also pointed the reading
instruction at files that exist (REMAINING-WORK-NOTES.md bottom-up,
test-delivery.js) instead of regression-fixtures.js. Part 0's remaining v0.17-era
figures are now labelled SNAPSHOTS. Larger rewrite still deferred.
RULE: known-false facts in the most-pasted document get FIXED, not marked.

**Brief files: NOT REACHABLE from this session, so not copied.** Searched the
mounted outputs folder (holds only a 2 Jul market-radar snapshot), the Desktop,
and uploads: none of UNLOCK-EXPANSION.md, FACTS-ENGINE-ROADMAP.md,
FIX-SYMBOL-CLASSIFIER.md, FACTS-AND-CALLS.md, SHIP-v0.20.0.md are present. Each
session mounts only its OWN outputs directory; earlier sessions' folders are
outside the connected paths and the file tools refuse them by design.
OPERATOR ACTION (worth doing — these shaped shipped architecture): copy the
worth-keeping briefs from the Cowork outputs folders into the repo, e.g. a
docs/briefs/ subdir. They inherit fixture 36 automatically, so each will need a
PREMISE header (version written against + assumptions) or the suite fails —
which is the intended forcing function: importing a document means stating what
it assumed. Spent ones can be let go.

## 2026-08-29 (v0.26.3) — brief import staged; fixture 36 scope corrected

**MY OWN CLAIM WAS WRONG AND THE FIX IS SHIPPED.** I told the operator imported
briefs would "inherit fixture 36 automatically". They would not have: the check
read `readdirSync('.')` — TOP LEVEL ONLY — so anything in docs/briefs/ would have
escaped it silently. A guard whose coverage is narrower than its advertised scope
is worse than none, because the advertisement is what gets trusted. Now a
recursive walk (skipping node_modules/.git/data/fixtures/backups).

The wider walk immediately caught a real omission: `src/sources/cex/README.md`,
undiscovered by the top-level check, described the PUMP detector as if live. It
is LADDER-RETIRED (22 of 30 PUMP-HIGH reverted in 24h, n=30). Now headed with
that status — a module doc that reads as live behaviour for retired machinery is
the documents-get-obeyed problem in miniature.

**docs/briefs/ created and staged.** The brief files still are NOT reachable from
this session (uploads empty; each session mounts only its own outputs). So
docs/briefs/README.md now carries the OPERATOR IMPORT STEP plus the exact PREMISE
header to paste on each of the eight briefs, written from the operator's own
status table — which is the part a future session could not reconstruct:
  FACTS-AND-CALLS.md         v0.22.x  EXECUTED, STILL GOVERNING (import first)
  FACTS-ENGINE-ROADMAP.md    v0.24.3  PARTLY STALE (import second — holds the
                                      current priority ordering; its step-10
                                      plan superseded by the bulk scan)
  ALPHA_RADAR_BUILD_SPEC.md  pre-0.11 HISTORICAL (§11 superseded; §8 anti-pattern
                                      list is why it is worth keeping)
  FIX-SYMBOL-CLASSIFIER.md   v0.23.3  EXECUTED as v0.23.4 (its ticker-list
                                      assumption was incomplete — GMX)
  UNLOCK-EXPANSION.md        v0.24.5  PARTLY REFUTED (bucket A/B priority)
  UNLOCK-BULK-SCAN.md        v0.25.2  EXECUTED (priors beaten three ways)
  FIX-DELIVERY-AND-TIERING /
  SHIP-v0.20.0.md            v0.19.3  EXECUTED, SPENT
Vocabulary fixed so status means the same thing across the set. Standing rule
written into that README: **briefs are historical record, never instructions** —
Executed describes what was done, Refuted is kept so the refutation stays
traceable, and neither is a plan. Plans live in REMAINING-WORK.md.

## 2026-08-29 (v0.26.4) — brief STATUS taxonomy corrected: DESCRIPTIVE is its own kind

My "briefs are historical record, never instructions" rule was wrong in a way that
would have destroyed the most valuable document in the set. FACTS-AND-CALLS.md is
not history — it is a still-accurate DESCRIPTION of the live architecture, and the
only place explaining WHY the dispatcher is shaped as it is (facts carry no
conviction; catalysts never defer). A future session obeying "historical, do not
follow" would have discarded the rationale for the code it was editing.

Four statuses now, and the distinction is load-bearing:
  DESCRIPTIVE  accurate account of the LIVE system — FACTS-AND-CALLS.md alone.
               If it ever stops matching the code, one of the two is wrong and
               that is worth discovering (it is a de facto invariant, not prose).
  ACTIVE PLAN  still directs work — FACTS-ENGINE-ROADMAP.md (Sessions B and D
               queued). Becomes EXECUTED when they run.
  REFUTED      kept so the refutation stays traceable — UNLOCK-EXPANSION.md.
  EXECUTED     done and spent — SHIP-v0.20.0, FIX-DELIVERY-AND-TIERING,
               UNLOCK-BULK-SCAN, FIX-SYMBOL-CLASSIFIER.
ALPHA_RADAR_BUILD_SPEC.md carries a PER-SECTION status (§11 superseded as a plan,
§8 anti-patterns still descriptive) — one verdict per file was itself too coarse.
Status is restated ON IMPORT, never from memory, because category changes.

GENERALISABLE: "is this document still true?" and "should this document still be
obeyed?" are DIFFERENT questions. A doc can be accurate and not a plan
(descriptive), or a plan and no longer accurate (refuted). Collapsing them into
one axis is what made the blanket rule wrong.

TRANSFER STILL BLOCKED: the brief files remain unreachable from the agent session
(uploads empty across four checks; chat-card downloads land in the operator's
folder, not the sandbox mount). Headers are staged in docs/briefs/README.md and
apply unchanged whenever the copy happens.

## 2026-08-29 (v0.26.5) — DESCRIPTIVE gets a testable definition: cite a fixture per claim

"A descriptive document is closer to an invariant than to prose" — invariants can
be tested, so DESCRIPTIVE now MEANS: every claim names the fixture that fails if
code and document diverge. Not "accurate today" — checked.

Shipped: docs/briefs/CLAIMS-FACTS-AND-CALLS.md (12 claims of the FACT/CALL
architecture, each carrying `[fixture: <exact suite section title>]`), plus
fixture 37 which enforces the bar on ANY doc whose PREMISE says DESCRIPTIVE:
  - a "## Claims" section must exist;
  - every claim line carries a citation or an explicit [UNENFORCED: reason];
  - EVERY CITED SECTION TITLE MUST REALLY EXIST in test-delivery.js — a renamed
    or fabricated fixture leaves a dangling reference that still READS as proof,
    which is the safeguard-whose-lapse-looks-like-success shape again;
  - at least one UNENFORCED claim is expected, not penalised.
Both guards self-test.

**Writing the citations found a real hole, which is the point of the exercise.**
Eleven of twelve claims cite live fixtures. One does not:
  "Multipliers and the ladder apply to CALLS only; the ladder never gates a fact."
No fixture asserts that NEGATIVE. The fact path returns before ladder evaluation,
so it holds BY CONSTRUCTION today — but a refactor could route a fact through
evaluateLadder() and nothing would object. Marked [UNENFORCED] with exactly that
reasoning rather than quietly cited to a nearby-looking test. This is the
distinction the mechanism exists to expose: "we believe this" vs "we check this".
NEXT: write that assertion (a fact whose type is ladder-DISABLED must still admit
and push) and convert the marker to a citation.

GENERALISABLE: a doc claim is either backed by a test or it is a promise nothing
keeps. Any document asserting how the system behaves can be held to this bar; the
ones that cannot meet it are not descriptive, only accurate so far.

UPDATE (same session): the UNENFORCED claim is now ENFORCED. Fixture 38 asserts
the negative directly — LISTING/FUNDING/UNLOCK facts admit and carry no
tier/score with `withLadder({...ALL DISABLED})` injected — plus a CONTROL that
the SAME disabled ladder still suppresses a PUMP call. Without the control the
fixture could have passed because the injection never took effect, which is the
"asserts environment while appearing to assert logic" class. 14 claims now: 13
cited, 1 newly-declared UNENFORCED (per-fact delivery accounting — fixture 1
covers the broadcast layer, but nothing asserts messageCounts() cannot over-count
a partially-delivered batch). The mechanism keeps producing work, which is the
correct behaviour for it.

## 2026-08-31 — EIGEN's 11th landed; falsifier widened to match the CLAIM (v0.27.0)

**THE LOOP CLOSED.** Aug 30 emission: 0x34BcF805 7,920,090 (spec mean 7,822,556 —
within 1.3%) + 0x3De6b6b1 1,364,336 = **9,284,426 family**. Eleventh consecutive
month-end. The watch correctly reads PENDING today (window Aug 29–Sep 2; "we did
not look yet" is not a verdict) and CONFIRMs on a Sep 3 clock — verified by
dry-running the pure decision against real data, which writes nothing.

**GAP FOUND BY THE NUMBERS, NOT BY A FAILURE.** The spec watched ONE wallet while
the message claimed the FAMILY figure (~9.6M). Per-wallet 50%-of-mean cannot see
a 15% family shortfall: if 0x3De6b6b1 stopped entirely, the primary would still
clear its bar, the row would stay verified, and the alert would keep asserting a
number nothing checks. Chose to WIDEN THE SPEC rather than narrow the message —
narrowing to 7.9M would understate the supply actually hitting the market, which
is its own accuracy failure.

Family specs (`cadence.wallets[{addr, meanAmount}]`, `familyMean`, `tolerance`):
  CONFIRM  every wallet emits >=50% of its own mean AND family total within ±25%
  PARTIAL  some wallet silent, OR all emit but the family total falls below the
           band — demotes, because the claim just went unverified even though the
           schedule did not stop. Distinct message and reason from DEMOTE.
  DEMOTE   nobody emitted.
Any uncovered fetch aborts the whole family decision — a partial VIEW of a family
would read as a silent WALLET (the windowObserved class, applied at family scale).
Single-wallet specs still validate: the shape is right when the claim is
single-wallet too.

EIGEN re-promoted with both metronomes (familyMean 9,515,075, tolerance 0.25,
stage FULL); note now states exactly what is checked and why.

Fixture 39 (13 checks) pins it, including the load-bearing one:
**"the OLD single-wallet spec would have missed it"** — same silent-wallet data,
old spec returns CONFIRM. The regression is demonstrated, not asserted.

Also fixed: fixture 34 asserted `cadence.wallet` specifically and failed the
moment EIGEN widened — a test pinning an implementation detail blocked the
improvement it was meant to guard. Now shape-agnostic.

GENERALISABLE: **a falsifier must cover the claim the MESSAGE makes, not the
claim that was convenient to check.** Verifying a component while asserting an
aggregate is a gap that stays invisible while the component behaves.

VPS window is OPEN (calendar loop closed cleanly; migration was gated on "on or
after the 31st"). Steps 1-4 operator-side, stop at 5 and paste drill output.

## 2026-08-31 (v0.27.1) — CLAIM-COVERAGE SWEEP: all five rows, claim vs falsifier

EIGEN's gap was found by ACCIDENT (both numbers happened to sit in one report), so
the class got swept deliberately. DATE, AMOUNT, CADENCE and SCOPE are four separate
claims; a falsifier usually covers one.

  ROW    DATE        AMOUNT             SCOPE          FALSIFIER
  EIGEN  observed    observed           family         cadence family x2, ±25% band
  ENA    observed    observed-PARTIAL   tranche        cadence, one wallet
  ARB    announced   UNCHECKED          announcement   reviewBy 2026-11-30
  STRK   announced   UNCHECKED          announcement   reviewBy 2026-11-30
  ZRO    announced   UNCHECKED          announcement   reviewBy 2026-09-22

**ENA — measured, and it is NOT EIGEN's bug but it is EIGEN's shape.** The watched
metronome 0x54B8 holds 71.6M; holder 0x2146 holds 1.185B and, checked today, ALSO
emits on the 6th (2,909,505 on 2026-08-06) — irregularly. So the true monthly
distribution EXCEEDS the 12.07M the row cites. ENA's note already scoped to "the
metronomic tranche", so the message was not lying — but the scoping lived in prose
that could drift. DECISION: do NOT fold 0x2146 into a family spec — an irregular
emitter inside a family band would false-demote the row every quiet month. Instead
the row now says the figure is A FLOOR, NOT A TOTAL, and that other holders emit
uncovered. Recorded in the row note with the measurement and the date.

**ARB / STRK / ZRO — reviewBy falsifies the DATE'S FRESHNESS, never the amount.**
92.65M ARB and 127M STRK are announcement-stated and nothing on-chain checks them.
Accepted as a DECISION rather than left as an oversight (per the brief): these are
announcement-path rows on chains we cannot read, so amount verification is not
available at $0. The message now SAYS SO: "The AMOUNT is announcement-stated —
nothing observes it on-chain."

MECHANISM: claimCoverage(row) in unlocks.js, DERIVED FROM ROW SHAPE (a stored
coverage field would drift from the spec it describes — the same defect one level
up). Its line is rendered into every unlock message, so the disclosure reaches the
channel and not just the audit. Fixture 40 (10 checks) asserts every live verified
row states date AND amount coverage, and that any row whose amount is unchecked
says so explicitly.

GENERALISABLE (now the standing rule): **every claim in a message needs a falsifier
that covers it, or an explicit note that it does not.** Silence about coverage
reads as coverage.

FIXTURE-DESIGN LESSON (recorded separately because it will recur): fixture 34
asserted `cadence.wallet` — the SHAPE that happened to satisfy the invariant — and
so failed the moment EIGEN widened to a family spec, i.e. the test obstructed the
improvement it existed to protect. ASSERT THE INVARIANT ("this row has a forward
falsifier"), NOT THE SHAPE CURRENTLY SATISFYING IT.
