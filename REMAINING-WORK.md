# Alpha Radar — Prompts for Remaining Work

One prompt per session. **Paste Part 0 first, every time**, then the single step prompt you're working on. Part 0 is the standing context that stops a fresh agent from re-litigating decisions already made or reintroducing bugs already fixed.

Work them in order. Step 8 is the highest-value item remaining and everything before it is either a dependency or already queued.

> See REMAINING-WORK-NOTES.md for reconciliations against the live system
> (version drift, storage divergence) before pasting Part 0.

---

# PART 0 — STANDING CONTEXT

*Paste this at the top of every session.*

```
You are working on Alpha Radar, a crypto alert system at v0.16.3. Read
NEXT-SESSION.md and regression-fixtures.js before writing any code.

## Hard constraints — do not violate

- $0/month. No paid API. If a step appears to need one, it has a free
  path — find it or ask. DefiLlama emissions is now paywalled (HTTP 402);
  do not reach for it.
- Zero-dependency Node 22+. Storage is node:sqlite, hot state is an
  in-process Map, event bus is node:events. No Docker, no Redis, no broker.
- Database lives in %LOCALAPPDATA%\alpha-radar\ — never on a OneDrive-synced
  path. Backups are closed-file snapshots via VACUUM INTO.
- Config in JSON, hot-reloadable. Zero magic numbers in code.

## Current state

- Alert volume: 87.9/day → ~3.4/day (26.2x reduction). Budget is ≤12/day.
- Suppression stack: conviction floor → budget → 12h rolling thread TTL
  (72h absolute cap) → 2h global cooldown → per-module cooldown →
  recurrence suppression (3 fires in 14 days).
- Precision multipliers, Beta(10,10) shrinkage, recomputed hourly, gated
  at n≥100: PUMP 0.904 · DUMP 0.859 · REVIVAL 0.840 · FUNDING 0.828 ·
  VOLUME 0.815. LISTING unweighted at n=48.
- Volume baselines: median+MAD, winsorized, coverage-gated, hour-of-day
  buckets. Fires at z≥5 AND 2 consecutive windows.
- Executability gate: $25k executable at 50bps BOTH sides, spread <40bps,
  round-trip <120bps. Universe swept every 6h over USDT pairs with ≥$2M
  reported volume.
- Outcomes table: 20k cap, evict-to-archive (never evict-to-void), rows
  tagged collectedUnder = UNFILTERED | FLOORED.
- Suppressed candidates are ALWAYS logged with their reason. This is what
  makes every silencing decision reversible. Never drop a candidate before
  it is recorded.

## Six rules learned the hard way in this project

1. REPLAY BEFORE SHIPPING. Live logic is validated against data/bot.log
   (8,834 real alerts), not unit tests alone. Three production bugs looked
   correct in isolation and only failed against real sequence data.

2. PROPERTY-TEST MONOTONICITY. After ANY change to a cooldown, TTL, window
   or threshold, sweep each parameter and assert that tightening it never
   increases total pushes. Two bugs were found this way — a 72h thread cap
   defeating a 7d recurrence window, and a module-cooldown drop starving a
   thread's keep-alive.

3. AUDIT EARLY RETURNS. Four bugs shared one shape: a suppression path
   returning early without updating shared state. Any new early return must
   declare what state it skips and why that's safe.

4. THREE-STATE HONESTY. Every data-dependent module reports verified /
   estimated / unverifiable. Estimated is logged and ranked but NEVER
   alerted. Modules degrade to silence, not to guessing. No imperative
   ("close now", "exit here") is ever attached to an unverified input.

5. GATE BEFORE YOU INVEST. Run the cheap filter before the expensive work.
   Intersecting the executability gate with the unlock list dropped 20 of
   32 tokens from a hand-integration queue in one set operation.

6. UNITS DISCIPLINE. Never apply thresholds calibrated for one denominator
   to a different one. `pressure_vs_book` is not comparable to §4.2's
   ADV-based bands and carries no severity until ADV matures.

## Definition of done for any step

- Replayed against bot.log with before/after push counts reported
- Monotonicity property test passing across all suppression parameters
- Suppressed candidates still recorded with reason
- Any new permanent fixture added to regression-fixtures.js
- Funnel counts printed with each pass
- Prediction pre-registered before measurement, and stated falsification
  lines honoured when the number comes in outside them
```

---

# STEP 6 (finish) — On-chain vesting reads

