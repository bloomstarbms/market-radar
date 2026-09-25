<!-- PREMISE
Written against: v0.32.7
Reviewed: 2026-09-25
Assumes:
- Bot runs on the VPS (Contabo, 84.247.179.76) under systemd as user radar, Node 22
  from a tarball at an absolute path; system Node 20 belongs to the pump neighbour.
- Desktop is decommissioned as a runtime but still holds the repo, a stale data/,
  a live .env, working launchers, and a daily offsite-backup pull task.
- DefiLlama, BLS schedule pages and CryptoRank's endpoint all return 403 to the VPS;
  each is a manual browser-pane chore today (RECURRING CHORE 1 and 2).
- Exchange data is REST-polled on a timer. No WebSocket collector exists. The
  liquidation cascade module (step 7) is unbuilt partly for that reason.
- Blockscout keyless limit measured at 10 calls / 5 min; a per-source budget exists.
- The bot's tree is zero-dependency and must stay so. Tooling that runs on the
  desktop is a separate tree.
- The Cowork session writes briefs; Claude Code runs them. Telegram restriction
  applies everywhere.
Status: ACTIVE PLAN
-->

# Post-migration efficiency — three items, three sessions

*Read `CLAUDE.md` first. Paste Part 0 of `REMAINING-WORK.md`. Claude Code runs.
Write the file, run the file — no inline scripts.*

Order is by effort. Item A is minutes. Item B removes every manual chore. Item C
is what the VPS was for.

---

## A — Make the desktop unable to run the bot

The rule "never start it on the desktop again" currently lives in a chat message
and a notes entry. Two instances would double-post and fight over `getUpdates`.
Make it structural.

```
A1. Marker: create MIGRATED-TO-VPS at the desktop repo root containing the VPS
    hostname and the cutover date. Add it to .gitignore — it must NEVER reach
    the VPS clone. A test asserts the file is absent from origin/main.

A2. Every launcher refuses on the marker: START-BOT.bat, RESTART-BOT.bat,
    FORCE-RESTART.bat, run-hidden.bat, INSTALL-AUTOSTART.bat. Batch rule:
    if exist MIGRATED-TO-VPS ( echo ... & exit /b 1 ) — no nested parens, and
    the message names the VPS and the reason.

A3. Delete .env from the desktop. Confirm .env.example remains. The desktop's
    two roles — offsite backup target, fetch relay (item B) — need no bot
    credentials. A live token on a machine with no purpose for it is a leak
    surface, nothing else.

A4. Prove it: run START-BOT.bat, assert the refusal prints and tasklist shows no
    new node process. Run it again with the marker temporarily renamed and
    .env absent — assert it starts console-only and exits, not with a token.
    Restore the marker.

A5. Record the desktop's roles in REMAINING-WORK-NOTES.md: backup target,
    fetch relay. Anything else it appears to do is an accident.
```

Acceptance: five launchers refuse; `.env` gone; origin/main has no marker; a
note states the roles.

---

## B — Desktop as a scheduled fetch relay

Three sources are blocked from the VPS and reachable from a real browser. Today
each is a monthly human task with a gzip-and-base64 carry. This converts all three
into a scheduled job that runs while you sleep.

**Where it lives.** A SEPARATE tree, `C:\Users\bloom\OneDrive\Desktop\radar-relay\`,
with its own `package.json` and Playwright as its one dependency. The bot's tree
stays zero-dep. The relay never imports from `market-radar/`; it produces files
the bot reads.

```
B1. Fetchers, one per source, each writing a dated JSON plus a .sha256 sidecar:

      defillama-unlocks.json     __NEXT_DATA__.props.pageProps.data from
                                 defillama.com/unlocks (370 protocols)
      bls-schedule.json          the CPI, PPI, NFP release-date tables for the
                                 current and next year
      cryptorank-vesting.json    api.cryptorank.io/v0/app/consolidated-vesting
                                 fetched from within the browser context at
                                 limit=20 (the page size that returns full
                                 rows — see notes, 7 Sep)

    Each fetcher FAILS LOUD on an empty or unparseable result: writes
    relay-status.json with {source, ok:false, error, at} and does not overwrite
    the previous good file. A silently empty relay file is worse than none.

B2. Transport: scp the three files, their sidecars and relay-status.json to
    radar@vps:~/market-radar/data/relay/ using the existing key. The relay
    never has shell access beyond scp; restrict the key with
    command="internal-sftp" or a forced-command wrapper on the VPS side.

