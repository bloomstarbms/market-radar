<!-- PREMISE
Written against: v0.32.0
Reviewed: 2026-09-18
Assumes:
- Written at v0.32.0 (739 checks). The tree that migrates is whatever config.js
  says at cutover — v0.32.4, 821 checks, on 2026-09-20. Step 0 re-verifies.
- boot-check.js is the only sanctioned way to make a tree copy; config.js refuses
  to load in a marked copy with a real token.
- CLAUDE.md carries the Telegram restriction and the agent ownership split; it
  travels with the clone and applies on the VPS.
- PUSH-TO-GITHUB.bat self-verifies (origin/main == HEAD, all tags), tags only on a
  version change, aborts on a stale index.lock.
- The launcher preflight is PARKED on Windows because batch is untestable from the
  sandbox. On the VPS it becomes systemd ExecStartPre — native, no batch.
- DefiLlama returns 403 to the desktop (IP-class). Whether the VPS is also blocked
  is UNKNOWN and is the smoke test's most important question.
- The Cowork session cannot SSH. Claude Code can. Claude Code runs this.
- Uptime is not the reason. Measured 88% clean-era on the desktop with sleep-never
  on AC and DC; stage/event redundancy means a missed stage is not a missed event.
  The case is INDEPENDENCE (the desktop also runs the infoxchange bot) and future
  STREAMING. Recorded as a decision, not a necessity.
Status: EXECUTED 2026-09-25 — cutover complete, see "Step 6 result" below. Historical only.
Supersedes: /VPS-MIGRATION.md at root (v0.24.5) — mark that file SUPERSEDED, do not
delete; its timing reasoning is history worth keeping.
-->

# VPS Migration — v0.32.0 tree

*Read `CLAUDE.md` first. Paste Part 0 of `REMAINING-WORK.md`. Claude Code runs this;
the operator drives the box.*

---

## Division of labour

| Who | What |
|---|---|
| **Operator** | Provision, SSH in, run the commands Claude Code gives, paste output back |
| **Claude Code** | Step 0 on the desktop; reads every pasted result; owns the desktop half of cutover (stop bot, uninstall autostart, decommission) |
| **Cowork session** | Nothing. It cannot SSH. This brief exists so it doesn't have to. |

Steps 1–4 are reversible — a bad box gets destroyed and re-provisioned.
**Step 6 is irreversible** and gets a second reader on every pasted result.

---

## Step 0 — Desktop: current tree, verified push

```
node boot-check.js            # suite + --once boot on a copy, token stubbed
node verify-tags.js           # every tag matches its config.js
PUSH-TO-GITHUB.bat            # self-verifies; no bump → no tag move
git status --short            # expect: clean, or docs/briefs only
```

If `boot-check.js` is red, stop. The tree that migrates must be the tree that passes.

The repo has been a disaster-recovery copy since Aug 25. Confirm it still is:
`git log -1 origin/main` must match `src/config.js`'s version.

## Step 1 — Provision and harden

- Ubuntu 24.04, smallest tier (1–2 GB), **Frankfurt or Amsterdam**. Not US — Binance
  geo-blocks datacenter ranges there.
- UTC for the BOT — macro stages, digest windows and the source-staleness ladder
  all assume it. On a dedicated box, `timedatectl set-timezone UTC`; on a shared
  box, `Environment=TZ=UTC` in the unit only (see "Step 1 as found").
- Node 22+: `node --version` must print 22 or higher. Built-in `fetch` is required.

**Same day, before anything else lands on the box:**

```
# key-only SSH — verify in a SECOND terminal before closing the first
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw enable
```

The box will hold the Telegram token and three API keys. Password login off.

### Step 1 as found — 2026-09-21 (the box already existed)

Operator's paste, read before anything was written: Contabo, Germany (EU);
Ubuntu 22.04; **Node 20.20.2**; **timezone Europe/Berlin**; root login by password;
up since Sep 9; `ifconfig.me` returned an **IPv6** address. And a **neighbour**:
`pm2-root.service` running, `node /root/pump` listening on localhost — another bot,
under PM2, as root. Step 9's rule applies on this side too. Three steps change:

