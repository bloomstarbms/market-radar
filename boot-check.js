// BOOT CHECK ON A COPY — the only sanctioned way to make a tree copy for the suite
// or a `--once` boot. The copy NEVER carries .env (NEVER_COPIED) and ALWAYS carries
// `.copy-marker`, so src/config.js refuses to load with a live token inside it
// (copySendGuard). Two boot checks on ad-hoc tar copies sent channel messages
// (2026-09-15, 2026-09-17); this exists so the third cannot, by construction.
//
//   node boot-check.js [dest]        copy -> suite -> `--once` boot, report
//   node boot-check.js --copy-only   just make the copy and print its path
import { cpSync, copyFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { NEVER_COPIED } from './test-on-copy.js';
import { COPY_MARKER, COPY_STUB_TOKEN, MIGRATED_MARKER } from './src/config.js';

// MIGRATED_MARKER is skipped so the desktop can still run the suite and a --once boot on a
// COPY: the copy is console-only by construction (no .env), which is the point.
const SKIP = new Set([...NEVER_COPIED, '.git', 'node_modules', COPY_MARKER, MIGRATED_MARKER]);

// A COPY MADE WHILE THE BOT RUNS (2026-10-29). On the VPS boot-check copies the tree while the
// live bot writes it: store.js saves state.json through `state.json.<pid>.tmp` and renames it
// (cadence-watch and builder-follows do the same). cpSync lists a directory, then copies each
// entry; a temp file renamed away in between made the whole copy throw ENOENT and the v0.36.0
// deploy was refused before the suite ran (correctly: no restart; a retry passed). So:
//   - in-flight temp files are never copied: `*.<digits>.tmp` anywhere, any `*.tmp` under data/
//     (they are half-written by definition; the file they become is copied in its own right);
//   - a file that vanishes between listing and copying is skipped with a note, not fatal;
//   - any other error still aborts the copy (a copy that silently lost files would prove nothing).
export const isInFlight = (rel) => { const n = basename(rel); return /\.\d+\.tmp$/.test(n) || (/^data[\\/]/.test(rel) && /\.tmp$/.test(n)); };
// deps (for the fixture): { copyFile, readdir, note, report } — report receives { inFlight: [], vanished: [] }.
export function makeCopy(src, dest, deps = {}) {
  const copyFile = deps.copyFile ?? copyFileSync;
  const list = deps.readdir ?? ((d) => readdirSync(d, { withFileTypes: true }));
  const note = deps.note ?? ((m) => console.log(m));
  const skipped = { inFlight: [], vanished: [] };
  const gone = (e) => e?.code === 'ENOENT';
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const walk = (rel) => {
    let entries;
    try { entries = list(rel ? join(src, rel) : src); } catch (e) { if (rel && gone(e)) { skipped.vanished.push(rel); return; } throw e; }
    for (const ent of entries) {
      if (SKIP.has(ent.name)) continue;
      const r = rel ? join(rel, ent.name) : ent.name;
      if (isInFlight(r)) { skipped.inFlight.push(r); continue; }
      try {
        if (ent.isDirectory()) { mkdirSync(join(dest, r), { recursive: true }); walk(r); }
        else if (ent.isSymbolicLink()) cpSync(join(src, r), join(dest, r));
        else copyFile(join(src, r), join(dest, r));
      } catch (e) {
        if (!gone(e)) throw e;
        skipped.vanished.push(r);
        note(`copy: ${r} vanished during the copy (renamed or deleted by a live writer), skipped`);
      }
    }
  };
  walk('');
  if (deps.report) Object.assign(deps.report, skipped);
  if (existsSync(join(dest, '.env'))) throw new Error('copy carries .env — refusing');
  writeFileSync(join(dest, COPY_MARKER), `copy of ${src} at ${new Date().toISOString()}\n`);
  return dest;
}

const isCli = process.argv[1] && basename(process.argv[1]) === 'boot-check.js';
if (isCli) {
  const args = process.argv.slice(2);
  const dest = args.find((a) => !a.startsWith('--')) ?? join(tmpdir(), 'market-radar-copy');
  const copy = makeCopy(process.cwd(), dest);
  console.log(`copy: ${copy} (no .env, ${COPY_MARKER} written)`);
  if (args.includes('--copy-only')) process.exit(0);
  // Suite: the stub token (fetch is stubbed inside the suite; the guard admits only
  // this sentinel). Boot: no token at all — console-only.
  const run = (label, cmd, token) => {
    const r = spawnSync(process.execPath, cmd, { cwd: copy, encoding: 'utf8', env: { ...process.env, TELEGRAM_BOT_TOKEN: token }, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    console.log(`--- ${label}: exit ${r.status} ---`);
    return { status: r.status, out };
  };
  const suite = run('suite', ['test-delivery.js'], COPY_STUB_TOKEN);
  const pass = (suite.out.match(/^\s+PASS/gm) || []).length, fail = (suite.out.match(/^\s+FAIL/gm) || []).length;
  console.log(`suite PASS ${pass} FAIL ${fail}${/ALL DELIVERY PROPERTIES HOLD/.test(suite.out) ? ' · ALL GREEN' : ' · NOT GREEN'}`);
  (suite.out.match(/^\s+FAIL.*$/gm) || []).forEach((l) => console.log(l));
  const boot = run('boot --once', ['src/index.js', '--once'], '');
  const banner = (boot.out.match(/Market Radar v\S+ starting[^\n]*/) || ['(no banner)'])[0];
  console.log(banner);
  const sent = boot.out.match(/(\d+) reminders sent/);
  console.log(`telegram: ${/telegram OFF/.test(banner) ? 'OFF (console-only) ✓' : 'NOT OFF — INVESTIGATE'}${sent ? ` · ${sent[1]} reminders would have gone` : ''}`);
  const gates = (boot.out.match(/^\[boot\][^\n]*/gm) || []);
  gates.forEach((g) => console.log(g));
  process.exit(suite.status === 0 && boot.status === 0 && /telegram OFF/.test(banner) ? 0 : 1);
}
