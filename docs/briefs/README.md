<!-- PREMISE
Written against: v0.26.3
Reviewed: 2026-08-29
Assumes:
- This directory holds SESSION BRIEFS imported from the Cowork outputs folder —
  documents that shaped shipped architecture and are worth auditing.
- Every .md here is checked by fixture 36 (recursive): PREMISE block present,
  version parses, at least one non-empty assumption. Importing a brief without a
  header FAILS THE SUITE. That is the forcing function, not an inconvenience.
- Briefs are HISTORICAL RECORD, never instructions. A brief marked Executed
  describes what was done; a brief marked Refuted is kept so the refutation stays
  traceable. Neither is a plan. Current plans live in REMAINING-WORK.md.
-->

# Session briefs (imported)

Operator import step: copy the brief from the Cowork outputs folder into this
directory, then paste the matching header from the table below at the very top of
the file. Run `node test-delivery.js` — section 36 will refuse any brief that
arrives without one.

Status vocabulary: **Executed** (shipped in full) · **Executed, still governing**
(describes architecture currently in force) · **Partly stale** (some sections
superseded) · **Partly refuted** (a load-bearing claim was disproved) ·
**Historical** (superseded, kept for reference).

Priority if importing only two: `FACTS-AND-CALLS.md` (the architecture in force)
and `FACTS-ENGINE-ROADMAP.md` (the only document holding the current priority
ordering).

---

## Headers to paste

### FACTS-AND-CALLS.md
```
<!-- PREMISE
Written against: v0.22.x
Reviewed: 2026-08-29
Status: EXECUTED, STILL GOVERNING — this is the architecture the system runs on.
Assumes:
- Facts push immediately: no conviction score, no budget, no tier, no direction.
  Calls keep the full apparatus. This split is live and load-bearing.
- Catalyst deferral is REMOVED — deliver or suppress, never delay.
- Suspension and dated-delisting detectors belong in the fact path.
-->
```

### FACTS-ENGINE-ROADMAP.md
```
<!-- PREMISE
Written against: v0.24.3
Reviewed: 2026-08-29
Status: PARTLY STALE — sequencing holds, one plan superseded.
Assumes:
- Session A/B/D sequencing still holds (A executed; B large transfers and D
  position awareness still queued).
- Calls stay deprioritised relative to facts — HELD.
- Its step-10 replacement plan is SUPERSEDED by the 29 Aug bulk-scan result
  (population, not readability, was the limit; candidate index over gate-passers).
-->
```

### ALPHA_RADAR_BUILD_SPEC.md
```
<!-- PREMISE
Written against: pre-v0.11
Reviewed: 2026-08-29
Status: HISTORICAL — original $0/month rebuild spec.
Assumes:
- Section 11's build order is THOROUGHLY SUPERSEDED; do not execute it.
- Section 8's anti-pattern list REMAINS the reference for what the original bot
  did wrong, and is the reason to keep this file at all.
- The $0/month and zero-dependency constraints it set are still in force.
-->
```

### FIX-SYMBOL-CLASSIFIER.md
```
<!-- PREMISE
Written against: v0.23.3
Reviewed: 2026-08-29
Status: EXECUTED as v0.23.4.
Assumes:
- A ticker list would corroborate the xStock rule — INCOMPLETE: GMX (stem GM+X,
  GM = General Motors) proved an equity-ticker match alone produces false
  positives, which is why CRYPTO_EXCEPTIONS is checked FIRST.
- Symbols default to pushing when unrecognised; announcement text defaults to
  closed. Opposite defaults, deliberately — the base rates differ.
-->
```

### UNLOCK-EXPANSION.md
```
<!-- PREMISE
Written against: v0.24.5
Reviewed: 2026-08-29
Status: PARTLY REFUTED — import only to keep the refutation traceable.
Assumes:
- "Automate buckets A and B first — that's the scaling move" — REFUTED 29 Aug.
  Bucket A (OZ VestingWallet) releases continuously and emits NO DATED EVENT;
  bucket D custody batches monthly and is the alertable bucket. Corrected at
  source in REMAINING-WORK.md; this file is the record of the wrong turn.
-->
```

### UNLOCK-BULK-SCAN.md
```
<!-- PREMISE
Written against: v0.25.2
Reviewed: 2026-08-29
Status: EXECUTED — 156/156 scanned, 0 promotions.
Assumes:
- Its priors were BEATEN THREE WAYS: resolution 39 vs 55-85 predicted, locked
  supply 97% vs 20-40%, cadence 0/30 vs 15-40%.
- The result reframed the population question: gate-passers were never the right
  candidate universe; tokens KNOWN to have schedules are.
-->
```

### FIX-DELIVERY-AND-TIERING.md and SHIP-v0.20.0.md
```
<!-- PREMISE
Written against: v0.19.3
Reviewed: 2026-08-29
Status: EXECUTED, SPENT — both shipped in full. Historical only.
Assumes:
- Delivery confirmation gates every marker (digest, heartbeat, listing edits) —
  still in force and heavily fixtured.
- The digest/heartbeat split and C-tier recorded-only routing shipped as written.
-->
```