```
Complete the unlock module by replacing estimated dates with contract-read
dates for the 12 gate-passing tokens: SUI, ENA, TIA, ARB, INJ, SEI, APT,
JUP, OP, STRK, ZRO, EIGEN.

Order: EIGEN first (only verified numerator), then STRK and ARB
(Ethereum-family, free eth_call via the existing Etherscan key).

## Cheap triage pass FIRST — before any 30-minute integration

For each token, classify the vesting arrangement:
  A. OpenZeppelin VestingWallet / TokenVesting  → clean read, ~15 min
  B. Sablier / LlamaPay stream                  → subgraph read, ~15 min
  C. Custom project contract                    → bespoke, 30+ min
  D. Multisig-held, off-chain schedule          → NOTHING TO READ

Bucket D tokens get status `unverifiable` and permanent silence, unless a
project-announced date exists in docs, governance forum or blog — that is
a legitimate `verified` path via events[].source: 'announcement', and it is
minutes of reading rather than half an hour of integration.

Expect roughly half to land in bucket D. Discover that in an hour of
triage, not three tokens into hand-integration.

## Read protocol — all five points, non-negotiable

1. ENUMERATE THEN SUM. Projects have multiple vesting contracts (team,
   investors, ecosystem, foundation), each with its own cliff. Reading one
   gives a fraction of the unlock and a confidently wrong number. Sum
   across all of them, split by recipient type — VC and team allocations
   sell at very different rates than ecosystem ones.

2. BACKTEST BEFORE TRUSTING FORWARD. Take a cliff date the contract says
   already passed and verify tokens actually moved on-chain that day. If
   the contract says a cliff happened and nothing moved, you read the wrong
   contract or misread the units. Reading a contract correctly and reading
   the RIGHT contract are different claims; only replay against history
   distinguishes them.

3. DECIMALS. Raw uint256 without dividing by 10^18 is a quintillion times
   too large and will look plausible next to a pressure ratio already in
   the hundreds. Assert the result against circulating supply as a bound.

4. SHIP DATES NOW, SEVERITY LATER. The contract read gives the date; ADV
   accumulation gives the severity. Independent — do not hold the
   integration for the 30-day wait. Ship with pressure_vs_book as an
   ordinal rank only, no severity bands.

5. RE-READ IF UPGRADEABLE. Vesting schedules are static once read unless
   the contract is upgradeable. Check, and if it is, re-read on a schedule
   rather than caching forever.

## Alert schedule per §4.2 — once each, deduplicated, never daily cron

T-14d (only if pressure is significant) · T-3d · T-0 (confirmed on-chain)
· T+3d (did recipients actually sell — this closes the loop)

## Acceptance

- Each of the 12 carries an explicit bucket classification
- Every `verified` date has a passing backtest against a prior cliff
- Decimals assertion in place, bounded by circulating supply
- Module still prints "N tracked · M estimated-only (silent)" each pass
- No severity band applied to pressure_vs_book anywhere
```

---

# STEP 7 — Liquidation cascade + perp-spot basis

```
Two detectors, both free from exchange public endpoints. Funding already
exists; these do not.

## Liquidation cascade

Sources: Binance !forceOrder@arr, Bybit allLiquidation, Hyperliquid.
Under REST polling these are partially available; note the gap honestly
rather than pretending to streaming coverage.

CASCADE_ACTIVE:
  liquidation_notional_1m >= max($2M, 10x trailing_median_1m)
  AND same_direction_share >= 75%
  AND price_move_1m >= 1.5 * ATR_1m

CASCADE_EXHAUSTION — the tradable one:
  was ACTIVE within last 15m
  AND liquidation_rate now < 20% of peak
  AND no new price extreme for 3m
  AND OI dropped >= 8% from pre-cascade
  → mean-reversion setup, horizon 30-120m

Cascades are EVENTS, not state. Do NOT apply the persist=2 rule here — two
windows costs 10 minutes and the setup is gone. Persistence belongs on
volume and bleed, not on cascades and listings.

Also build the liquidation heatmap: estimated leveraged position clusters
by price level, derived from OI-change-at-price. Self-computed, no
Coinglass. Alert when spot comes within 1.5% of a cluster >$20M.

## Perp-spot basis

Annualized basis > +25% (contango) or < -10% (backwardation) on a
gate-passing asset is a standalone signal and a cash-and-carry setup.
Compute from mark vs index on the same venue, and report cross-venue
dispersion — if one venue diverges, that's venue-specific positioning,
not market-wide.

## Acceptance

- Replay against bot.log: report how many historical dumps would have been
  reclassified as CASCADE_EXHAUSTION rather than bare DUMP alerts
- Pre-register expected cascade frequency before measuring
- Monotonicity test passes with the new parameters included
- Heatmap clusters validated against at least one known historical squeeze
```

