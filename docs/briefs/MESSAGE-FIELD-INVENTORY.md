<!-- PREMISE
Written against: v0.31.7 live
Reviewed: 2026-09-13
Assumes:
- Built by READING the message builders, not by running them — the workspace has no
  shell (Windows update of 2026-09-08). Every field below is cited to file:line so it
  can be re-checked mechanically.
- Covers the four public FACT types the message diet re-renders (sourced unlock,
  verified unlock, contract-cliff unlock, and the formatAlert wrapper all of them
  pass through). CEX types (funding, listing, suspension) are NOT yet inventoried —
  marked TODO at the end.
Status: DESCRIPTIVE — an inventory of what exists today, not a plan.
  NOTE: written first as "STATUS:" (all caps), which fixture 37 does NOT match
  (/Status:\s*DESCRIPTIVE/ is case-sensitive). That would have exempted this file
  from the cite-a-fixture-per-claim rule by a case mismatch rather than by decision.
  Corrected to the convention, and the Claims section added, because dodging a check
  through a typo is worse than failing it.
PURPOSE: the frozen input for MESSAGE-DIET.md Part 5's field-preservation fixture.
Without this, "nothing was lost in the move" is a hope; with it, it is an assertion.
-->

# Message field inventory — what v0.31.6 emits today

## Claims

- `claimCoverage` is DERIVED from row shape, not stored, so a rendering change cannot alter what a row claims [fixture: 40. claim coverage is stated per row (date/amount/scope, not just date)]
- A sourced row states its source by name and its source age, and goes silent rather than pushing a stale date [fixture: 45. SOURCED tier — a named source pushes, labelled; its falsifier is the source]
- A contract-cliff row states that its enforcement was earned by replayed clusters, not declared [fixture: 46. CONTRACT-CLIFF tier (Route 2) — enforcement:contract is EARNED by replayed claim clusters]
- Every verified row carries a derived falsifier strength, and a WEAK one says so in the message [fixture: 49. FALSIFIER STRENGTH is derived on EVERY verified row (chance rate → replay), not just the suspicious one]
- No message makes a directional claim or an unsupported frequency claim [fixture: 30. message prose is linted — direction ban + unsupported-statistics ban]
- The field tables in sections A–D below list every field the four public FACT builders emitted as of v0.31.6, and every ID has a destination that a rendering exhibits or a declared reason [fixture: 64. MESSAGE DIET — two renderings, one row; public is lint-clean, capped, and loses no field]
- `note` and `claimCoverage().line` no longer mix audiences: `note`/`operatorNote` are split and `claimCoverage` returns parts; the render-lint inspects the public OUTPUT with a planted-violation self-test [fixture: 64. MESSAGE DIET — two renderings, one row; public is lint-clean, capped, and loses no field]
- The CEX message types (funding, listing, suspension) are NOT inventoried here [UNENFORCED: section F records the omission deliberately — an inventory that silently covered three of seven types would be worse than one that names its own gap.]


Part 5 of `MESSAGE-DIET.md` asserts that **no field present in the current message is
absent from BOTH renderings.** That assertion needs a list of what "present today"
means. This is that list.

Each row: the field, where it comes from, and the proposed destination
(`PUBLIC` / `OPERATOR` / `CHANNEL BIO` / `DROP`). Destinations are a proposal for
review — the inventory itself is the durable artifact.

---

## A. Wrapper — `formatAlert`, `src/core/dispatcher.js:165-179`

Every message of every type passes through this.

| # | Field | Source | Rendered as | Proposed |
|---|---|---|---|---|
| A1 | type tag | `TAG[source:type]` | `[🔓 TOKEN UNLOCK]` | PUBLIC |
| A2 | title | `a.title` | bold headline | PUBLIC |
| A3 | fact subtitle | `:173` | `fact · no directional call` | **CHANNEL BIO** |
| A4 | call subtitle | `:174` | `B-TIER · conviction 78` | PUBLIC (calls only; none fire today) |
| A5 | body bullets | `a.lines` | `• …` per line | per-type below |
| A6 | update counter | `:176` | `updated 3x — same setup, not a new event` | PUBLIC |
| A7 | chart link | `:177` | `chart` → `a.url` | PUBLIC |
| A8 | data-age footer | `ageLine(a)` `:178` | `data age ≤60s (REST poll)` | **REVIEW** |

