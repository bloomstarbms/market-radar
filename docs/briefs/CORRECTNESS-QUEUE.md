<!-- PREMISE
Written against: v0.31.7 live
Reviewed: 2026-09-13
Assumes:
- The Cowork workspace could not reach the repo (Windows update of 2026-09-08); the
  queue was worked in Claude Code on this same directory.
- demoteScope remains parked and is retargeted to v0.31.8 — see
  PENDING-v0.31.7-demote-scope.pending (the filename is historical).
- Items 0-7 shipped as v0.31.7; the live tree is v0.31.7, suite-green at 665 checks.
Status: ACTIVE PLAN
  (Items 0 through 7 are done and shipped as v0.31.7 on 2026-09-13; items 8, 9 and 10
  remain and are still ordered. Do not re-run 0 through 7 — read them as the record of
  what was changed and why. NOTE: the word for "done" is deliberately spelled out here
  rather than using the status keyword, because a Status: line carrying two known
  statuses is ambiguous and the fixture-37 parser rejects it — which is how this very
  line was caught.)
-->

# Correctness queue — run this in Claude Code

Two live defects are producing or risking wrong verdicts right now. Work top to
bottom; each item states its own acceptance. Do not reorder — item 1 gates
everything (an unverified tree makes every later result ambiguous), and items 2–4
are ranked by how silently they fail.

**Standing rules apply** — paste Part 0 of `REMAINING-WORK.md` first, including the
Telegram restriction. `$0/month`. Never commit `.env` or `data/`. `promote-unlock.js`
is the only write path to `unlocks.json`. Addresses are resolved from files, never
typed. Fix blockers, log the rest.

---

## 0. Before anything

```
node test-delivery.js          # must be ALL GREEN on the current tree
node verify-tags.js            # 30 tags, each matching its own config.js
git status --short             # expect: 3 .pending files, 3 docs/briefs/*.md, replay-move-floor.js
```

If the suite is red on an untouched tree, stop and report — that is its own finding.

## 1. `detect-cadence.js ENA` — before touching the demotion

ENA demoted 2026-09-10 (`largestSeen` 5,148,798 vs bar 6,034,718, ratio 0.427). The
spec watches ONE custody wallet and the row carries two unwatched co-emitters, so the
verdict cannot distinguish a stopped schedule from a migration.

```
node detect-cadence.js ENA
```

Read the result against `alsoObserve` — `0x2146AA5807D96E6B2922a149CeE870F17347F1d0`
and `0xdeDc15Fa923D4e147875C63C0a97F85F178dfE96`. **Do not re-promote on a hunch.**
If the schedule moved to another wallet, that is a spec change through
`promote-unlock.js`, with the evidence in the event detail. If it genuinely stopped,
the demotion stands and nothing needs doing.

## 2. `routes.js` gate-input — a boot gate that passes because it read nothing

`src/core/routes.js:62` and `:77` fall back to `events = []` / `unlockTokens = []` on
a parse failure. Both feed boot assertions. A corrupt `macro-calendar.json` or
`unlocks.json` therefore makes "every tier has a reader" and "every classifier is
wired" trivially TRUE — nothing left to route or classify — and the bot starts with
the thing the gate protects entirely absent.

FIX: distinguish "file absent" from "file present and unparseable". The second must
fail the assertion and refuse boot.
ACCEPTANCE: a fixture that points the loader at a deliberately corrupt file and
asserts the assertion FAILS. It must be able to go red.

## 2b. Fixture 37's status selector is FAIL-OPEN

Cheap, and it pairs with item 2 — both are gates that pass because they failed to
recognise their own input.

`test-delivery.js:1626` selects documents with:

```js
walk2('.').filter((f) => /Status:\s*DESCRIPTIVE/.test(readFileSync(f, 'utf8').slice(0, 1600)))
```

