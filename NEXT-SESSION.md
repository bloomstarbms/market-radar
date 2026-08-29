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