**A8 is not in the diet brief and should be.** It reads as boilerplate but it is not
constant — it varies with collector freshness, and on a stale collector it is the
only public signal that the number is old. Recommend: keep in PUBLIC only when the
age exceeds a threshold; suppress when fresh. That keeps the coverage obligation and
removes the per-message noise. **Do not silently drop it** — that would convert a
hedged claim into a bare one, which Part 4 forbids.

## B. Sourced unlock — `sourcedMessage`, `unlocks.js:278-296`

| # | Field | Line | Proposed |
|---|---|---|---|
| B1 | `📅 UNLOCK LISTED · SYM` | `:280` | PUBLIC (as `📅 UNLOCK · SYM`) |
| B2 | kind: `cliff` / `linear tranche (Nd)` | `:280` | PUBLIC |
| B3 | when + date: `in 7 days (2026-09-19)` | `:280` | PUBLIC (as `19 Sep (7d)`) |
| B4 | `fact · per DefiLlama's schedule — NOT independently verified` | `:282` | split: "unverified" → PUBLIC provenance line; "fact ·" → CHANNEL BIO |
| B5 | upcoming batch-event count | `:283` | OPERATOR |
| B6 | category list (`insiders / privateSale / …`) | `:283` | PUBLIC |
| B7 | tranche size + symbol | `:284` | PUBLIC |
| B8 | `% of max supply` | `:284` | PUBLIC |
| B9 | `% of supply unlocked to date` | `:284` | PUBLIC |
| B10 | `(source figure)` qualifier | `:284` | PUBLIC — **coverage obligation** |
| B11 | chain, or `unconfirmed — no on-chain read attempted` | `:285` | PUBLIC — **coverage obligation** |
| B12 | source age in days | `:286` | PUBLIC — **coverage obligation** |
| B13 | `goes silent if not re-confirmed within 21 days` | `:286` | OPERATOR (mechanism, not fact) |
| B14 | schedule-revision note + recheck date | `:287` | PUBLIC if present (it is a change to the claim) |
| B15 | second-source agreement line | `:291-292` | PUBLIC, collapsed to one of 3 forms |
| B16 | paid-tier / withheld-count explanation inside B15 | `unlocks.js:245` | OPERATOR |
| B17 | explorer URL, else DefiLlama | `:294` | PUBLIC |

Today: up to **7 bullets + A3 + A8 = 9 lines**. Diet cap is 6. B5, B13 and B16 moving
to OPERATOR plus A3 to the bio gets there without touching a coverage obligation.

## C. Verified unlock (generic path) — `unlocks.js:403-426`

| # | Field | Line | Proposed |
|---|---|---|---|
| C1 | stage title (`in N days` / `today` / `T+N — event was …`) | `:408-410` | PUBLIC |
| C2 | `{name}: scheduled token unlock` | `:417` | PUBLIC (merge into title) |
| C3 | `(~X% of market cap)` | `:385,417` | PUBLIC |
| C4 | `Context: {note}` | `:418` | **SPLIT** — notes are operator prose today (see below) |
| C5 | default context: "Unlocks add sell-side supply; thin-liquidity tokens absorb it worst." | `:418` | DROP (generic advice) |
| C6 | lead≥7 epistemics blurb | `:420` | DROP (restates the absence of a call) |
| C7 | lead<0 post-event blurb | `:422` | DROP |
| C8 | imminent blurb ("not something this system has earned an opinion about") | `:423` | DROP |
| C9 | `Verified — source: {events[0].source}` | `:404` | PUBLIC — **coverage obligation** |
| C10 | `claimCoverage(t, lead).line` | `:404` | **SPLIT** — see below |
| C11 | retrospective observed-total line | `:397-401` | PUBLIC on T+3 (it is an observation) |
| C12 | `Date verified against the public unlock calendar.` | `:406` | PUBLIC |
| C13 | `⚠️ Recurring-schedule estimate — confirm on cryptorank.io` | `:407` | PUBLIC — **coverage obligation** |
| C14 | CryptoRank vesting URL | `:426` | PUBLIC |