- **Node — do not upgrade the system Node.** pump runs on 20 and may depend on it.
  Install 22 for the `radar` user only (official nodejs.org tarball, checksum-verified, unpacked under /home/radar — one fixed path, no version manager), and the unit uses the ABSOLUTE path:
  `ExecStart=/home/radar/node-v22.12.0-linux-x64/bin/node src/index.js`, and
  `preflight.sh` calls the same absolute binary (a bare `node` in ExecStartPre
  resolves to system 20). `Environment=PATH=/home/radar/node-v22.12.0-linux-x64/bin:/usr/bin:/bin`.
- **Timezone — do not change the system clock.** pump's logs and schedules are on
  Berlin time. The radar unit gets `Environment=TZ=UTC`; the bot sees UTC, the box
  does not change. Verify from inside: `journalctl -u market-radar` shows the
  18:00 UTC heartbeat at 18:00, not 20:00.
- **PM2 — leave it alone.** radar runs under systemd, its own user, its own unit
  name. Two process managers on one box are fine while neither touches the other's
  processes. `ufw` rules must leave pump's listener as it is (it is localhost-only
  per `ss`; confirm with `ufw status` before `default deny incoming`).

**Hardening order on a shared box:** key login confirmed in a SECOND terminal before
password auth is turned off. A lockout here costs two bots, not one.

**Smoke test, twice.** An IPv6-first box can get different answers from APIs that
geo-resolve or serve IPv4 only. Run the Step 2 loop as written, then again with
`curl -4`. Any line where the two runs disagree is a finding, recorded with both
codes. Before it: `ufw status`, `pm2 list`, `curl -4 -s ifconfig.me; curl -6 -s ifconfig.me`.

## Step 2 — Reachability smoke test — HARD GATE

Run from the VPS. Every endpoint the bot polls. **Any exchange FAIL → destroy the
box, re-provision in the other EU region, re-run.** Do not proceed on a partial pass.

```
for u in \
  https://api.binance.com/api/v3/ping \
  https://fapi.binance.com/fapi/v1/ping \
  https://api.bybit.com/v5/market/time \
  https://www.okx.com/api/v5/public/time \
  https://api.upbit.com/v1/market/all \
  https://api.bithumb.com/public/ticker/BTC_KRW \
  https://api.kucoin.com/api/v1/timestamp \
  https://api.gateio.ws/api/v4/spot/currencies \
  https://api.mexc.com/api/v3/ping \
  https://api.bitget.com/api/v2/public/time \
  https://api.dexscreener.com/latest/dex/search?q=eth \
  https://api.geckoterminal.com/api/v2/networks \
  https://api.gopluslabs.io/api/v1/supported_chains \
  https://eth.blockscout.com/api/v2/stats \
  https://api.etherscan.io/api?module=stats\&action=ethprice \
  https://api.llama.fi/protocols \
  https://defillama.com/unlocks \
  https://cryptorank.io/token-unlock \
  https://api.telegram.org \
; do printf '%-60s ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 "$u"; done
```

**Read `defillama.com/unlocks` specifically.** The desktop gets 403. If the VPS
gets 200, the index refresh becomes automatable and the sourced tier's standing
dependency closes. If the VPS also gets 403, the browser-pane refresh remains the
route and the VPS changes nothing about it — record which, either way. This is the
single most consequential line in the test.

### Step 2 result — 2026-09-23, box 84.247.179.76 / 2a02:c207:2323:4644::1

Run twice (default stack, then `curl -4`); the nineteen lines were IDENTICAL between
runs — no v4/v6 disagreement. `ufw` was inactive; `pm2` runs `pumpgrad-bot` (root,
11 days, 0 restarts).

- **Every exchange and chain endpoint: 200** (Binance spot + futures, Bybit, OKX,
  Upbit, Bithumb, KuCoin, Gate, MEXC, Bitget, DexScreener, GeckoTerminal, GoPlus,
  Blockscout, Etherscan, api.llama.fi). The geo-block concern is CLOSED. Telegram
  root 302 is the docs redirect; the bot uses `/bot<token>/…`, not the root.
