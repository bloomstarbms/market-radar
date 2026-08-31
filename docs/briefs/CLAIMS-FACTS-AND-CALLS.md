<!-- PREMISE
Written against: v0.27.4
Reviewed: 2026-08-29
Status: DESCRIPTIVE — every claim below cites the fixture that would fail if the
  code stopped matching it. This file IS the enforcement companion to
  FACTS-AND-CALLS.md (not yet imported; see README.md for its header).
Assumes:
- DESCRIPTIVE means: each claim is backed by a test, not merely accurate today.
  A claim marked UNENFORCED is a promise nothing keeps — visible by design.
- Fixture 37 checks this file: every claim line carries a citation, and every
  cited section title actually exists in test-delivery.js. A fabricated or
  renamed citation FAILS THE SUITE.
-->

# FACTS-AND-CALLS — claims and their enforcement

The architecture brief makes checkable claims about the live system. Each is
listed here with the fixture that fails if code and document diverge. This is
what makes the document descriptive rather than merely true-so-far: drift is
discovered automatically instead of noticed by a reader.

Citation format: `[fixture: <exact section title from test-delivery.js>]` or
`[UNENFORCED: reason]`.

## Claims

- Catalysts and prints are FACTS; directional signals are CALLS. [fixture: 13. FACT/CALL split — facts are unscored, unbudgeted, never queued]
- A fact admits with no conviction score and no tier. [fixture: 13. FACT/CALL split — facts are unscored, unbudgeted, never queued]
- A fact is never charged to the alert budget. [fixture: 13. FACT/CALL split — facts are unscored, unbudgeted, never queued]
- A fact message carries no conviction and no tier in its text; a call still carries both. [fixture: 13. FACT/CALL split — facts are unscored, unbudgeted, never queued]
- An explicit kind:CALL overrides the type default, so the split is not type-locked. [fixture: 13. FACT/CALL split — facts are unscored, unbudgeted, never queued]
- Every fact type has a declared delivery route; an undeclared one refuses boot. [fixture: 18. every FACT type has a declared route (boot assertion)]
- Depth is an ANNOTATION on facts and a HARD GATE on calls; unverifiable depth says so. [fixture: 14. depth is an ANNOTATION for facts, a HARD GATE for calls]
- Nothing is ever deferred: catalysts deliver or suppress, never queue for digest. [fixture: 11c. C-tier is recorded-only; digest is conditional]
- Facts carry no directional claim in prose, and no frequency claim without a sample size. [fixture: 30. message prose is linted — direction ban + unsupported-statistics ban]
- Facts keep recurrence suppression: state-entry dedup, not per-print spam. [fixture: 19. FUNDING: state-entry dedup (the recurrence lesson applied to facts)]
- Multipliers and the retirement ladder apply to CALLS only; the ladder never gates a fact. [fixture: 38. the ladder never gates a FACT (the negative the citations exposed)]
- Suspension and dated-delisting detectors emit on the fact path. [fixture: 16. new detectors: suspension (routine vs open-ended) + scheduled delist]
- A fact that a venue never confirmed is never counted as delivered. [UNENFORCED: fixture 1 covers total send failure at the broadcast layer, but no fixture asserts the per-fact accounting path end to end — messageCounts() could over-count a partially-delivered batch without any test objecting. Narrower than it looks; write it before relying on it.]
- A delivery failure is never recorded as a send, for facts as for calls. [fixture: 1. broadcast() under total send failure]

## Reading

An UNENFORCED line is not a defect in the document — it is the document doing its
job, marking exactly where "we believe this" outruns "we check this". Convert one
by writing the fixture, then replacing the marker with its citation.
