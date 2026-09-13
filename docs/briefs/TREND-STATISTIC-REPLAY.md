<!-- PREMISE
Written against: v0.31.7
Reviewed: 2026-09-11
Assumes:
- Series are the per-month emissions recorded in data/cadence-report.json at
  promotion time, plus MOVE's 2026-08 peak day (5,138,889) from the 2026-09-08
  replay. No network was available when this was written.
- Spearman rho here was computed BY HAND (the sandbox mount was down). Every figure
  below must be re-derived in code before anything is built on it. Hand arithmetic
  is exactly where an error hides.
STATUS: ACTIVE PLAN — decision deferred to after 2026-09-12, per the standing rule
that a detector is not changed while a window it governs is open.
-->

# Trend statistic on the three cadence rows — the proposed fix does not survive its own test

## Why this was run

MOVE carries `cv = 0.31` over 8 months and reads as healthy. The objection: **cv
measures dispersion, not direction.** A schedule stepping 12M → 5M has roughly the
cv of one oscillating around 9M. The proposal was to add a trend statistic
(Spearman rho of amount against month index, or a monotonic-run count) to
**promotion** and to **drift**, on the grounds that MOVE would then have been
flagged as *declining, not stable* when it was promoted.

Measured on all three rows, offline, changing nothing.

## The series

| row | window | n | emissions |
|---|---|---|---|
| EIGEN | 2025-09 → 2026-07 | 11 | 10.87, 10.89, 9.98, 9.06, 8.91, 8.58, 9.91, 9.48, 9.61, 9.57, 9.58 (M) |
| ENA | 2025-08 → 2026-08 | 13 | 6.41, 12.46, 20.02, 13.11, 10.30, 12.93, 13.88, 10.64, 12.82, 12.69, 7.94, 10.37, 13.32 (M) |
| MOVE | 2025-12 → 2026-07 | 8 | 15.43, 7.88, 6.39, 7.88, 12.18, 10.03, 9.46, 6.44 (M) — then 2026-08: 5.14 |

## Result — the statistic would have flagged the wrong row

Spearman rho over the **full series as it stood at promotion**:

| row | rho at promotion | reading |
|---|---|---|
| EIGEN | **−0.38** | most negative of the three |
| MOVE | **−0.18** | mildly negative |
| ENA | **+0.02** | flat |

**A trend gate at promotion would have refused EIGEN and admitted MOVE — exactly
backwards.** EIGEN's negative rho comes from an early step-down (Sep–Feb) followed
by five months flat at ~9.5M ±2%; MOVE's promotion window happened to open on its
highest month (15.43M in Dec) and close mid-decline, which flattens the correlation.
The same is true of a monotonic-run count: EIGEN's longest decreasing run over its
promotion series is **4** (Oct→Feb), identical to MOVE's **4** (Apr→Aug). Neither
statistic separates them at the moment the decision is made.

## What does separate them — but only later

Spearman over the **trailing five months**, computed today:

| row | trailing-5 rho | |
|---|---|---|
| MOVE | **−1.00** | Apr→Aug perfectly monotonic: 12.18, 10.03, 9.46, 6.44, 5.14 |
| EIGEN | −0.30 | noise around a flat level |
| ENA | +0.10 | noise |

That separates cleanly. But the same trailing-5 window computed **at MOVE's
promotion** (Mar→Jul) gives **−0.40** — not obviously different from EIGEN's −0.30.
The signal that makes MOVE unambiguous is the two months that came *after* it was
promoted.

## The conclusion this forces

**Trend belongs in DRIFT, not in PROMOTION.** At promotion there is not enough
signal to separate "stepped down once, now stable" from "declining"; two months
later there is, and by a wide margin. A promotion gate built on this would have
produced a false refusal (EIGEN) and a false admission (MOVE) on the only three
rows available to test it.

This lands on the gap already recorded on 2026-09-08: **drift starts blind.**
`driftStatus` reads only ratios the watch has stamped, and a freshly promoted row
has none — MOVE's five-month decline is invisible to it. So the fix is one change,
not two:

1. carry the promotion series' per-month ratios onto the row at promote time
   (`detectCadence` already computes them), so drift has a baseline from day one;
2. compute trend **in drift** over a trailing window against that baseline, and
   report it in the heartbeat — never as an automatic demotion, same rule as the
   existing drift line.

## ENA is the counter-example that justifies the whole apparatus

ENA demoted on 2026-09-10: `largestSeen 5,148,798` against a bar of 6,034,718
(ratio 0.427) — **below its lowest month in thirteen** (6.41M). Its rho was +0.02
and its previous month cleared the bar by 121%. No trend statistic and no headroom
measure would have predicted it, because it was a discontinuity, not a slope.

That is the argument for keeping a falsifier rather than a forecast: the thing that
caught ENA was not a model of its behaviour but a standing test that its behaviour
had to keep passing.

## Shipped alongside — the demote states its own scope

`demoteScope(t)` in `cadence-watch.js`, added to the DEMOTE/PARTIAL message lines.
Single-wallet rows now say: *"Scope: SINGLE-WALLET spec — one custody wallet was
read, and 2 known co-emitters are deliberately UNWATCHED (an irregular emitter would
false-demote every quiet month). This verdict CANNOT distinguish a stopped schedule
from a migration to another wallet — run node detect-cadence.js ENA before treating
it as stopped."* Family rows make the different claim they should: the total failed,
not that one address went quiet.

This is not a retreat from the single-wallet choice — folding the co-emitters in
would restore the false-demote-every-quiet-month failure it was chosen to prevent.
It is the claim-coverage rule applied one level down: the verdict is honest about
what it read and what it therefore cannot tell apart.

