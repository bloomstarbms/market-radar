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
