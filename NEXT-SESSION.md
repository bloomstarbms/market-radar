<!-- PREMISE
Written against: v0.23.4
Reviewed: 2026-08-29
Assumes:
- Step 6 (vesting reads for the 12 gate-passing tokens) is PENDING — EXECUTED 21 Aug,
  so sections 0-4 below are HISTORY, not instructions.
- The 12-token universe is the right population — SUPERSEDED 29 Aug (candidate index
  of tokens with known schedules; see REMAINING-WORK.md "CANDIDATE PROVENANCE").
- Section 5 (bucket-D announcement path) SURVIVES and was vindicated by the scan.
STATUS: mostly EXECUTED. Do not run as a session prompt; read as background.
-->

# Next session

## OPENER — paste this into Claude Code (written 2026-09-13, annotated 2026-09-15)

```
Read CLAUDE.md, then Part 0 of REMAINING-WORK.md.

Items 8–10 of docs/briefs/CORRECTNESS-QUEUE.md, in order:

  9 FIRST — index refresh. SEI, APT and CARV have exhausted their
    listed events and are silent; the ladder reads FRESH because it
    measures age, not runway. Browser-pane route per the RECURRING
    CHORE section below. Re-record derivePressureFloor if it moved.

  8 — ladder coverage arm. Pre-register N before choosing it.
    Acceptance: the coverage arm fires on a row with N days of runway
    while the age arm stays quiet on the same file.

 10 — re-promotion requires post-demotion evidence. At least one
    on-schedule emission after the miss. Re-analysing pre-demotion
    history is not new evidence however detect-cadence classifies it.
    Encode it in promote-unlock.js so it refuses, not advises.

Then MESSAGE-DIET.md — inventory exists, two decompositions are
prerequisites, the render-lint needs its self-test.

Watch: ZK and ARB on the 14th. FF pushes both dates on the 22nd.
ENA's fourth wallet (0xA7eE, 57M, funded ~09-11) on Oct 6.
```

9 is before 8 deliberately: three rows are silent now and the fix is a chore, not a
build.

```
ADDENDUM (2026-09-15) — before item 10, and before treating ORDER's demotion as final:

ORDER's first real cliff verdict is a DEMOTE at ratio 2.74 against a MIN_RATIO of
3.0, with 21 claimants. A first real verdict landing 9% under the bar is exactly
the case a derivation exists for.

  PREMISE CORRECTED: a grid DID run at promotion — w∈{3,5,7} × r∈{2,3,5}, nine
  points, recorded on the spec. What did NOT run is the finer derivation from the
  observed cluster ratios themselves. And the grid already says something: w5/r2
  replayed 7/8, w5/r3 only 6/8. The better-replaying bar was passed over for 3.0,
  and 2.74 passes under r=2. Choosing 3.0 from {2,3,5} was a DECLARED cut among
  derived candidates — the same class one level down.

  - Derive MIN_RATIO (and WINDOW_DAYS) from the distribution of ORDER's own
    observed cluster ratios — the 13 clusters (6 on-index + 7 off-index) — e.g. a
    low percentile of the observed ratios, the way the pressure floor and the
    tolerance bands were derived. Record the basis on the spec.
  - If 2.74 sits inside the derived band, the 09-07 verdict becomes CONFIRM and
    this demotion is a CALIBRATION ARTIFACT — the third kind of void, after
    "never fetched" and "hand-corrupted". Void it through annotate-verdict.js
    with that reason; do not hand-edit.
  - Item 10's rule must key on MARGIN, not on the binary. ENA missed at 0.427 —
    a break below thirteen months of floor. ORDER missed at 0.91 of bar on a
    falsifier already labelled WEAK. A re-promotion rule treating those identically
    measures the wrong thing. Scale the post-demotion evidence requirement with
    how far below the bar the miss fell.

  THE CLASS: an underived threshold produced the first real verdict on the only
  row that uses it — "constant fitted to one instance", arriving on the row with
  the weakest falsifier, where a wrong verdict is hardest to tell from a right one.

  COMPUTED 2026-09-15 (full table in REMAINING-WORK-NOTES.md): at w5, r2 and r3
  have IDENTICAL margin (replay − chance = 0.17 both). There was no numerical
  reason to choose r3, so none was recorded, and that choice is what flipped the
  verdict. Best margin in the whole grid is w3/r2 at 0.26; every w7 point is
  NEGATIVE. So the question for item 10 is prior to margin-scaling: should a row
  whose best parameterisation clears chance by 0.26 be VERIFIED at all? Decide
  that first. If yes, the spec basis must record the choice as arbitrary where it
  was, and the row must carry its best margin so the weakness is on the row.

ALSO QUEUED, small, whenever there is room:
  - The version bump should ask each file's PREMISE what "Written against" means
    rather than sed-ing a number across every .md. The 2026-09-13 blanket sed
    reached a parked patch and a brief that each had a different claim to make
    about the same version, and created a collision that had to be corrected by
    hand. A blanket sed is a hand-maintained-list operation in disguise.
```

