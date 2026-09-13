<!-- PREMISE
Written against: v0.31.7
Reviewed: 2026-09-13
Status: ACTIVE PLAN — one pending edit to another file. This is not a new home for
  the bug-class library; REMAINING-WORK-NOTES.md is. This exists only because the
  2026-09-13 ownership split gives the Cowork session `docs/briefs/` and nothing
  else, and REMAINING-WORK-NOTES.md is at the repo root.
Assumes:
- The four named classes already recorded in REMAINING-WORK-NOTES.md stand unchanged;
  this ADDS a fifth rather than restating them, because duplicating them here would
  create two copies that drift.
- Whoever owns the root files folds this in and then DELETES this file. A brief that
  outlives its own instruction becomes a second source of truth.
-->

# Pending addendum — a fifth bug class to fold into REMAINING-WORK-NOTES.md

Append the block below to `REMAINING-WORK-NOTES.md`, alongside the existing four:
"asserts the environment while appearing to assert logic" (safeguard), "unconditional
bypass wearing a justification" (bypass), "the branch that agrees with the prior
generates no friction", and "the test is the thing under test".

Then delete this file.

---

```
## BUG CLASS — "a hand-maintained list that pretends to be complete" (2026-09-13)

THE SHAPE: a rule whose inputs a HUMAN has to supply — vocabulary, exclusions,
labels, exemptions. The rule itself can be perfect and the list behind it still
silently incomplete, because nothing knows what is missing. A list presented as
coverage is the safeguard-lapse shape: it reports OK while the thing it protects
is partly unguarded.

THE FIX IS NOT COMPLETENESS — it is not reachable. It is VISIBILITY: surface the
gap as a count, on the heartbeat, until a human classifies each item. The list
stays incomplete and stops lying about it.

Three instruments in the project already have this form, and they were built one
at a time without the pattern being named:
  review-unclassified.js  -> "105 shapes · 11 recurring · 0 seen 24h ⚠️"
  review-exclusions.js    -> "23 excluded · 3 xStock unreviewed 🚨"
  review-vocabulary.js    -> PROPOSED, for the public-render lint's banned list
                             (MESSAGE-FIELD-INVENTORY.md)

THE TELL, for recognising the next one before it bites: does a human have to add
entries for the rule to keep working? If yes, the list will drift, and the only
honest design is one that counts what it has not been told about.

DISTINGUISH FROM auto-discovery, which IS reachable and is therefore required
where it is possible — doc premises, prose-lint file discovery, classifier wiring,
paginated readers. Those are derived from the code and must never be lists. This
class is the residue: the cases where no derivation exists because the knowledge
is human. Do not use "it's the hand-maintained-list class" as an excuse to skip a
discovery that was available. The question is which of the two applies, and the
default answer is discovery.

RELATED, and the reason this is a class rather than a preference: the exemption
mechanism in src/core/pagination.js was nearly this. A bare
"// PAGINATION-EXEMPT:" comment would have been a hand-maintained allowlist that
copy-paste could extend silently. Binding the tag to its own filename made it
fail closed instead — which is the OTHER escape from this class, available when
the list's entries can be tied to something the machine can check.
```

---

## Why this is not simply written into the notes

The 2026-09-13 ownership split (see `CLAUDE.md`) assigns root files, `src/` and
`data/` to Claude Code while the Cowork session is confined to `docs/briefs/` and
`*.pending`. Writing to `REMAINING-WORK-NOTES.md` from here would be exactly the
concurrent-writer hazard the split exists to prevent — and that file is append-only
by convention, so a lost update is a lost finding rather than a visible conflict.
