// LEFTOVER TEMP FILES (v0.36.2).
//
// Every JSON writer here saves through `<file>.<pid>.tmp` and renames it into place
// (store.js for state.json, cadence-watch.js, builder-follows.js). A temp file that outlives
// its writer is an INTERRUPTED SAVE: the process died, or the disk filled, between the write
// and the rename. One, rarely, is housekeeping. Many in a day is a bug: something is killing
// the bot mid-save, and each one is a save that did not land. So at boot the stale ones
// (older than an hour; nothing live is mid-save that long) are deleted and the operator told,
// and more than TMP_ALARM_PER_DAY in 24 hours puts a line on the heartbeat.
// (The desktop held one such file from 2026-08-27, 2.6 MB, deleted by hand 2026-10-29.)
import { readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const PID_TMP = /\.\d+\.tmp$/;
export const STALE_TMP_MS = 3600e3;
export const TMP_ALARM_PER_DAY = 5;

// Pure over the filesystem it is given: every *.<digits>.tmp under dir older than maxAgeMs.
export function staleTmpFiles(dir, now = Date.now(), { maxAgeMs = STALE_TMP_MS } = {}) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) { walk(r); continue; }
      if (!PID_TMP.test(e.name)) continue;
      let st; try { st = statSync(join(dir, r)); } catch { continue; } // vanished: its writer just renamed it
      if (now - st.mtimeMs > maxAgeMs) out.push({ rel: r, ageMs: now - st.mtimeMs, bytes: st.size });
    }
  };
  walk('');
  return out;
}
// Deletes them and records the sweep in state (st.tmpSweeps, kept 7 days).
export function sweepStaleTmp(st, dir, now = Date.now(), opts = {}) {
  const found = staleTmpFiles(dir, now, opts);
  const deleted = [], failed = [];
  for (const f of found) {
    try { rmSync(join(dir, f.rel), { force: true }); deleted.push(f.rel); } catch (e) { failed.push(`${f.rel} (${e.code ?? e.message})`); }
  }
  st.tmpSweeps = (st.tmpSweeps ?? []).filter((x) => now - x.at < 7 * 86400e3);
  if (found.length) st.tmpSweeps.push({ at: now, n: deleted.length, failed: failed.length, files: deleted.slice(0, 10) });
  return { deleted, failed };
}
// Pure: the heartbeat line, or null while it is housekeeping.
export function tmpSweepStatus(st, now = Date.now()) {
  const recent = (st?.tmpSweeps ?? []).filter((x) => now - x.at < 24 * 3600e3);
  const n = recent.reduce((s, x) => s + x.n + (x.failed || 0), 0);
  if (n <= TMP_ALARM_PER_DAY) return { line: null, n };
  const latest = recent.flatMap((x) => x.files).slice(-3).join(', ');
  return { n, line: `🚨 Interrupted saves: ${n} leftover temp files found at boot in 24h (latest ${latest}) — repeated interrupted saves are a bug, not housekeeping` };
}
