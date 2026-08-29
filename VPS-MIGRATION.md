<!-- PREMISE
Written against: v0.24.5
Reviewed: 2026-08-29
Assumes:
- Bot runs on the desktop; migration happens ON OR AFTER 31 Aug (never mid-window).
- The agent CANNOT SSH — steps 1-4 are operator-executed, step 5 needs a second reader.
- Entry point src/index.js, JSON storage, no RADAR_TRANSPORT.
- VPS is optional on uptime grounds (88.1% clean-era coverage + stage/event
  redundancy); the case for it is independence and streaming, not availability.
- start-bot-on-boot.vbs belongs to a DIFFERENT project — never delete it.
-->

# VPS Migration — Cutover Prompt

*Paste Part 0 from `REMAINING-WORK.md` first, then this. One session.*

**TIMING — DECIDED 25 Aug: MIGRATE ON THE 31st OR AFTER. Do not migrate before.**

Reasoning (do not relitigate): the 27th and 30th are the unlock module's FIRST LIVE
CALENDAR RUN. Migrating into that window changes two variables at once — a failure
afterwards could be the module or the platform, with no way to separate them. Run the
T-3 and the emission confirmation on the desktop, which has been reliable since
sleep-never landed on 12 Aug; then migrate a pipeline that has proven itself TWICE,
so any post-migration failure is unambiguously the migration.

The urgency argument was CLOSED by step 0: the repo is current (v0.24.3, pushed
25 Aug) and backups exist, so a desktop failure is no longer catastrophic. Waiting
still lands comfortably before the ARB/STRK T-7s around Sep 8-9, which is the next
cluster that actually wants the uptime.

PROVISION WHENEVER — an idle box costs about a dollar a week, and having it ready
(steps 1-4 done, smoke test green) means the 31st is just step 5.

**AGENT CANNOT SSH.** The assistant's shell is sandboxed with allowlisted network
access — it can read the DESKTOP filesystem and run desktop commands, but cannot reach
the VPS. Do not plan around a capability that does not exist. Division of labour:
  - STEP 0 and the DESKTOP half of step 5 (stop bot, uninstall autostart): the agent
    can do these directly.
  - STEPS 1-4 (provision, harden, Node, smoke test): OPERATOR drives. These are
    REVERSIBLE — a geo-blocked box gets destroyed and re-provisioned, no harm done.
  - STEP 5 (cutover): OPERATOR runs, AGENT READS. Paste back the restore-drill output,
    test-delivery result, journalctl boot lines and the first heartbeat. This is the
    IRREVERSIBLE step and the one where a second reader earns its place — getting
    "did the drill actually pass" wrong means corrupted state or two instances
    fighting over Telegram getUpdates.
  - Windows PowerShell has ssh/scp built in; nothing to install.

This decision CLOSES the two-week `analyze-uptime.js` re-measure — moot once the
process runs on a box that never sleeps. Note that in REMAINING-WORK-NOTES.md when
executed.

---

## Corrections to the sketch (read first — wrong assumptions compound)

- **Entry point is `src/index.js`**, not `index.js`.
- **Storage is JSON files in `data/`** (documented decision; migration trigger =
  measurable append latency). The `node:sqlite` mention in Part 0 is the aspirational
  spec — reconciled as divergence in the notes. Node 22+ still required (built-in
  fetch).
- **There is no `RADAR_TRANSPORT` flag.** Streaming transport is unbuilt. If wanted,
  it is a build-list item for a LATER session — never stacked on a migration.
- **The GitHub repo is ~40 versions stale** (last push v0.17.0-era). Step 0 is
  mandatory or the clone deploys a bot from before the delivery layer existed.