Case-sensitive, exact-spacing. `STATUS:`, `status:`, `Status : DESCRIPTIVE` and any
stray character all escape the cite-a-fixture-per-claim discipline **silently**.
`docs/briefs/MESSAGE-FIELD-INVENTORY.md` was written with `STATUS:` on 2026-09-13 and
slipped through by typo; it has since been corrected to the convention AND given a
`## Claims` section, but correcting the file does not correct the selector. The next
variant escapes the same way.

FIX — invert it, the way the other gates already work. Parse the PREMISE of every
`.md` and validate the status against the known vocabulary, case-insensitively:

    DESCRIPTIVE · ACTIVE PLAN · REFUTED · EXECUTED · STRADDLES

(`STRADDLES` is real — `ALPHA_RADAR_BUILD_SPEC.md` uses it deliberately, per
`docs/briefs/README.md:38-40`. Omitting it from the known set would break a
legitimate file.)

Two rules, because they differ by location:
  - Every `.md` under `docs/briefs/` MUST carry a parseable `Status:` line. A brief
    with no status is not exempt — it is unfiled, and should fail.
  - Elsewhere (`README.md`, `REMAINING-WORK.md`, `CLAUDE.md`, …), a `Status:` line is
    optional, but if present it must parse. Those files carry PREMISE blocks without
    a status today and must not start failing.

Then an unrecognised value cannot exempt a document; it can only break the suite,
which is the direction you want.

ACCEPTANCE: a fixture that plants `Status: DESCRIPTIVEE` (and separately, a brief
with no `Status:` line at all) and asserts the suite FAILS naming the file. The check
must be shown to go red in the same run it passes — this is the third time a
selector has been the thing under test.

## 3. `loadWatchState` quarantine + `historyResetAt`

`cadence-watch.js:28` returns `{ months:{}, demotions:{} }` on any parse failure —
a silent, total loss of verdict history. **This already happened on 2026-09-12** (I
corrupted the file by hand-editing it; full incident in
`PENDING-cliff-cache-staleness.pending`). It also re-sent ENA's demote DM, because
`notified` was lost with everything else.

FIX: on parse failure — rename to `cadence-watch.corrupt-<ts>.json`, log
`[OPERATOR]`, write `historyResetAt` into the fresh state, and suppress demote DMs
for the first cycle after a reset.
Surface `historyResetAt` on EVERY heartbeat until an explicit operator
acknowledgement — not a timeout. Same treatment as the stale-source ladder.
ACCEPTANCE: fixture corrupts a temp state file, asserts quarantine happened, the
original is preserved, `historyResetAt` is set, and the first-cycle DM is suppressed.

Then sweep the same shape — `PENDING-silent-default-sweep.pending` ranks nine
instances. `taxonomy.js:135` is next worst: a corrupt equity-ticker file silently
empties the EXCLUDE set.

## 4. Determinism fixture — before anything re-scores

The 2026-09-12 reset accidentally re-derived EIGEN 2026-08 CONFIRM 0.976,
MOVE 2026-09 CONFIRM 2.048 / 19,376,705 and ENA 2026-09 DEMOTE 5,148,798 exactly.
That is evidence for a property the rescore design depends on and which has never
been tested deliberately.

FIXTURE: freeze one `byDay` per row shape (single, family, contract-cliff), run
`cadenceDecision` / `cliffClusterDecision` twice with a fixed `now`, assert deep
equality of the verdict objects. Then mutate one input and assert the verdict
CHANGES, so the test can go red. Pin the three live values above as the regression
case.

## 5. Cliff cache staleness — ORDER's demotion is void

`detect-cliff-cluster.js:47`: `if (c0?.done) return { covered: true, pages: 0 }`.
On 2026-09-12 the cliff watch was handed the 2026-09-05 cache and scored an empty
window by construction. **ORDER is demoted on a fetch that never ran.**