B3. Schedule: Windows Task Scheduler, daily 03:00 local, run whether the user is
    logged in or not, wake the machine if asleep (the wake-timer mechanism
    already proven). Log to radar-relay\relay.log.

B4. VPS side — the bot reads relay files with three rules:
      - hash must match the sidecar or the file is treated as ABSENT
      - a relay file older than N days (declare N per source; unlocks 21,
        BLS 45, CryptoRank 21) is treated as ABSENT — stale is not data
      - absent relay → existing route (browser-pane chore) remains; the
        heartbeat says which route each source is on and the relay age
    fetch-unlock-index.js, the calendar verifier and the CryptoRank agreement
    overlay each gain a "from relay" branch ahead of their current path.

B5. feedWasLooking applies: a missing relay-status.json is "the relay did not
    run", never "nothing changed". The heartbeat line reads
      Relay: unlocks 0.3d · BLS 0.3d · cryptorank 0.3d · last run OK
    and escalates ⚠️ at 2 missed runs, 🚨 at 5.

B6. First run is supervised: run the task by hand, read relay.log, diff the
    delivered defillama-unlocks.json against the last hand-carried index —
    same protocol count, same top-20 symbols. Then let the schedule take it.
```

Pre-register before B6: expected protocol count (~370), expected delivery time
(<2 min), and the falsification line — if Playwright also gets 403 from the
desktop, the relay is dead on arrival and the chore stays; record it and stop.

Acceptance: three files land on the VPS nightly with matching hashes; the bot
reads them; heartbeat shows relay age; both RECURRING CHORE sections in
`NEXT-SESSION.md` are marked "automated — fallback only"; the relay's own failure
is visible on the VPS within one heartbeat.

---

## C — Streaming for exchange data

The migration's stated reason. A box that never sleeps can hold WebSocket
connections; REST polling on a timer was the desktop's constraint, not a design
choice. Streaming cuts latency from poll-interval to seconds, drops API call
volume, and makes the liquidation cascade module buildable.

**Scope this session: ONE venue, Binance, measured.** Expand only on evidence.

```
C1. Collector shape. A WS collector writes to the SAME in-memory tick store the
    REST poller writes to. Detectors do not change. If a detector needs a code
    change to consume streamed data, the abstraction has leaked — stop and fix
    the store, not the detector.

C2. Streams, Binance:
      <symbol>@ticker        price, 24h vol — replaces the spot ticker poll
      <symbol>@markPrice     funding rate, mark — replaces the funding poll
      !forceOrder@arr        liquidations — NEW input, step 7's precondition
    Combined stream, one connection, symbols from the gate-passing universe.

C3. Health per venue, not a global flag:
      ws: connected | reconnecting | dead
    On dead (3 failed reconnects with backoff), the REST poller for that venue
    RESUMES automatically. On reconnect, REST stops. The heartbeat shows the
    state per venue and the count of REST fallbacks in 24h. A WS that silently
    stops delivering (open socket, no frames for 2× the expected interval) is
    dead, not connected — check frame age, not socket state.

C4. Fixture: record 5 minutes of real Binance frames to a file. Replay through
    the parser; assert the tick store equals what the REST poller produced for
    the same window (within the REST interval's own staleness). Mutate one
    frame and assert the store changes. This is the determinism fixture's
    shape applied to transport.

C5. Pre-register, then measure over 24h on the VPS:
      - median data age at detector read time, REST vs WS
      - Binance REST calls per hour, before vs after
      - reconnect count and longest gap
    Falsification: if median age does not improve by at least 5× or the
    fallback triggers more than twice a day, WS stays off for that venue.

C6. Keep REST. It is the fallback, and it is the only path for venues without
    a WS collector. Nothing about this removes a poller; it adds a faster
    source in front of one.
```

Then, if C5 passes: Bybit and OKX the same way, one per session. Then step 7's
cascade-active detector as a FACT type on the liquidation stream — the module
that was waiting on exactly this.

Acceptance: Binance streamed on the VPS for 24h with the pre-registered numbers
compared; REST fallback proven by killing the socket; heartbeat shows per-venue WS
state; detectors untouched (git diff on src/detectors/ is empty).

---

## What stays manual, and why

- **SSH hardening** — password auth off only after your key is confirmed in a
  second terminal. The brief keeps saying this because the box hosts three
  things now.
- **Blockscout key** and the **BSC decision** — accounts and money, yours.
- **Channel bio** — the disclaimer's home since the diet; still unset.

## Order

A → B → C. A is thirty minutes and removes a standing hazard. B removes every
recurring human task and pays back the first month it runs. C is the largest and
the one that makes the next module possible.
