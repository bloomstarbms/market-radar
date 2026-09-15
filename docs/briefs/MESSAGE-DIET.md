<!-- PREMISE
Written against: v0.31.7 live (demoteScope still parked — see PENDING-v0.31.7-demote-scope.pending, unnumbered until it ships)
Reviewed: 2026-09-13
Assumes:
- FACT/CALL split is live; telemetry is already DM-only as of v0.31.0.
- The prose lint (fixture 30) enforces no-direction / no-unsupported-statistics and
  is NOT relaxed by this work.
- claimCoverage(row) is derived from row shape, not stored — so a rendering change
  cannot silently alter what a row claims.
- Nothing here changes what fires, any threshold, any provenance tier, or any
  falsifier. Rendering only.
STATUS: ACTIVE PLAN — not started.
QUEUE POSITION: AFTER the correctness queue. In order: suite → detect-cadence ENA →
routes.js gate-input fix → loadWatchState quarantine + historyResetAt → determinism
fixture → cliff cache staleness → annotate-verdict write path → void exclusion →
rescore. Those produce WRONG VERDICTS today; this produces verbose ones.
UNBLOCKED 2026-09-13: the correctness queue items 0-7 are DONE and shipped as
v0.31.7. Items 8-10 remain and still precede this work. The prerequisite named at the
foot of this file — a field inventory of the current message builders — now exists as
docs/briefs/MESSAGE-FIELD-INVENTORY.md.
-->

# Message diet — two renderings, one row

Operator ask: *"some english is not necessary — just state what's happening and let
every trader decide."*

## Diagnosis

Three layers accumulated for good individual reasons and now bury the numbers.

**1. The same disclaimer three times per message.**

```
[🔓 TOKEN UNLOCK] 📅 UNLOCK LISTED · KAITO — cliff in 7 days
fact · no directional call                        <- header
• fact · per DefiLlama's schedule — NOT verified   <- bullet 1
• Fact only — no directional call.                 <- closing bullet
```

**2. Architecture talking to itself in public.** "bucket C not enumerated by us",
"cadence spec would false-demote by construction", "STRUCTURAL TRIGGER (was prose)",
"Falsifier strength: none (dead-man switch tests freshness, not the claim)". Each is
a real distinction. None is information a reader acts on.

**3. Epistemics as prose.** "what happens next is not something this system has
earned an opinion about". The absence of a call *is* the statement; explaining the
absence restates it.

Roughly 60% of each message is about the message.

## The decision

`renderFact(row, audience)` where `audience ∈ {'public', 'operator'}`.

- **PUBLIC** — the fact, the numbers, and the minimum provenance needed to weigh it:
  where the date came from, whether it is verified, how old the source is.
- **OPERATOR** — the same, plus provenance internals: bucket, falsifier strength and
  chance rate, scope statement, reviewBy mechanics, full claim-coverage.

One row, one set of facts, two levels of detail. **Nothing is deleted from the
system; it is deleted from the channel.** v0.31.0 moved whole message *types* to the
DM; this moves *fields* within a type.

## Part 1 — disclaimer to the channel bio

Delete per-message: the `fact · no directional call` header, the closing
`Fact only — no directional call.` bullet, and the `fact · per <source>'s schedule —`
prefix (its NOT-verified meaning moves to the provenance line in Part 3).

Channel description, set once by hand:

> Scheduled and observed crypto events. Facts only — no trade calls. Every date
> states its source.

A property of the feed does not belong in each element of the feed.

**The prose lint is unchanged.** The rule was never "say you make no call", it was
"make no call". Add a fixture asserting the new templates contain no direction
words, so the diet cannot smuggle one back in.

## Part 2 — field budget

Public messages: **hard cap 6 lines after the title**, ≤ 420 characters. A seventh
line means something is prose. Fixture renders every template with representative
data and asserts both. A cap that is not enforced is a preference.

## Part 3 — templates