**C4 is the biggest single source of architecture-talking-to-itself.** Live examples:
*"bucket C not enumerated by us"*, *"cadence spec would false-demote by
construction"*, *"Found by the 2026-09-05 hand-curated index rescan; first promotion
from the temporal-leg population"*. These are build-log entries living in a public
field. Recommend: `note` becomes OPERATOR-only, and any genuinely public context
gets its own short field rather than being smuggled through a free-text note.

**C10 needs splitting, not moving.** `claimCoverage(row).line` currently concatenates
a public obligation with an operator mechanism in one string, e.g.
*"Date and amount observed on-chain — 2 custody wallets, each required to emit and
the family total within ±13%, over 11 months. Auto-demotes if the pattern breaks.
Falsifier strength: a 5-day window passes by chance 24% of the time; record 11/11
consecutive (that series by chance alone: p≈1.5e-7)."*
Public needs `observed on-chain · 11 consecutive months`. Everything from
"Auto-demotes" onward is operator. **`claimCoverage` must therefore return FIELDS,
not a pre-joined sentence** — it already returns `{date, amount, scope, line}`, so
add the parts and let each rendering join what it needs. This preserves the derived
property that makes Part 4 safe.

## D. Contract-cliff unlock — `unlocks.js:365-370`

| # | Field | Line | Proposed |
|---|---|---|---|
| D1 | `SYM contract cliff in N days — date` | `:367` | PUBLIC |
| D2 | `{name}: scheduled cliff on a vesting contract` | `:368` | PUBLIC (merge to title) |
| D3 | `Context: {note}` or "Claims open on this date; beneficiaries pull individually over the following days." | `:368` | the default is PUBLIC and good; `note` → OPERATOR |
| D4 | `Fact only — no read on what claimants do with it.` | `:369` | CHANNEL BIO |
| D5 | `Verified — source: contract-cliff.` | `:369` | PUBLIC — **coverage obligation** |
| D6 | `claimCoverage(t, lead).line` incl. WEAK-falsifier clause | `:369` | SPLIT as C10 |
| D7 | Etherscan contract URL | `:370` | PUBLIC |

## E. Coverage obligations — the must-survive list, with citations

Part 4 lists these in prose; here they are bound to fields so the fixture can assert
them mechanically:

| Obligation | Fields | Fires when |
|---|---|---|
| VERIFIED vs LISTED at a glance | B1 vs C1/D1 (📅 vs 🔓) | always |
| source name when unverified | B4 | `provenance === 'sourced'` |
| source age when staleness can silence | B12 | `provenance === 'sourced'` |
| amount not observed on-chain | C9 + C10's amount part | `events[0].source === 'announcement'` |
| chain unconfirmed | B11 | `chain === 'unconfirmed'` |
| estimate warning | C13 | no `events[]` and not `verified` |
| weak falsifier stated | D6's WEAK clause | `falsifier.verdict === 'WEAK'` |
| data age when stale | A8 | collector age over threshold |

## F. TODO — not yet inventoried

`funding.js`, `listings.js`, `announcements.js`, `upbit.js`, `cascade.js`,
`revival.js`, `confluence.js`, `whale.js`, and `executability.js`'s executable-size
line. The diet brief gives templates for FUNDING, LISTING and DELISTING/SUSPENSION,
so those three must be inventoried before Part 5's fixture can be written. Same
method: grep `title:` / `lines:` / `url:` and cite file:line.

---

## Enforcement, not convention — lint the RENDERED PUBLIC OUTPUT

Renaming `note` to `operatorNote` fixes today's instances and nothing more: a human
writes the next string and no rule inspects it. Free text re-mixes audiences by
default. This project's answer to that shape everywhere else is a lint, and it should
be the answer here.

**Lint the rendered public message, not the source field.** A field-specific rule on
`note` would miss the same vocabulary arriving through `claimCoverage`, a future
field, or a template. Linting the OUTPUT catches it wherever it comes from — assert
the invariant, not the shape.

