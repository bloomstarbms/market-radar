<!-- PREMISE
Written against: v0.32.0
Reviewed: 2026-09-18
Assumes:
- Live tree is v0.32.0, pushed, tagged, 739 checks green. Diet shipped.
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
Status: ACTIVE PLAN
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
- `timedatectl set-timezone UTC` — macro stages, digest windows and the source-
  staleness ladder all assume it.
- Node 22+: `node --version` must print 22 or higher. Built-in `fetch` is required.

**Same day, before anything else lands on the box:**

```
# key-only SSH — verify in a SECOND terminal before closing the first
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw enable
```

The box will hold the Telegram token and three API keys. Password login off.

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
ExecStartPre=/home/radar/market-radar/preflight.sh
ExecStart=/usr/bin/node src/index.js
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
# 1. syntax — every source file
find src -name '*.js' -print0 | xargs -0 -n1 node --check
# 2. module-scope — dry import, poll loop gated off
TELEGRAM_BOT_TOKEN= node --input-type=module -e "await import('./src/index.js?preflight=1')" \
  || { echo "[PREFLIGHT][OPERATOR] dry import failed" >> data/bot.log; exit 1; }
# 3. gates — the boot self-tests run inside index.js; a parse error never reaches them,
#    which is why 1 and 2 exist
```

Three layers, stated. `--check` catches syntax; the dry import catches module-scope
ReferenceErrors; function-body errors are the suite's job. A preflight that claims
more than this is the fourth instance of a guard whose stated coverage exceeds its real
one.

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
            PASTE. Expect the v0.32.0 banner, four gates OK, pollers scanning,
            "telegram ON".

DESKTOP  9. Nothing. Never start it again. Step 9 below finishes the decommission.
```

Between 1 and 7 there is no bot. That gap is the cost of not having two. Keep it
short; do not do anything else in it.

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