---

# STEP 8 — Conjunction scoring (highest-value remaining item)

```
This is the fix for the largest structural failure in the original system,
and the reason FUNDING currently clears a tier on its own despite a 41%
win rate.

The original feed emitted HYPER's funding setup at 08:39 and its own
+16% resolution at 10:28 as two unrelated messages 109 minutes apart. It
called the setup, reported the outcome, and never connected them. Same for
MANTRA (pump 11:04, funding 12:04) and VIC (1h grind and 5-venue
confirmation, same minute, two messages).

Single-factor alerts on this universe have near-zero precision. The edge
is entirely in the conjunction.

## Build

Maintain a rolling SymbolState per asset holding all live signals within a
4-hour decay window.

score = Σ (signal.strength
           × MODULE_WEIGHT[module]
           × precision_multiplier[module]   // already exists, reuse it
           × venue_trust
           × time_decay(age, half_life=45min)
           × direction_agreement)
        × CONJUNCTION_BONUS
        × liquidity_multiplier
        × regime_multiplier

CONJUNCTION_BONUS: 1.0 / 1.6 / 2.4 / 3.5 for 1 / 2 / 3 / 4+ INDEPENDENT
modules agreeing on direction.

Independence matters and is the part most likely to be got wrong. Two
volume-derived signals are not two signals. Group modules into families —
flow, positioning, price, catalyst, onchain — and only count agreement
ACROSS families. Same-family agreement adds nothing.

direction_agreement must be NEGATIVE when modules conflict. Conflicting
signals lower the score; they do not average to neutral.

regime_multiplier: momentum down-weighted in high-realized-vol chop,
mean-reversion up-weighted. Compute regime from BTC realized-vol
percentile and trend strength.

## The point of this step

A single-factor FUNDING signal should NOT clear any tier. Verify that
directly: after this lands, assert that no alert in the bot.log replay is
pushed on one module alone. If bare FUNDING still pushes, the weights are
wrong.

## Tiers — recalibrate, do not hand-tune

A-TIER ≥85 (~1/day) · B-TIER 70-84 (~3/day) · C-TIER 55-69 (digest only)
· RISK (any score, always pushed, bypasses budget)

Recalibrate monthly against realized outcomes. If A-tier is not measurably
outperforming B-tier, the tiers are decorative and the scorer is wrong.

## Acceptance

- HYPER, MANTRA and VIC from bot.log each collapse to ONE composite alert
  instead of two unlinked ones. These are your fixtures — add them to
  regression-fixtures.js.
- Zero single-module pushes in the replay
- Monotonicity holds with conjunction parameters included
- Push count reported before and after
```

---

# STEP 9 — Upbit detectors 3 & 4 + kimchi premium

```
Two of four listing detectors already exist (announcement polling, symbol-
set diffing). Add the two earlier ones, plus the premium gauge.

## Detector 3 — WebSocket subscribe-probe

Attempt to subscribe to candidate symbols not yet listed. A successful
subscription, or a changed error code, reveals provisioning before the
notice publishes.

## Detector 4 — Infrastructure precursors

Often the earliest tell of all: deposit address generation, wallet-status
endpoint changes for the asset, and on-chain movement into known Upbit
cold/hot wallets. Reuses the label set from step 10 — sequence accordingly
or stub the labels.

## Kimchi premium

premium = UPBIT_KRW_price / (global_USD_price × USDKRW)

Use Upbit's own USDT/KRW pair as the FX rate — self-consistent, and avoids
an external FX dependency.

  > +4%  Korean retail euphoria; local-top tell on the asset, and at index
         level on the market
  < -2%  Korean capitulation, often a local bottom
  Rapid single-asset expansion (>2% in 1h) — highest-value use, frequently
         accompanies or precedes an Upbit-driven move

STATE THE CAVEAT IN THE MESSAGE: KRW capital controls make this not
directly arbitrageable for most users. It is a sentiment gauge, not a
trade. Say so in the alert so nobody tries.

## Design honesty

A human cannot beat colocated bots to the first tick. Build for the two
edges a human actually has:
  - THE RETRACE. Listing pops routinely round-trip 40-70% of the initial
    spike within 60 minutes. The tradable setup is the fade or the
    post-flush entry, not the pop.
  - PRE-POSITIONING. Maintain a scored candidate watchlist: listed on
    Bithumb/Coinone but not Upbit, Korean-language community activity,
    recent Korean regulatory steps, new "caution" designations.

Also track DELISTING notices — the mirror trade, far less crowded.

## Reminder

LISTING bypasses the budget and is still unweighted at n=48. It is the
most-privileged, least-measured module in the system. Flag the moment it
crosses n=100 and apply the precision multiplier.
```