Proposed as a sibling of fixture 30 (`src/core/dispatcher.js` prose lint), run over
`renderFact(row, 'public')` for a representative row of every shape:

  ARCHITECTURE VOCABULARY — banned in public output:
    bucket · falsifier · spec (as in "cadence spec") · by construction · demote ·
    promote · dead-man · provenance tier · overlay · quarantine · claim coverage ·
    chance rate · binomial · replay series · enumerated by us

  These are all real distinctions and all belong in the OPERATOR rendering. The ban
  is on where they are said, not on saying them.

  SELF-TEST, mandatory: the lint must be shown to catch a planted violation in the
  same run that it passes — a lint that has never gone red is decoration. Plant
  `note: 'bucket C not enumerated by us'` on a synthetic row, assert the public
  render FAILS, then assert the same row with an operator-safe note passes.

  FALSE-POSITIVE CARE: some of these words have ordinary uses ("monthly cadence" is
  plain English). Scope the ban to the public rendering only, and prefer whole-word
  matching with the compound forms ("cadence spec", not "cadence") where the plain
  word is legitimate.

  THE LIST IS HAND-MAINTAINED, THEREFORE IT DRIFTS — and that is the shape this
  project has auto-discovered its way out of four times (doc premises, prose lint
  file discovery, classifier wiring, pagination readers). It cannot be auto-COMPLETED
  — no rule knows a coined term is coined — but its INCOMPLETENESS can be made
  visible, which is the same trade already taken twice:
    review-unclassified.js  -> heartbeat: "105 shapes · 11 recurring · 0 seen 24h ⚠️"
    review-exclusions.js    -> heartbeat: "23 excluded · 3 xStock unreviewed 🚨"
  PROPOSE review-vocabulary.js on the same pattern: extract candidate coined terms
  from `docs/briefs/*.md` and `REMAINING-WORK-NOTES.md` (hyphenated compounds and
  repeated multi-word phrases are the reliable signal), diff against the banned list,
  and surface the unreviewed count on the heartbeat until an operator classifies each
  as PUBLIC-SAFE or BANNED. The self-test keeps the list HONEST; this keeps its gaps
  VISIBLE. Neither makes it complete, and the doc should not pretend otherwise.

  Terms coined in the last three weeks that are NOT yet on the list and should be
  triaged first: pressure floor · dead-man switch · void / rescore · claim coverage ·
  mechanism (as continuous-claim / index-contradicted) · sourced tier · cliff cluster
  · off-index · compound (as binomial tail) · span covered · historyResetAt.
  New vocabulary appears in briefs BEFORE it appears in messages, which is exactly
  why a periodic pass over recently-coined terms catches it cheaply.

## `ageLine` — reuse the disclosure rule that already exists

Do not invent a second staleness rule. `macro.js:120-127` and `:137-141` already
implement exactly this:

```js
// when delivery is on time. State the actual window; disclose lag when late.
const lagMin = Math.round((now - due) / 60e3);
...(lagMin > 5 ? [`⏱ delivered ${lagMin}m after the T+5m mark — the window above is as stated, not live`] : []),
```

Disclose when there is something to disclose; stay silent when there is not. `A8`
should use the same helper and the same threshold semantics: suppress when the data
is as fresh as a reader would assume, and state the age — with the same `⏱` marker —
when it is not. One rule for "this number is older than you'd think", applied in both
places, rather than two rules that will drift apart.

## The one structural finding

Two fields — `note` (C4/D3) and `claimCoverage().line` (C10/D6) — are **free-text
strings that mix public fact with operator mechanism.** They cannot be routed by a
destination table because the split runs *through* them, not around them. Both must
be decomposed into parts before `renderFact(row, audience)` can be written, and that
decomposition is a prerequisite of the diet, not a detail of it.

`claimCoverage` already returns a structured object and only its `line` is
pre-joined, so this is a small change that preserves the derived-not-stored property.
`note` is free text on the row and needs a convention — most likely an
`operatorNote` field, with `note` reserved for anything genuinely public.
