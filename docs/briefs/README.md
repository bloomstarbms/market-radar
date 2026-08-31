<!-- PREMISE
Written against: v0.27.3
Reviewed: 2026-08-29
Assumes:
- This directory holds SESSION BRIEFS imported from the Cowork outputs folder —
  documents that shaped shipped architecture and are worth auditing.
- Every .md here is checked by fixture 36 (recursive): PREMISE block present,
  version parses, at least one non-empty assumption. Importing a brief without a
  header FAILS THE SUITE. That is the forcing function, not an inconvenience.
- Briefs are NOT uniformly historical. Read the STATUS line before deciding
  whether a brief describes the live system, records a wrong turn, or is spent.
  "Historical record, never instructions" is WRONG as a blanket rule — see below.
-->

# Session briefs (imported)

Operator import step: copy the brief from the Cowork outputs folder into this
directory, then paste the matching header from the table below at the very top of
the file. Run `node test-delivery.js` — section 36 will refuse any brief that
arrives without one.

## STATUS vocabulary — four kinds, and the distinction is load-bearing

- **DESCRIPTIVE** — a still-accurate account of how the LIVE system works. Not a
  plan and not history: the explanation of why the code is shaped as it is.
  `FACTS-AND-CALLS.md` alone. Treating it as "historical, do not obey" would
  discard the only document explaining why the dispatcher looks the way it does
  — why facts carry no conviction, why catalysts never defer.
- **ACTIVE PLAN** — still directs future work. `FACTS-ENGINE-ROADMAP.md` (its
  Sessions B and D remain queued). Obey its sequencing, minus the sections its
  own header marks superseded.
- **REFUTED** — kept precisely so the refutation stays traceable.
  `UNLOCK-EXPANSION.md`. Never execute; read to understand a wrong turn.
- **EXECUTED** — done and spent, historical only. `SHIP-v0.20.0.md`,
  `FIX-DELIVERY-AND-TIERING.md`, `UNLOCK-BULK-SCAN.md`,
  `FIX-SYMBOL-CLASSIFIER.md`.

`ALPHA_RADAR_BUILD_SPEC.md` STRADDLES deliberately: superseded as a plan (§11
build order), still DESCRIPTIVE as the reference for what the original bot did
wrong (§8 anti-patterns). Its header says both, per-section.

A brief may change category: when the roadmap's remaining sessions run, it
becomes EXECUTED. Restate the status on import, not from memory.

Priority if importing only two: `FACTS-AND-CALLS.md` (DESCRIPTIVE — the
architecture in force) and `FACTS-ENGINE-ROADMAP.md` (ACTIVE PLAN — the only
document holding the current priority ordering).

---

## Headers to paste

### FACTS-AND-CALLS.md
```
<!-- PREMISE
Written against: v0.22.x
Reviewed: 2026-08-29
Status: DESCRIPTIVE — an accurate account of the LIVE architecture, not history.
  This is the only document explaining WHY the dispatcher is shaped as it is.
  Do not file it as "executed, therefore spent": if it ever stops matching the
  code, one of the two is wrong and that is worth discovering.
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
Status: ACTIVE PLAN, partly superseded — Sessions B and D are still queued, so
  this document still DIRECTS work. Becomes EXECUTED when they run.
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
Status: STRADDLES — §11 build order SUPERSEDED as a plan; §8 anti-pattern list
  is still DESCRIPTIVE (the reference for what the original bot did wrong).
  Per-section status: do not apply one verdict to the whole file.
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
Status: EXECUTED — shipped as v0.23.4, spent.
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
Status: REFUTED — import only to keep the refutation traceable. Never execute.
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
Status: EXECUTED — 156/156 scanned, 0 promotions. Spent; the result lives on in REMAINING-WORK.md.
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
Status: EXECUTED — both shipped in full. Spent.
Assumes:
- Delivery confirmation gates every marker (digest, heartbeat, listing edits) —
  still in force and heavily fixtured.
- The digest/heartbeat split and C-tier recorded-only routing shipped as written.
-->
```