---

# STEP 10 — Exchange netflow + self-maintained label set

```
Replaces the deleted whale module. Individual transfers are not economic
events; net exchange flow is.

## Label set (§2.1.2)

Versioned JSON in the repo. Seed from Etherscan public address labels and
community exchange-address lists. Target the top ~10 exchanges across
Ethereum, BSC, Base, Arbitrum, Solana. Extend as recurring counterparties
are observed.

Anything not in the set is UNLABELLED, and unlabelled counterparties
produce no alert. That default is what kills the EIGEN and ZRO spam
(240 and 399 alerts respectively in bot.log).

Smart-money wallet PnL scoring is OUT OF SCOPE — no free equivalent exists.
Do not attempt to approximate it.

## Detectors

EXCHANGE_INFLOW_SPIKE (sell pressure):
  net_inflow_1h >= max($5M, 3% of circulating_mcap)
  AND robust_z(net_inflow_1h, 90d) >= 3.0
  AND source NOT IN {known_mm, custodian, bridge, treasury, staking,
                     self_owned_cluster}

EXCHANGE_OUTFLOW_SPIKE: symmetric, plus sustained >= 3 consecutive hours.

Individual transfers survive ONLY if directional (exchange↔wallet, never
wallet→wallet, never exchange→same-exchange), material (>=2% of circulating
or >=3x 24h executable liquidity), attributed (counterparty in the label
set), AND novel (no similar transfer from that cluster in 7 days).

## Critical

Every threshold printed must be an expression that ACTUALLY EVALUATES to
the shown number. The original system printed
`min($1.00M, 20% of $0.00) = $1.00M`, which is a null-fallback silently
inverting the stated formula. If liquidity is zero or unknown, SKIP — do
not fall back to a constant.

## Acceptance

- Replay bot.log's 954 whale alerts: report how many survive. Expect
  single digits.
- Whale reference price backfill (already shipped) means these are now
  scoreable — confirm outcome rows are being produced.
- Property test over 10,000 randomized inputs including zero, null and
  negative liquidity: every printed expression evaluates correctly.
```

---

# STEP 11 — Spot momentum + DEX revival, re-enabled

```
Last, and most gated. Both currently silent — REVIVAL self-silenced via
precision weighting (42% win, -0.6% median alpha), VOLUME scores 42-50 and
never clears.

## Do not simply un-silence them. Rebuild the signal.

VOLUME's problem is not its threshold — it is that "unusual volume, price
flat → accumulation OR distribution" is unfalsifiable by construction. It
never committed to a direction, so it cannot be scored. Scoring 42-50 is
the system working correctly.

Rebuild it as DIRECTIONAL:
  buy_side_aggressor_share >= 65%
  AND orderbook_imbalance_top10 >= 1.5
These two conditions are what separate a real move from a market maker
pulling a bid. The original had neither, which is why a -30% MEXC print on
a $500k book was reported as market information.

## Momentum gate

  executability_gate == PASS
  AND venue_trust_effective >= 0.70
  AND price_change_5m >= 8%
  AND volume_z(5m) >= 5.0 AND volume_5m_usd >= $250k
  AND NOT in_cooldown(symbol, 6h)
  AND buy_side_aggressor_share >= 65%
  AND orderbook_imbalance_top10 >= 1.5
  AND (multi_venue_confirmed OR is_major_venue)

## Sell-off alerts

Never fire a bare "selling off" alert on an asset not held. A -25% move on
an illiquid book is not a short entry — borrow is unavailable or ruinous
and the move is over. Fire only when: the symbol is held (needs the
position-awareness work), OR it is a cascade-exhaustion setup, OR it is a
major with a real macro or on-chain cause attached.

## DEX revival

Rug screen already exists and is blocking. Add:
  volume_z_1h >= 4.0
  AND unique_buyers_1h >= 3x baseline   // UNIQUE FUNDED ADDRESSES
  AND buyer_to_seller_address_ratio >= 1.5
  AND liquidity_change_1h >= -5%        // LP not being pulled into a rise
  AND NOT bundled_launch_pattern

Use unique buyer addresses with independent funding sources, NOT txn count.
The original printed "1967 txns/h vs 197.6 avg" — txn count is trivially
inflated by one wash bot looping.

## Before re-enabling

The passive calibration set has been accruing blocked-DEX verdicts with
forward outcomes since v0.13.1. Query it. If blocked candidates
subsequently performed well, the screen is over-blocking and that is now
measurable rather than speculative. Report the number before changing any
threshold.
```