**ORDER's first real cliff verdict is IN — do not wait for it.** Landed 2026-09-13T21:21,
eighteen minutes after the void was cleared through `annotate-verdict.js`:

    ORDER:2026-09-07  DEMOTE  ratio 2.74 · recipients 21 · inWindow 266,504

A real fetch: 266,504 ORDER to 21 claimants in the window. Cleared the recipient gate
(21 ≥ 5), **failed the ratio gate by 9%** (2.74× vs 3×). The void verdict was
accidentally right on the action and wrong on every number. This is a cluster-shaped
event slightly under threshold, not a schedule stopping — and it should inform item 10:
a DEMOTE at 2.74/21 and ENA's at 0.427 are not the same object, and re-promotion logic
should not treat them identically. The entry has no `notified` field (the cliff path's
fire-and-forget delivery, logged in PENDING-cliff-cache-staleness.pending, not yet in
the queue) — operator to confirm the DM arrived.

## RECURRING CHORE — refresh the unlock index (monthly, or when the heartbeat warns)

**Trigger:** the heartbeat's "Sourced firing:" line shows `⚠️ index 14d old` (or
`🚨` at 18d). At 21d every sourced row goes silent — correctly, but silent. Do not
wait for the siren if a session is happening anyway.

**Why manual:** `defillama.com/unlocks` returns Cloudflare 403 to the sandbox AND to
the operator's desktop (re-tested 2026-09-07). The in-app browser pane loads it
normally. So the index arrives by hand, carried as gzip+base64, CRC-checked.

**Steps** (about ten minutes):

1. Browser pane → `https://defillama.com/unlocks`.
2. Get the keep-set:
   `node -e "const fs=require('fs');const k=new Set();for(const t of JSON.parse(fs.readFileSync('unlocks.json')).tokens)k.add(t.sym);for(const p of JSON.parse(fs.readFileSync('data/unlock-index.json')).protocols)k.add(p.symbol);console.log(JSON.stringify([...k].sort()))"`
3. In the pane, run the extractor with that array as `KEEP` — it parses
   `__NEXT_DATA__.props.pageProps.data`, applies the SAME trim as
   `fetch-unlock-index.js` (cliff, or linear with `rd>=28`; past 120d / future 400d;
   merged by `timestamp|type`), encodes compactly, gzips, base64s into `window.__C`.
   The snippet is in the 2026-09-07 entry of REMAINING-WORK-NOTES.md.
4. Carry `window.__C` out in slices (`.slice(0,2140)`, etc.), append each to one
   file, then `node import-unlock-index.js <file.b64>`. A truncated or mistyped
   slice fails the gzip CRC and writes NOTHING — that is the intended behaviour.
5. Re-ingest every sourced row through the write path (never edit unlocks.json):
   `for s in $(node -e "console.log(JSON.parse(require('fs').readFileSync('unlocks.json')).tokens.filter(t=>t.provenance==='sourced').map(t=>t.sym).join(' '))"); do node promote-unlock.js $s provenance=sourced source=defillama; done`
6. Watch for two things in that output:
   - `[OPERATOR] ... index dates MOVED and this row carries mechanism ...` — re-run
     `detect-cliff-cluster.js` for that symbol and re-stamp; the old verdict was
     against the old dates.
   - a stage flip on a row you expected to stay put.
7. Re-derive and RE-RECORD the pressure floor if it moved:
   `node -e "import('./src/core/unlock-promote.js').then(m=>console.log(JSON.stringify(m.derivePressureFloor(JSON.parse(require('fs').readFileSync('unlocks.json')).tokens))))"`
   — update `SOURCED_PRESSURE_FLOOR` (value, n, basis) in `src/core/unlock-promote.js`.
   Fixture 47 fails until you do; that is the point of it.
