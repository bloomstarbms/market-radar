# Reconciliation notes for REMAINING-WORK.md (updated 2026-08-10)

Live version is v0.17.0 (public channel @radaralert22 receives all signal
alerts; heartbeats DM-only). Update Part 0's version line when pasting.

## Storage: JSON-in-OneDrive is DEFENSIBLE, not a mistake to fix

Part 0's "node:sqlite in %LOCALAPPDATA%" describes the spec. The
implementation is zero-dep JSON inside OneDrive, and that design is sound
on its own terms: the original corruption warning was about SQLITE on a
synced path (WAL files, hot page writes, sync scanning mid-transaction).
JSON with atomic temp-write-plus-rename has no such failure mode — rename
is atomic on the same volume, so OneDrive only ever sees closed, complete
files. Different design, not a worse one. A fresh agent must NOT "correct"
this to match Part 0.

Residual risks that atomic rename does NOT cover — narrower, named:
  1. OneDrive CONFLICT COPIES if the file appears modified in two places
     (e.g. cloud restore racing a local write). Watch for
     "outcomes-<machine>.json" siblings; their presence means reconcile.
  2. Transient locks during sync scans — already mitigated by the
     EBUSY-retry in store.js, but new writers must use the same pattern.

## Migration trigger (converts a standing question into a threshold)

JSON rewrites the whole corpus per append — O(n) per write. At 20k rows
that is nothing. Revisit node:sqlite ONLY when append latency or resident
memory becomes measurable in the logs, not before. Until a number trips,
the answer is "no migration".

Also: "config in JSON, hot-reloadable" in Part 0 — actual is .env +
config.js, restart to apply. Same rule: a decision, not a correction.