```
═══════════════════════════════════════════════════════════════════
STEP 0 — Push current code (DESKTOP, before anything)
═══════════════════════════════════════════════════════════════════
Run PUSH-TO-GITHUB.bat. It aborts if .env is staged — that guard is the
reason it exists; do not bypass it. Verify github shows VERSION 0.24.3+
in src/config.js before proceeding. Code moves by git; SECRETS AND DATA
NEVER DO.

═══════════════════════════════════════════════════════════════════
STEP 1 — Provision
═══════════════════════════════════════════════════════════════════
- Ubuntu 24.04, $5 tier (1GB is plenty; the process is zero-dep Node).
- REGION: EU (Frankfurt/Amsterdam). NOT a US datacenter — Binance
  geo-blocks US IPs and several ranges besides; catch this at provision,
  not on the 27th.
- timedatectl set-timezone UTC   (macro stages and digest windows assume it)
- Install Node 22+ (nodesource or nvm). node --version >= 22.

═══════════════════════════════════════════════════════════════════
STEP 1b — Harden SSH on day one (ten minutes, once)
═══════════════════════════════════════════════════════════════════
The box holds the Telegram token and the Etherscan/Helius keys.
  - key-only auth: PasswordAuthentication no, PubkeyAuthentication yes
    in /etc/ssh/sshd_config.d/hardening.conf; systemctl reload ssh
    (VERIFY key login works in a SECOND terminal before closing the first)
  - ufw default deny incoming; ufw allow OpenSSH; ufw enable
  - chmod 600 ~/market-radar/.env when it arrives (step 5)
Nothing inbound but SSH is needed — the bot only makes OUTBOUND calls.

═══════════════════════════════════════════════════════════════════
STEP 2 — API reachability smoke test (BEFORE any cutover step)
═══════════════════════════════════════════════════════════════════
On the VPS, before copying anything:

  node -e '
  const urls = {
    binance:  "https://api.binance.com/api/v3/time",
    binanceF: "https://fapi.binance.com/fapi/v1/time",
    bybit:    "https://api.bybit.com/v5/market/time",
    gate:     "https://api.gateio.ws/api/v4/spot/time",
    kucoin:   "https://api.kucoin.com/api/v1/timestamp",
    bitget:   "https://api.bitget.com/api/v2/public/time",
    mexc:     "https://api.mexc.com/api/v3/time",
    upbit:    "https://api.upbit.com/v1/market/all?isDetails=false",
    bithumb:  "https://api.bithumb.com/v1/notices?count=1",
    okx:      "https://www.okx.com/api/v5/public/time",
    etherscan:"https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber",
    telegram: "https://api.telegram.org",
    dexscreener:"https://api.dexscreener.com/latest/dex/tokens/0xdac17f958d2ee523a2206206994597c13d831ec7",
    goplus:   "https://api.gopluslabs.io/api/v1/supported_chains",
    blockscout:"https://eth.blockscout.com/api/v2/stats",
  };
  (async () => { let bad = 0;
    for (const [k, u] of Object.entries(urls)) {
      try { const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
        console.log(r.ok ? "OK  " : "FAIL", k, r.status); if (!r.ok) bad++; }
      catch (e) { console.log("FAIL", k, e.message); bad++; }
    }
    process.exit(bad ? 1 : 0); })()'

ANY exchange FAIL = wrong VPS location. Destroy the box and re-provision
elsewhere — this costs minutes now and the whole channel later.

═══════════════════════════════════════════════════════════════════
STEP 3 — Code via git, data via scp. NEVER data via git.
═══════════════════════════════════════════════════════════════════
  git clone <repo> ~/market-radar
  # verify: grep VERSION ~/market-radar/src/config.js  -> 0.24.3+

Data moves in the CUTOVER step (step 5), not now — a copy taken now goes
stale the moment the desktop bot writes again. What moves then:
  data/            (state, outcomes, archive, backups, vocab, calendar,
                    equity-tickers, excluded-symbols, unclassified,
                    restore-drill stamp, review-exclusions stamp)
  unlocks.json     (REPO ROOT — the verified schedule lives here!)
  watchlist.json   (repo root)
  .env             (secrets; scp only, chmod 600 on arrival)

unlocks.json and watchlist.json are also in git, but the git copies may
lag local edits — the scp copy from the desktop is authoritative.

═══════════════════════════════════════════════════════════════════
STEP 4 — systemd (replaces run-hidden.bat, FORCE-RESTART, all 54 wake timers)
═══════════════════════════════════════════════════════════════════
/etc/systemd/system/market-radar.service:

  [Unit]
  Description=Market Radar
  After=network-online.target
  Wants=network-online.target

  [Service]
  User=<user>
  WorkingDirectory=/home/<user>/market-radar
  ExecStart=/usr/bin/node src/index.js
  Restart=always
  RestartSec=15
  # boot gates exit(1) on a real defect; without a cap systemd would
  # crash-loop forever exactly like run-hidden.bat did on 21 Aug
  StartLimitIntervalSec=600
  StartLimitBurst=5

  [Install]
  WantedBy=multi-user.target

systemctl daemon-reload && systemctl enable market-radar   (do NOT start yet)

WorkingDirectory matters: routes.js and unlocks.js resolve paths from
cwd/ROOT. StartLimitBurst: five failed boots in ten minutes = stop and
wait for the operator, not an infinite loop.

═══════════════════════════════════════════════════════════════════
STEP 5 — THE CUTOVER (the only dangerous step — strict order)
═══════════════════════════════════════════════════════════════════
Two live instances DOUBLE-POST to the channel, RACE state.json writes,
and FIGHT over Telegram getUpdates (409s). Order is absolute:

  1. DESKTOP: stop the bot (kill node + the run-hidden loop).
  2. DESKTOP: run UNINSTALL-AUTOSTART.bat NOW — a reboot must not be able
     to resurrect it. Verify market-radar.vbs is GONE from the Startup
     folder. DO NOT touch start-bot-on-boot.vbs — inspected 27 Aug, it
     launches a DIFFERENT project (Desktop\infoxchange-bot\
     run-bot-forever.bat) and is none of this migration's business.
     Deleting it would break the operator's other bot. The check is
     "no MARKET-RADAR launcher remains", scoped precisely — an
     over-broad 'empty the folder' rule is how you break a neighbour.
  3. DESKTOP: final copy — freshest state wins:
       scp -r data/ .env unlocks.json watchlist.json user@vps:~/market-radar/
  4. VPS: prove the data survived BEFORE trusting it:
       cd ~/market-radar && node restore-drill.js
     The FUNCTIONAL check (multipliers off restored rows) is the point —
     this is exactly what the drill was built for. Also:
       node test-delivery.js        (should be ALL PROPERTIES HOLD)
  5. VPS: systemctl start market-radar
  6. Verify (step 6). Only after green: leave it.
  7. DESKTOP: never start the bot again. Optionally delete the
     \MarketRadar\ wake-timer tasks (harmless if left — they only wake a
     machine that no longer runs anything).

If the VPS boot fails its gates: systemctl stop, fix, retry. Do NOT fall
back to restarting the desktop bot unless the VPS is abandoned entirely —
and then re-run INSTALL-AUTOSTART deliberately.

═══════════════════════════════════════════════════════════════════
STEP 6 — Verify with the instruments (never "it started")
═══════════════════════════════════════════════════════════════════
  journalctl -u market-radar -f
    [boot] admit() self-test: 6/6 paths OK
    [boot] tier-route assertion: OK
    [boot] classifiers-wired assertion: OK
    Market Radar v0.24.3+ starting ...
  Then within minutes: every collector logging ([cex] binance: N pairs,
  [announce] 130 scanned, [funding] N perps, [dex] chains).
  Then: first heartbeat DM — check the funnel line, collector ages, and
  that Backup/Accumulator lines are sane on the new box.
  Watch specifically for fetch failures = geo-block missed by step 2.

═══════════════════════════════════════════════════════════════════
STEP 7 — The backup gap (the ONE thing the VPS makes WORSE)
═══════════════════════════════════════════════════════════════════
OneDrive silently gave every snapshot an off-machine copy. On the VPS,
data/backups/ dies with the box. Add on the DESKTOP (which you own and
is already synced to OneDrive) a daily scheduled task:

  scp -r user@vps:~/market-radar/data/backups/ C:\Users\bloom\radar-offsite\

Pull, not push: the VPS needs no credentials to the desktop. Verify one
manual run before trusting the schedule. The heartbeat backup line stays
honest either way; OFF-BOX is the property being restored.

═══════════════════════════════════════════════════════════════════
STEP 8 — After stable only
═══════════════════════════════════════════════════════════════════
- Watch the Aug 27 T-3 arrive from the VPS (clean number, real provenance).
- Aug 30: custody outflow closes the loop.
- THEN the five promotions (promote-unlock.js), bespoke reads, and any
  streaming-transport build — one change at a time, never stacked on the
  module's first live calendar run.

═══════════════════════════════════════════════════════════════════
STEP 9 — Desktop decommission (a CHECKLIST, not just "disable autostart")
═══════════════════════════════════════════════════════════════════
  [ ] UNINSTALL-AUTOSTART.bat run; Startup folder empty of market-radar.vbs
  [ ] Wake timers: delete the \MarketRadar\ folder in Task Scheduler
      (harmless firing on a botless machine, but clutter is how the next
      session mistakes them for something live)
  [ ] Offsite backup pull (step 7) scheduled AND verified once by hand
  [ ] Keep the OneDrive folder as archive of record until the pull has
      run clean for a week
  [ ] State the desktop's new role in REMAINING-WORK-NOTES.md:
      OFFSITE BACKUP TARGET AND NOTHING ELSE. A machine with a stated
      role can't quietly reacquire its old one.
  [ ] Also note there: the two-week analyze-uptime.js re-measure is
      CLOSED BY THIS DECISION (moot on a box that never sleeps).

SOMEDAY (cheap, not urgent): the repo itself is a safeguard whose
staleness is indistinguishable from freshness until something clones it —
same class as the stale boot assertions. If pushes stay manual, add a
heartbeat line: `last push: N versions behind` (compare git HEAD tag or
a pushed-version marker vs VERSION). Would have made the 40-version gap
visible long before a migration nearly deployed it.
```

Acceptance for the migration session: smoke test all-OK from the VPS ·
restore-drill functional check green on copied data · test-delivery green
on the VPS · boot gates green in journalctl · first heartbeat healthy ·
desktop autostart uninstalled · offsite backup pull verified once ·
exactly ONE instance alive at every moment of the cutover.