Full spec in `PENDING-cliff-cache-staleness.pending`, including the trap: the second
argument to `rangeCovers` must be the FETCH-START boundary, never the newest row
found — or a genuinely silent vault reads as uncovered and goes PENDING forever.
ACCEPTANCE: a cache whose `at` precedes the scored window must NOT satisfy the
request (`covered === false`, refetch path taken, `pages > 0`).

## 6. `annotate-verdict` write path

Hand-editing `data/cadence-watch.json` destroyed it on the first attempt. This is the
third occurrence of the hazard (regime tags v0.13.1, the outcomes.json tear v0.17,
this). `promote-unlock.js` exists so nobody hand-edits `unlocks.json`; verdicts need
the equivalent.

```
node annotate-verdict.js ORDER 2026-09-07 --void --reason "..."
```

Must validate the JSON it produces before renaming into place, refuse to run without
a reason string, and append to an audit log rather than deleting.

## 7. Void exclusion, then rescore

Exclude `void` entries from coverage counts and falsifier-strength inputs. Then the
general capability: `st.cliffs[key]` blocks re-evaluation, so **no verdict is
re-scorable** — not just this one. A correction must be recorded as a correction,
with its reason, not performed by tampering.

---

## 8. Staleness ladder gains a COVERAGE arm

Appended 2026-09-13, and it is the real product of item 0.

The ladder measures index **age**: on 09-13 it read `FRESH · 6 days · 15 left`, no
warning at any level, while SEI, APT and CARV had already gone silent because their
last listed events (09-13, 09-11, 09-10) had passed. Age and runway are different
questions and the same instrument was assumed to answer both.

FIX: warn when a ROW's last listed event is within N days, independent of file age.
**Pre-register N before choosing it** — and state the reasoning, not just the number.
Note the interaction: a row can have plenty of runway on a stale file, or no runway
on a fresh one, so the two arms are independent and both belong on the line.
ACCEPTANCE: a fixture with a fresh file and an exhausted row asserts the coverage arm
fires while the age arm stays quiet — and the mutation, a fresh file and a row with
runway, stays silent on both.

## 9. Index refresh — operational, not blocking

SEI, APT and CARV have genuinely exhausted their events and are silent. This is real,
not a fixture artefact, and it is the correct behaviour of the Part 2 instrument.

Do it AFTER the queue, via the browser-pane route. The procedure is the RECURRING
CHORE section at the top of `NEXT-SESSION.md` (the queue's earlier draft cited
`docs/briefs/INDEX-REFRESH-AND-REDUNDANCY.md`, which does not exist — `NEXT-SESSION.md`
is the real location, with the exact commands and the gzip+base64 carry).

Note when doing it: `derivePressureFloor` must be re-derived and RE-RECORDED if it
moved, or fixture 47 fails — which is the point of it.

---

## 10. Re-promotion requires POST-DEMOTION evidence

From item 1, 2026-09-13. `detect-cadence` still classifies ENA's wallet as CADENCE
after the watch demoted it — correctly, because discovery is lenient and the watch is
strict. The hazard is that re-reading pre-demotion history LOOKS like evidence.

FIX, in `promoteRow`'s gate (not a note): if the row carries an active demotion, a
promotion is refused unless its newest event post-dates the demotion AND that event
is an on-schedule emission. Re-analysis of the same history is not new evidence.
COROLLARY: the spec mean may not be re-derived from a window containing the emission
that caused the demotion. ENA's mean has already drifted 12,069,436 -> 11,972,127 on
today's scan, which would lower the bar from 6,034,718 to 5,986,063. Unbounded, that
ratchet walks the bar down to whatever the schedule is decaying to.
ACCEPTANCE: a demoted row + a promotion whose newest event predates the demotion is
REFUSED; the same row with an event after it is ACCEPTED. Mutation proves both.

---

## After the queue

`docs/briefs/MESSAGE-DIET.md` — rendering only, explicitly queued behind all of the
above. Its Part 5 fixture needs a field inventory of the current message builders
first; that inventory is being built separately and needs no shell.