> ✅ **WRITTEN, THEN DELIBERATELY REVERTED — the live path is clean.** The sandbox
> was down all session, so this could not be syntax-checked or suite-tested. Leaving
> it in the tree was an unattended-restart hazard, not just a next-session chore:
> `market-radar.vbs` is in Windows Startup, so an overnight update reboot would have
> launched the bot from the working tree, and a parse error throws at IMPORT time —
> before any boot gate runs, so the self-tests would never have executed to report
> it. A 15-second crash-loop with no alerts, during the week MOVE's and ORDER's
> windows close, and the daily backup covers `data/`, not source.
>
> The patch is kept whole in **`PENDING-v0.31.7-demote-scope.pending`** at the repo
> root, with reapply instructions. `.pending` is inert to every discovery walker in
> the project (they key on `.js` / `.md`), so parking it there cannot break a gate.
> Reapply order: suite green on the current tree → apply → `node --check` → suite
> again (section 30's prose lint has never seen this wording and is the check most
> likely to object) → bump, restart, push.

## OUTCOME 2026-09-12 — the pre-registration was WRONG, and usefully so

| row | verdict | detail |
|---|---|---|
| MOVE | **CONFIRM** | 19,376,705 on 2026-09-09 — **ratio 2.048** |
| ORDER | **DEMOTE** | cliff 2026-09-07, ratio 0, recipients 0, inWindow 0 |
| ENA | DEMOTE (09-10) | largestSeen 5,148,798, ratio 0.427 |

**MOVE emitted more than twice its mean.** The pre-registered bar was 4,730,749 and
the stated expectation was that a continuation of the five-month decline
(12.18 → 10.03 → 9.46 → 6.44 → 5.14M) would demote it. Instead it emitted 19.38M —
the largest month since December, and 3.8x August. The decline was real and it did
not continue.

This is the sharpest possible confirmation of the section above: **a trend is not a
forecast.** A trend gate would have flagged MOVE as "declining, not stable" in the
month it emitted double its mean. Refusing to ship that gate on the strength of the
promotion-window replay was the right call for a reason stronger than the one given
at the time — not merely that it selected the wrong rows historically, but that the
quantity it measures does not predict the next draw at all.

Recorded plainly: **I read the decline as a signal about September and it was not
one.** The falsifier, which makes no forecast, got the answer right; the statistic,
which does, would have got it wrong.

**ORDER is the first contract-cliff verdict, and it is FALSE. Treat it as VOID.**

I first wrote that it was "the weak falsifier's one high-information outcome". That
was wrong twice over, and the second error is the serious one.

WRONG ONCE — weakness is symmetric, and only one side was measured. The compound
machinery (chance rate, replay series, binomial tail) exists only for CONFIRMs; a
DEMOTE is just a DEMOTE. ORDER's own chance rate says a 5-day window contains a
cluster 58% of the time, so an EMPTY window is a ~42% event under the null that
nothing changed. A p of 0.42 is not evidence a schedule stopped. Contrast ENA:
5,148,798 against a 13-month minimum of 6,413,805 — under exchangeability the
chance that the next draw is the smallest of fourteen is ~1/14 ≈ 0.07, and it came
in 20% BELOW the previous floor. ENA's demotion is strong; ORDER's would have been
near-noise even if it had been real.

WRONG TWICE — IT NEVER LOOKED. Every entry in data/cliff-fetch-cache.json reads
`"done":true,"at":"2026-09-05T17:3x"`, newest day 2026-09-05.
`outflowsWithRecipients` begins:

    if (c0?.done) return { byDay, covered: true, oldest, pages: 0, resumed: true };

So pollCliffWatch on 2026-09-12 was handed the SEPTEMBER 5 CACHE — `covered: true`,
zero pages, no network — and a cache ending 09-05 is empty across 09-07..09-12 by
construction. ratio 0, recipients 0, inWindow 0 is exactly what that produces.

THIS IS THE PROJECT'S OLDEST FAILURE CLASS, THROUGH A NEW DOOR. "We did not look"
must never be a verdict; `covered` is the flag that enforces it; and the resume
cache returns `covered: true` having looked at nothing. The guard was not bypassed —
it was HANDED a true value by a path that never fetched. The resumable cache was
added on 2026-09-05 to stop L3's 120-page proxy eating a budget slice, and it
introduced this the same day.

CONSEQUENCE: ORDER's row is demoted on no observation. Operationally mild — ORDER is
stage LOGGED and never alerts — but the coverage line and any future re-promotion
logic would treat it as a real failure. The cliff stamp in `st.cliffs` also blocks
re-evaluation of that cliff, so it will not self-correct.

### A defect this exposed — the cliff demotion is fire-and-forget

`st.demotions.ENA` carries `notified: true`; `st.demotions.ORDER` carries no
`notified` field at all. The cadence path records delivery and retries next cycle if
the DM failed; `pollCliffWatch` broadcasts with `.catch(() => [])` and never checks
whether the send landed. That is the delivery-accounting class this project has
fixed repeatedly — a marker set without evidence of receipt, or here, no marker at
all. **Unfixed, logged:** the cliff-watch demote needs the same
`if (ids.length) { …notified = true }` treatment as the cadence demote.

## Open, deliberately

- Nothing above is built. Decision after 2026-09-12, when MOVE's and ORDER's windows
  close, per the rule against changing a detector mid-window.
- Every figure here is hand-computed. Re-derive in code first.
- ENA's September emission may have moved to another wallet rather than stopped —
  the row carries `alsoObserve` co-emitters that the falsifier deliberately does not
  watch. `node detect-cadence.js ENA` before any re-promotion.