- **`defillama.com/unlocks`: 403 — the headline lands on the 403 side.** Same as the
  desktop and the sandbox; `fetch-unlock-index.js` loads that exact page. The index
  refresh stays manual via the browser pane; the VPS changes nothing about it. The
  coverage arm and the RECURRING CHORE stay as written.
- **CryptoRank: the test line was wrong, then the right one was also 403.** The list
  above probes the HTML page; the code reads `api.cryptorank.io/v0/app/
  consolidated-vesting` with a browser UA + referer. Appended and re-run: 403 on v4
  AND v6 — and 403 from the sandbox the same hour, which fetched it successfully on
  2026-09-07 (81 protocols). So this is not the VPS: the keyless endpoint has closed
  (or now blocks datacenter ranges generally). NOT migration-blocking — the bot never
  fetches CryptoRank at runtime (`loadSecondIndex` reads the file; the file travels by
  scp) — but the second index is 16 days old with no working refresh route. Recorded
  as an open item after migration: the `sourceAgreement` overlay is comparing against
  a 7 Sep snapshot until a route exists, and its line should say the snapshot's age.

Hard gate: PASSED. Proceed.

## Step 3 — Clone

```
git clone <repo> ~/market-radar
cd ~/market-radar
node --version                # 22+
ls CLAUDE.md                  # the restriction travelled
```

No `npm install` — zero dependencies by design. If anything asks for one, stop.

## Step 4 — systemd, with the preflight where it belongs

`/etc/systemd/system/market-radar.service`:

```ini
[Unit]
Description=Market Radar
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=radar
WorkingDirectory=/home/radar/market-radar
Environment=NODE_ENV=production
Environment=TZ=UTC
# Absolute Node 22 (nvm, radar user) — system Node is 20 and belongs to the neighbour.
Environment=PATH=/home/radar/node-v22.12.0-linux-x64/bin:/usr/bin:/bin
ExecStartPre=/home/radar/market-radar/preflight.sh
ExecStart=/home/radar/node-v22.12.0-linux-x64/bin/node src/index.js
Restart=on-failure
RestartSec=15
StandardOutput=append:/home/radar/market-radar/data/bot.log
StandardError=append:/home/radar/market-radar/data/bot.log

[Install]
WantedBy=multi-user.target
```

`preflight.sh` — the parked Windows patch, in a language that can be tested:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
NODE=/home/radar/node-v22.12.0-linux-x64/bin/node   # same binary as ExecStart; never bare `node`
"$NODE" --version | grep -q '^v22' || { echo "[PREFLIGHT][OPERATOR] wrong node: $("$NODE" --version)" >> data/bot.log; exit 1; }
# 1. syntax — every source file
find src -name '*.js' -print0 | xargs -0 -n1 "$NODE" --check
# 2+3. module-scope AND the four boot gates — `--preflight` (v0.32.5, fixture 68):
#    loads state read-only, runs admit/tier-route/classifiers/pagination gates, prints
#    the banner, exits 0. No Telegram, no poll, no write. Real token: the guard in
#    config.js is what refuses a marked COPY, not the live tree, so this runs on the
#    live tree with the live .env and still cannot send — it never reaches startBot().
"$NODE" src/index.js --preflight \
  || { echo "[PREFLIGHT][OPERATOR] boot gates refused — see above" >> data/bot.log; exit 1; }