```
SOURCED UNLOCK
  📅 UNLOCK · KAITO — 19 Sep (7d)
  17,597,619 KAITO · 1.76% of max supply
  46% already unlocked · cliff
  noncirculating / insiders / privateSale
  Base · DefiLlama, unverified (5d old)
  [chart]

VERIFIED UNLOCK — announcement
  🔓 UNLOCK · ARB — 16 Sep (3d)
  92.65M monthly · team + investor vesting
  Project-announced · amount not observed on-chain
  [chart]

VERIFIED UNLOCK — cadence
  🔓 UNLOCK · EIGEN — 30 Sep (7d)
  ~9.6M monthly · custody distribution, 2 wallets
  Verified on-chain · 11 consecutive months
  [chart]

FUNDING
  ⚡ FUNDING · MTLUSDT  −0.551%/8h
  −603% annualised · shorts paying longs
  99th pctile of its own 90d · just entered
  Moved −0.212% since last check
  59% long / 41% short · mark $0.3133
  Executable ~$922 @50bps · spread 30.7bps
  [chart]

LISTING
  🆕 LISTING · BATONUSDT on MEXC
  $0.010949 · Vol24h $2,658
  Executable ~$1 @50bps · spread 96.4bps
  [chart]
```

`chain unconfirmed` still renders where no on-chain read was attempted — dropping it
would hide a real gap. Second-source state collapses to one of: `DefiLlama only` ·
`DefiLlama + CryptoRank agree` · `sources disagree: DefiLlama 29 Sep, CryptoRank
1 Oct`. The paid-tier explanation goes to the operator rendering.

`11 consecutive months` stays: it is a measured fact about the schedule and it is
what separates this row from a listed one. Chance rate, binomial tail and the
falsifier-strength label move to operator.

Delistings and suspensions get the same treatment — keep date, venues, asset, and
whether a resumption time was stated; drop the reasoning about why they matter.

## Part 4 — what must survive

Claim-coverage obligations, not prose. Non-negotiable in the public rendering:

- VERIFIED vs LISTED unmissable at a glance (🔓 vs 📅)
- the source name, when the date is not independently verified
- source age, when a staleness rule can silence the row
- "amount not observed on-chain", where the amount is only announced
- "chain unconfirmed", where no on-chain read was attempted
- executable size, where computed

**Silence about coverage reads as coverage.** Shortening a message must not convert a
hedged claim into a bare one. Fixture: per template, assert the required coverage
element is present for the row shapes that demand it — a sourced row without its
source name fails; an announcement-amount row without the caveat fails.

## Part 5 — operator rendering

Everything cut from public goes here unchanged in substance: bucket classification,
falsifier strength / chance rate / replay series / binomial tail, demote scope,
reviewBy mechanics, full claimCoverage, second-source detail including the paid-tier
note.

**Fixture asserts no field present in the current v0.31.6 message is absent from
BOTH renderings.** That is the difference between a diet and an amputation, and it
is the reason the cut is safe: the verbosity grew because each addition was
individually correct — the scope statement, the coverage line, the source caveat all
exist because something went wrong without them. Cutting them from the channel is
right; cutting them from the system would re-open cases that took weeks to close.
The field-preservation fixture makes that structural rather than a promise.

## Acceptance

- Replay the 13 Sep messages through both renderings: public ≤ 6 lines and ~60%
  shorter; operator a superset of today's.
- Field-preservation fixture green (Part 5).
- Coverage-obligation fixture green (Part 4).
- Prose lint green on every new template, plus the new no-direction-words assertion.
- Line/char cap fixture green.
- Channel description updated once, manually.

## Non-goals

Changing what fires. Changing thresholds. Touching provenance tiers or falsifiers.
If a row's behaviour changes, the change is out of scope.

## Prerequisite noted at write time

Part 5's fixture needs an inventory of every field the current messages emit, or
"nothing was lost" cannot be asserted — only hoped. Build that inventory from the
message builders BEFORE writing either rendering, and treat it as the fixture's
frozen input.
