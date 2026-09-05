<!-- PREMISE
Written against: v0.30.0
Reviewed: 2026-09-01
Status: EXECUTED TWICE. 2026-09-04 on the mcap FALLBACK (3/65, line fired, refined to the temporal leg). 2026-09-05 on the INTENDED population (hand-curated, names only): cadence 3/12 = 25%, method line did NOT fire, MOVE promoted. Resolution line fired instead (36%): the index is mostly non-EVM. Spent; the finding lives in the notes. This is the corrected successor to
  UNLOCK-BULK-SCAN.md, which is EXECUTED and whose POPULATION premise was refuted
  at the root (gate-passers were never selected for having schedules). Its
  mechanics still hold; do not re-run its queue.
Assumes:
- Aggregators are illegitimate as EVIDENCE and legitimate as an INDEX. Their list of
  tokens with upcoming unlocks says WHERE to point discovery. Their dates are never
  shipped; every date is established by contract read, observed cadence, or project
  announcement, exactly as now.
- The population is now CHOSEN, not inherited. That changes what a null result means
  — see the falsification line below. This is the whole reason to re-run.
- Tooling is built and slice-hardened (bulk-scan.js, cadence-pass.js,
  detect-cadence.js, promote-unlock.js). This session needs no new machinery.
-->

# Rescan — candidate index of tokens with known upcoming unlocks

## Standing order

**Fix blockers. Log everything else.** The last scan's three fixes (symbol-squatters,
bridged escrows, pool pollution) all met the bar: the scan could not produce correct
verdicts without them. The pull will be to fix the next tier down too. A defect is a
blocker only if the scan cannot proceed or returns WRONG verdicts. Everything else
goes to the notes with its evidence.

**Do not touch another parameter.** `E_SCALE` and `floorFor(n)`'s thresholds are
known constants-fitted-to-one-case. They are logged, they are real, and they are not
worth a session while coverage is five tokens.

## 1. Pre-register — in the notes, BEFORE touching an API

Written 2026-09-01 so they are binding rather than fitted:

- **Resolution**: materially higher than the 39/156 the gate-passing queue returned.
- **Cadence**: detected on roughly a quarter to a third of tokens that show locked
  supply.
- **Promotions**: the point of the session; a number, stated before running.
- **FALSIFICATION LINE — the one that matters this time.** The population is now
  CHOSEN, so a null cannot be blamed on the queue. **If cadence detection lands under
  ~10% on tokens KNOWN to have upcoming unlocks, the METHOD does not generalise** —
  it works on large professionally-custodied treasuries and not on the general case.
  That is an expensive finding nobody wants, which is exactly why it is written down
  before the numbers arrive.

## 2. Post-mortem hypothesis, stated in advance

If the line fires, do NOT widen the detector — it is already correct on what it
covers. Test this triple instead, against whatever the scan returned:

> EIGEN and ENA are detectable because they are (a) large enough for institutional
> custody, (b) professionally managed, and (c) distributing in BATCHES rather than
> continuously.

If those are the necessary conditions, the finding is the method's true addressable
set — which is more useful than a detector that works everywhere and finds nothing.
Check the failures for which leg they lack; that is a checkable test, not a
retrospective story.

## 3. Sequence

1. Pre-register (above) in REMAINING-WORK-NOTES.md.
2. **Candidate index** — CryptoRank (`CRYPTORANK_API_KEY` is in .env), NAMES ONLY.
   Never read their dates. Fall back to top-200-by-mcap if the list is paywalled.
3. **Filter** — drop already-verified, retired, non-native, and anything
   `classifySymbol` marks EXCLUDE. Write the queue and the RULE that produced it to
   data/scan-queue.json.
4. **Pipeline** — `bulk-scan.js` (discovery) then `cadence-pass.js`, both already
   checkpointed per token, error-isolated, and budget-sliced for the ~170s cap.
5. **Triage and promote** — every new row gets a forward falsifier (cadence spec
   where emissions are observable, `reviewBy` where they are not), a derived
   tolerance with its basis, and a stage. Through `promote-unlock.js` ONLY.
   Backtest requirement unchanged: a schedule whose past does not replay is not
   promoted, however clean the parse.
6. **Compare against the pre-registration, honour the line, run the post-mortem** if
   it fires.

## Acceptance

- Queue rule recorded and reproducible
- Pre-registered numbers compared against actuals, falsification line honoured
- Every new row passes the forward-falsifier boot gate
- Heartbeat coverage line updated
- Notes record either the promotions or the method finding — a null result is a
  result, and last time it was the most useful output of the session