```

Three layers, stated. `--check` catches syntax; `--preflight` catches module-scope
ReferenceErrors (the import) and gate refusals (the four self-tests); function-body
errors past the gates are the suite's job. **The first draft of this file imported
`src/index.js?preflight=1` — a query nothing read. `index.js` calls `main()` on
import, so that "dry import" would have started the bot inside ExecStartPre and hung
the unit; a `--once` substitute would have polled and marked cooldowns the real
instance then honours. Caught by reading the source before writing the unit; the
flag was added and fixture 68 proves it reads nothing, writes nothing, sends
nothing, and exits 1 on a corrupt unlocks.json.** A preflight that claims more than
this is the guard-whose-stated-coverage-exceeds-its-real-one class.

`StartLimitBurst=5` in 600s: the boot gates `exit(1)` by design, and bare
`Restart=always` would reproduce `run-hidden.bat`'s unbounded loop — infinitely,
unattended. `Restart=on-failure` plus the burst limit means five refusals in ten
minutes stops the unit and leaves a `systemctl status` that says why.

**Do not enable the unit yet.** Data isn't there.

## Step 5 — Data: what moves, what doesn't

Copy at cutover, not before — a copy taken now goes stale the moment the desktop
bot writes again.

**Moves** (`scp -r` from the desktop):

```
.env
unlocks.json  watchlist.json           # root-level data; git copies LAG local edits
data/state.json
data/outcomes.json
data/cadence-watch.json  data/cadence-report.json
data/cliff-cluster-report.json  data/cliff-fetch-cache.json
data/verdict-annotations.json          # if present
data/chain-resolution.json  data/resolution-map.json
data/restore-drill.json  data/source-recheck.json
data/unclassified.json  data/excluded-symbols.json
data/equity-tickers.json  data/announcement-vocab.json
data/macro-calendar.json  data/gate-universe.json
data/unlock-index.json  data/unlock-index-cryptorank.json
data/curated-index.json  data/top250-index.json  data/scan-queue.json
data/falsifier-strength.json  data/bulk-scan-state.json
data/vesting-discovery.json           # added 2026-09-25: read by promote-unlock.js / detect-cliff-cluster.js (tool input, not bot input)
data/backups/
```

**Stays on the desktop — do not copy:**

```
data/outcomes.json.conflict-*.json     # OneDrive conflict copies — resolve or archive, never migrate
data/outcomes.torn.json                # the v0.17 incident, kept as history
data/outcomes.backup.json  data/outcomes.pre-regime.json
data/*.bak.json                        # index backups from the 7 Sep refresh
data/state.json.*.tmp                  # in-flight temp — a live write, not data
data/bulk-scan.lock                    # a lock file is a claim about a process that won't exist there
data/bulk-scan-state.*-2026-*.json     # historical scan snapshots
data/bot-snapshot.log  data/bot.log    # the VPS starts its own log
```

A conflict copy or a `.tmp` migrated to the VPS is the lost-update class arriving on
a new machine. The list above is what `data/` looks like after a month of OneDrive;
the box should start with only the files the bot reads.

## Step 6 — Cutover — STRICT ORDER

Two live instances double-post to the channel, race `state.json`, and fight over
Telegram `getUpdates` with 409 conflicts. The order exists to make that impossible.

```
DESKTOP  1. FORCE-RESTART.bat is NOT the tool — stop the bot: close the run-hidden
            window, confirm no node process: tasklist | findstr node
         2. UNINSTALL-AUTOSTART.bat — removes market-radar.vbs from Startup.
            DO NOT touch start-bot-on-boot.vbs — that is the infoxchange bot.
         3. Confirm: dir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
            shows no market-radar entry
         4. scp the Step-5 "moves" list to the VPS — NOW, so the freshest state wins

VPS      5. node restore-drill.js
            The functional check — modulePrecision() and moduleExpectancy() off the
            copied rows, within 0.02 of the desktop's last heartbeat figures.
            PASTE THE OUTPUT. This is what "the migration didn't corrupt anything"
            means, and it is the reason the second reader exists.
         6. node boot-check.js
            Suite + --once boot on a copy, token stubbed by construction.
            PASTE THE OUTPUT. Four gates OK or stop.
         7. sudo systemctl enable --now market-radar
         8. journalctl -u market-radar -n 40
            PASTE. Expect the banner of whatever src/config.js says on the
            desktop at cutover (v0.32.4 as of 2026-09-20 — four releases landed
            after this brief was written), four gates OK, pollers scanning,
            "telegram ON". A banner that does not match the desktop's config.js
            means the wrong tree was cloned.

DESKTOP  9. Nothing. Never start it again. Step 9 below finishes the decommission.
```

Between 1 and 7 there is no bot. That gap is the cost of not having two. Keep it
short; do not do anything else in it.

### Step 6 result — 2026-09-25, cutover EXECUTED (Claude Code, one session, 05:30–05:55 UTC)

**Step 0 (desktop):** verify-tags — all 39 tags match their config.js; boot-check —
suite 827 PASS / 0 FAIL, banner v0.32.5 telegram OFF, four gates OK; origin/main ==
HEAD (cfa2343, v0.32.5).

**Steps 3–4:** the 23 Sep clone was already v0.32.5; reset to origin/main to be sure.
`preflight.sh` and the unit installed exactly as written above; `systemd-analyze
verify` clean; unit left disabled until the data landed.

**Desktop stop:** the run-hidden loop (cmd 15532) then node 32032, by PID; no
node.exe left; `Startup\market-radar.vbs` removed; `start-bot-on-boot.vbs` and
`start-infoxchange-bot.bat` untouched. The FIRST stop attempt failed on a PowerShell
regex and the copy ran with the bot still live — caught by the process listing, bot
stopped, copy re-run. The checksums below are from the second copy.

**Data:** tar-over-ssh of the Step 5 "moves" list plus `data/vesting-discovery.json`.
sha256 identical desktop/VPS: state.json e1ffcaa1…, outcomes.json 563061f9…,
unlocks.json 00c1416e…. Nothing from the "stays" list arrived (no .tmp, no conflict
copies, no lock). Extracted as root, `chown -R radar:radar`, `.env` mode 600.

**6.5 restore-drill on the VPS:** 7593 rows, 70.5d, precision drift 0.0113,
expectancy drift 0.0604 — one FAIL (expectancy > 0.02, REVIVAL). The desktop's own
run minutes earlier produced the SAME FAIL WITH THE SAME FIGURES: 20h of live rows
past the 24 Sep snapshot plus the REVIVAL ladder flip that night. Identical figures
on both machines is the proof the copy is intact; the FAIL is pre-existing and
clears with the next snapshot (already written on the VPS at 05:49Z).

**6.6 boot-check on the VPS (Node 22.12.0, radar user):** suite 827 / 0 ALL GREEN,
banner v0.32.5 telegram OFF, four gates OK. `preflight.sh` dry run: exit 0,
"[preflight] v0.32.5: four gates OK — not starting".

**6.7–6.8:** `systemctl enable --now market-radar` at 05:48Z. ExecStartPre exit 0;
main PID runs as radar under the Node 22 path; `data/bot.log`: "Market Radar
v0.32.5 starting · poll 60s · minSev LOW · telegram ON · cex [binance, mexc, bybit,
gate, kucoin, bitget] · whale evm solana", "[telegram] bot polling started", pollers
scanning, "[backup] daily snapshot written" for 2026-09-25 in the first cycle,
state.json being rewritten each cycle. pumpgrad-bot untouched (online, 0 restarts).
Gap between desktop stop and VPS start: about 12 minutes.

**Findings, first hour (both absent from the desktop's recent log):**

- `[whale] arbitrum: moralis key rejected — disabled this run` — NOT a VPS property.
  The endpoint answers 401 on v4 and v6 with "Your Moralis Free usage is paused.
  Upgrade to a paid plan". Account-side. The EVM-alt whale path is dark until the
  Moralis plan is resolved or the source is replaced. **Operator item.**
- `[macro][OPERATOR] calendar verification fetch failed (bls 403)` — IS a VPS
  property: bls.gov 403 on v4 and v6, datacenter block, same class as DefiLlama.
  Calendar unaffected (hand-entered); its re-verification joins the browser-pane
  chores. (Correction, same day: the verifier is weekly, so that was one line a
  week, not noise. v0.32.6 replaced it — parsed Fed/BEA checks from the VPS, BLS
  kinds "unchecked" and loud only when near and unstamped. And the old verifier had
  been RIGHT for weeks: five calendar dates were wrong. See the 2026-09-25 v0.32.6
  entry in REMAINING-WORK-NOTES.md.)
- Delivery: **operator to confirm** the first VPS heartbeat (18:00 UTC) arrived.

**Step 8:** `MarketRadar-OffsiteBackupPull` (Task Scheduler, daily 03:30, scp as
root with the contabo_claude key, into `OneDrive\radar-offsite`). First run exit 0,
26 files. Named OUTSIDE `\MarketRadar\` so wake-timers.ps1's path purge can never
remove it.

**Step 9:** the 54 wake timers under `\MarketRadar\` deleted; nothing else touched;
Startup holds only the infoxchange entries; no node.exe on the desktop.

**Log rotation (not in the plan, added):** the unit appends to `data/bot.log` with
no rotation and DEBUG is on in .env; the desktop's log had reached 1.3 GB.
`/etc/logrotate.d/market-radar`: daily, 14 kept, compressed, copytruncate.

**NOT done — operator's call:** sshd still allows password auth and root login. The
brief asked for key-only. Changing it unattended, from a session holding one key,
on a box that also hosts pump and a WordPress site, is a lockout risk. Confirm your
own key in a second terminal first, then `PasswordAuthentication no`.

## Step 7 — Verify from disk, not from the channel

`CLAUDE.md`'s restriction applies on the VPS exactly as on the desktop. Verification
is `data/bot.log`, `data/cadence-watch.json`, `data/state.json`. Delivery is the
operator's to confirm; the brief's answer is "operator to confirm", never an inference.

First 24h checks, all disk-side:

- `bot.log` shows a poll cycle every interval with no `fetch failed` clusters
- The 18:00 UTC heartbeat is written to the log (operator confirms it arrived)
- `sourced firing` line shows the same counts as the desktop's last heartbeat
- No `[OPERATOR]` lines other than the ones you expect

## Step 8 — Offsite backup, pulled not pushed

On the desktop, OneDrive gave `data/backups/` an off-machine copy for free. On the
VPS, backups die with the box. Restore the property with a daily pull **from the
desktop** — the VPS never holds credentials to your machine:

```
# Windows Task Scheduler, daily
scp radar@<vps>:~/market-radar/data/backups/state-*.json C:\Users\bloom\OneDrive\radar-offsite\
```

The desktop's new role, stated in the notes: **offsite backup target and nothing
else.** A machine with a stated role can't quietly reacquire its old one.

## Step 9 — Decommission the desktop — scoped

```
UNINSTALL-AUTOSTART.bat        # done in step 6; confirm again
schtasks /Query /TN \MarketRadar\ /FO LIST   # the 54 wake timers
schtasks /Delete /TN \MarketRadar\* /F        # all of them; they wake a machine with no bot
```

**Leave alone:** `start-bot-on-boot.vbs` (infoxchange), sleep-never power settings
(harmless, and the other bot benefits), OneDrive sync of the repo folder (it's now
the offsite target).

**Over-broad cleanup rules break neighbours.** "Remove all bot launchers" would have
deleted the other project's. Scope every deletion to `market-radar` by name.

## After the migration

- **The `analyze-uptime.js` re-measure is moot** — note it closed in the notes.
- **The launcher preflight `.pending` is superseded** by `preflight.sh` — mark it
  EXECUTED-ELSEWHERE, don't delete.
- **The index refresh** is either automatable (Step 2 said 200) or still manual
  (403). Update `NEXT-SESSION.md`'s RECURRING CHORE either way.
- **Streaming** is now buildable — a machine that doesn't sleep can hold nine
  WebSocket connections. That's a step-list item, not a flag flip; nothing about
  this migration assumes it.
- The Cowork session keeps its role: briefs and `.pending`, nothing that needs SSH.

## Acceptance

- Step 2 green on every exchange; DefiLlama result recorded
- Step 6 items 5, 6, 8 pasted and read by a second reader before 7
- First VPS heartbeat matches the desktop's last on `sourced firing` and coverage
- Desktop confirmed stopped, autostart removed, wake timers deleted, other bot intact
- Root `VPS-MIGRATION.md` marked SUPERSEDED; this file's status flipped to EXECUTED

All five met 2026-09-25 except the heartbeat comparison, which waits for the first
VPS heartbeat (18:00 UTC) — operator to confirm; the coverage line is then read
from the VPS `data/bot.log`.
