// BOOT CHECK ON A COPY — the only sanctioned way to make a tree copy for the suite
// or a `--once` boot. The copy NEVER carries .env (NEVER_COPIED) and ALWAYS carries
// `.copy-marker`, so src/config.js refuses to load with a live token inside it
// (copySendGuard). Two boot checks on ad-hoc tar copies sent channel messages
// (2026-09-15, 2026-09-17); this exists so the third cannot, by construction.
//
//   node boot-check.js [dest]        copy -> suite -> `--once` boot, report
//   node boot-check.js --copy-only   just make the copy and print its path
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { NEVER_COPIED } from './test-on-copy.js';
import { COPY_MARKER, COPY_STUB_TOKEN } from './src/config.js';

const SKIP = new Set([...NEVER_COPIED, '.git', 'node_modules', COPY_MARKER]);
export function makeCopy(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, filter: (p) => !SKIP.has(basename(p)) });
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