8. `node test-delivery.js` (ALL GREEN), then restart and push.

**Verify:** heartbeat shows `index age 0d`, `Sourced firing: N rows · N with a
future event`, and no `🚨 MUTE`.


## 0. FIRST: restore drill on tonight's backup (before push, before EIGEN)
Load `data/backups/outcomes-2026-08-09.json` as if the live file were gone:
parse it, assert row count vs live `data/outcomes.json`, then run
`modulePrecision()` from budget.js against the restored rows and confirm the
multipliers match the live ones. (No SQLite here, so this is the JSON analogue
of `PRAGMA integrity_check`.) Parse-verified at write time is a gate; the first
restore is the only real proof a backup works — do it before it's needed.
Then: GitHub push, v0.9.4 -> v0.16.3.

# EIGEN vesting contract read (then STRK, ARB)

Target list = gate-pass ∩ unlock-schedule, 12 tokens (see `unlock-pressure.json`):
SUI ENA TIA ARB INJ SEI APT JUP OP STRK ZRO EIGEN. Twenty others failed the
executability gate — zero integration minutes on them, ever.

## Read protocol (agreed 2026-08-10)

1. **Enumerate ALL vesting contracts, not one.** Team / investors / ecosystem /
   foundation each have their own contract, cliff, and dates. One contract = a
   fraction of the unlock and a confidently wrong number. The deliverable per date
   is the AGGREGATE across contracts, split by recipient type (VC/team sell very
   differently from ecosystem).

2. **Backtest before trusting forward.** Pick a cliff the contract says already
   happened; verify tokens actually MOVED on-chain that day (Etherscan token-tx
   for the vesting address). Contract says cliff, chain shows nothing → wrong
   contract or wrong units. Find out now, not three months into a silent module.

3. **Decimals.** Raw uint256 / 10^18. Assert every amount < circulating supply
   (CoinGecko free) or refuse the read. A quintillion-scale error looks plausible
   next to pressure ratios already in the hundreds.

4. **Ship dates immediately; don't wait for ADV.** Date detection (contract read)
   and severity (ADV accumulating in state.adv, ~30d to maturity) are independent.
   Until ADV matures, print `pressure_vs_book` as ORDINAL rank only — §4.2's
   0.5/2/5 severity bands apply to ADV, never to book depth (2+ orders of
   magnitude apart).

5. **Bucket-four path.** Multisig-held with off-chain schedule → a project-announced
   date (docs/governance/blog) is a legitimate `verified` source, stored as
   `events[].source: 'announcement'`. Minutes, not half an hour, and the only
   route for those tokens.

## Verified-date schema (already live in unlocks.js, v0.16.1+)
```json
{ "sym": "EIGEN", "events": [
    { "date": "2026-09-01", "amountTokens": 12345678, "usdAtEntry": 6700000,
      "recipientType": "team+vc", "source": "contract",
      "contract": "0x...", "backtested": "2026-08-01 cliff confirmed on-chain" } ] }
```
No `events[]` → module stays silent for that token. That is correct behavior.

## Tools in place
- Etherscan key (free, ethereum only, 3 req/s) supports `eth_call` for reads.
- ADV accumulator: `state.adv[symbol][YYYY-MM-DD]` since v0.16.2, prune 35d.
- Three-state discipline live: verified / estimated(silent, logged) / unverifiable.

## Calendar-edit habit (updated v0.20.0)
Any macro-calendar edit — new date OR tier promotion — is ALSO a wake-timer
regeneration: run `node gen-wake-timers.js` then SETUP-WAKE-TIMERS.bat.
STANDARD stages are covered too now (t24h/t5m), not just FULL.

## STANDING ORDER (18 Aug, operator-set)
The delivery layer is DONE: four boot gates, three named bug classes, 168+
fixtures, instruments on every quiet path. Marginal value has moved.
THE NEXT SESSION OPENS WITH THIS FILE — step 6, nothing else, unless there
is a LIVE INCIDENT (not a refinement). Verified unlock dates are the
highest-value fact type on the list: dated events with lead time, feeding
the exact facts pipeline just hardened, and the module has been silent
since three-state honesty landed. Triage the twelve into buckets A-D
FIRST (expect ~half in bucket D), then EIGEN — enumerate ALL vesting
contracts, sum by recipient type — and BACKTEST A PAST CLIFF against
actual on-chain movement before trusting any forward date.