---

# STEP 12 — VPS migration (decision, then work)

```
This is an UPTIME problem, not a cost problem. WebSockets are free; nine
persistent connections need a machine that does not sleep. ~$5/month.

Only start this after steps 6-11 ship. Nothing in them requires it.

## What it buys

- Persistent WS to nine venues, replacing REST polling
- Real-time liquidation feeds (step 7 is degraded without this)
- p99 <3s delivery for tier-A and listing alerts
- No OneDrive proximity, no sleep interruptions

## What it does not buy

Any data you do not already have. Do not bundle a paid API decision into
the VPS decision — see Appendix A of the build spec.

## Migration

The transport abstraction already exists:
  RADAR_TRANSPORT = 'poll' | 'stream'
Flip the flag; do not rewrite collectors. If flipping it requires touching
detector code, the abstraction leaked and that is the bug to fix first.

Acceptance: run both transports in parallel for 48h against the same
detectors and assert identical alert sets, modulo latency.
```

---

# CROSS-CUTTING — Do these when the dependency lands

## A. Full trade payload in messages

```
The message schema currently prints tier, conviction, why-now, data age.
It does not print the trade.

Add: entry range, invalidation level (with the structural reason), T1/T2
targets, expected horizon, executable size at 50bps, and suggested position
size derived from invalidation distance and configured risk-per-trade.

Without these an alert is not actionable even in principle. Depends on the
executability gate (shipped) and conjunction scoring for horizon estimates
(step 8).
```

## B. Position awareness

```
Read-only exchange API keys or a manual position list.

Unlocks: sell-off alerts fire only on held assets · unlock and macro
warnings prioritized by actual exposure · portfolio-level liquidation risk
across venues · and the CORRELATION WARNING — if long 6 correlated
low-float alts, say that this is one position, not six. The original feed
would have led straight into exactly that concentration.
```

## C. Weekly performance report

```
This is what finally lets an alert print a track record instead of
`insufficient sample`. Gated at n>=100 per module.

Weekly to the channel: alerts by tier with hit rate, median return and
expectancy · by module, best and worst · and ACTIONS TAKEN, e.g. "module X
below 40% precision for 3 consecutive weeks → threshold raised".

Closed-loop adaptation: modules under 40% precision for 3 weeks auto-tighten,
auto-disable at 4 weeks with operator notice. Muted alerts are labelled
negatives. Score→outcome calibration curve regenerated monthly.

Guard against overfitting: hold out the most recent 20%, require n>=100
before acting on any statistic, walk-forward not in-sample.

Note the regime mixture: the corpus spans UNFILTERED (pre-floor, everything
pushed) and FLOORED (post-floor, mixed) sampling. Multipliers will drift for
sampling reasons, not performance reasons. Weight or separate by
collectedUnder.
```

---

# SUGGESTED SESSION ORDER

| Session | Work | Why here |
|---|---|---|
| 1 | Backup verify + GitHub push v0.9.4→v0.17.0 | Seven+ versions on one disk |
| 2–3 | Step 6 — vesting reads | Triage first, expect half in bucket D |
| 4 | **Step 8 — conjunction scoring** | Highest value; do not defer further |
| 5 | Step 7 — cascade + basis | Feeds conjunction with new families |
| 6 | Step 10 — netflow + label set | Step 9's detector 4 depends on labels |
| 7 | Step 9 — Upbit 3 & 4 + kimchi | |
| 8 | Cross-cutting A — trade payload | Now has horizons from step 8 |
| 9 | Step 11 — momentum + DEX, rebuilt | Query the calibration set first |
| 10 | Cross-cutting C — weekly report | ~n=100 should be reachable |
| later | Step 12 — VPS · Cross-cutting B — positions | |

**Step 8 is out of build-order on purpose.** It is the difference between a
feed of single-factor alerts and one that only speaks when several
independent things agree — and every module added after it inherits the
benefit. Every session it waits is a session of detectors tuned against the
wrong target.
