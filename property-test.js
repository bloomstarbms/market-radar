// Property tests for the suppression layer.
//
// Motivation: the 72h thread cap silently defeated the 7-day recurrence rule. Two
// suppression mechanisms with different time constants, and tightening one loosened
// the other. That is a CLASS of bug — every cooldown, TTL and window added from here
// can do it again, and the conjunction scorer will add more.
//
// Two properties, both swept against the real 8,834-alert log:
//
//   P1 MONOTONICITY  Sweeping any single parameter in one direction must move total
//                    pushes monotonically. A non-monotonic response means the
//                    parameter is interacting with another one, which is the
//                    signature of exactly the bug above.
//
//   P2 RATE BOUND    No symbol+module may exceed a fixed number of pushes per 30 days,
//                    for ANY parameter combination. The 3-in-7d rule was never
//                    violated by ZRO — it just doesn't bound long-run volume, which is
//                    the thing that actually matters. This asserts the property we
//                    care about rather than the rule we happened to write.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const TYPE_OF = [
  [/WHALE MOVE/, 'WHALE'], [/CEX PUMP/, 'PUMP'], [/CEX SELL-OFF/, 'DUMP'],
  [/UNUSUAL VOLUME/, 'VOLUME'], [/NEW LISTING/, 'LISTING'], [/DEX REVIVAL/, 'REVIVAL'],
  [/FUNDING EXTREME/, 'FUNDING'], [/LIQUIDITY PULL/, 'RUG'], [/TOKEN UNLOCK/, 'UNLOCK'],
  [/MULTI-EXCHANGE/, 'MULTIEX'], [/CONFLUENCE/, 'CONFLUENCE'], [/EXCHANGE ANNOUNCEMENT/, 'ANNOUNCE'],
];
function parse(line) {
  const body = line.replace(/^\[ALERT[^\]]*\]\s*/, '').replace(/^\S+\s*/, '');
  const m = body.match(/\[([^\]]+)\]\s*(.*)$/);
  if (!m) return null;
  const type = (TYPE_OF.find(([rx]) => rx.test(m[1])) || [])[1];
  if (!type) return null;
  const sym = (m[2].match(/^([A-Za-z0-9._]+)[:\s]/) || [])[1];
  return sym ? { type, symbol: sym.replace(/USDT$/, '') } : null;
}

// Load once, replay many times.
const events = [];
{
  let now = 0;
  const rl = createInterface({ input: createReadStream('data/bot.log'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.startsWith('[dex] ethereum:')) { now += 60_000; continue; }
    if (!line.startsWith('[ALERT')) continue;
    const a = parse(line);
    if (a) events.push({ ...a, ts: now });
  }
}
console.log(`loaded ${events.length} events spanning ${(events[events.length - 1].ts / 86400e3).toFixed(1)} days\n`);

const DEFAULTS = { ttlH: 12, maxH: 72, moduleH: 6, recurD: 14, recurLimit: 3, suppressD: 30 };

function replay(p) {
  const cfg = { ...DEFAULTS, ...p };
  const TTL = cfg.ttlH * 3600e3, MAX = cfg.maxH * 3600e3, MOD = cfg.moduleH * 3600e3;
  const RW = cfg.recurD * 86400e3, SUP = cfg.suppressD * 86400e3;
  const threads = {}, recur = {}, suppressed = {}, pushTimes = {};
  let pushes = 0, updates = 0;
  for (const a of events) {
    const NOW = a.ts;
    const rk = `${a.type}:${a.symbol}`;
    const tk = `${a.symbol}:${['DUMP', 'RUG'].includes(a.type) ? 'DOWN' : 'UP'}`;
    if (suppressed[rk] > NOW) continue;
    const th = threads[tk];
    const expired = th && (NOW - th.firstTs > MAX || NOW - th.lastTs >= TTL);
    if (th && !expired) {
      if (th.modules.includes(a.type) && NOW - th.lastTs < MOD) {
        // Suppressing an update must not starve the thread's keep-alive. Without this
        // a longer module cooldown swallows the alerts that were holding the thread
        // open, the thread times out, and the next alert opens a NEW one — so
        // TIGHTENING the cooldown produced MORE pushes. Same class as the 72h/7d bug.
        th.lastTs = NOW;
        continue;
      }
      th.lastTs = NOW; if (!th.modules.includes(a.type)) th.modules.push(a.type);
      updates++; continue;
    }
    threads[tk] = { firstTs: NOW, lastTs: NOW, modules: [a.type] };
    const hits = (recur[rk] || []).filter((t) => t >= NOW - RW);
    hits.push(NOW); recur[rk] = hits;
    if (hits.length > cfg.recurLimit) suppressed[rk] = NOW + SUP;
    (pushTimes[rk] ??= []).push(NOW);
    pushes++;
  }
  // worst 30-day push count for any single symbol+module
  let worst = 0, worstKey = '';
  for (const [k, ts] of Object.entries(pushTimes)) {
    for (let i = 0; i < ts.length; i++) {
      const n = ts.filter((t) => t >= ts[i] && t < ts[i] + 30 * 86400e3).length;
      if (n > worst) { worst = n; worstKey = k; }
    }
  }
  return { pushes, updates, worst, worstKey };
}

// ---------------------------------------------------------------- P1
// "tighter" is the direction that should reduce pushes.
const SWEEPS = [
  { name: 'ttlH        (longer = tighter)', key: 'ttlH', values: [1, 3, 6, 12, 24, 48], expect: 'down' },
  { name: 'maxH        (longer = tighter)', key: 'maxH', values: [12, 24, 48, 72, 168, 720], expect: 'down' },
  { name: 'moduleH     (longer = tighter)', key: 'moduleH', values: [1, 3, 6, 12, 24], expect: 'down' },
  { name: 'recurD      (longer = tighter)', key: 'recurD', values: [3, 7, 14, 21, 30], expect: 'down' },
  { name: 'recurLimit  (lower  = tighter)', key: 'recurLimit', values: [10, 6, 3, 2, 1], expect: 'down' },
  { name: 'suppressD   (longer = tighter)', key: 'suppressD', values: [1, 7, 30, 90], expect: 'down' },
];

let failures = 0;
console.log('P1 — MONOTONICITY: tightening one parameter must not increase pushes\n');
for (const s of SWEEPS) {
  const series = s.values.map((v) => ({ v, ...replay({ [s.key]: v }) }));
  const counts = series.map((x) => x.pushes);
  let bad = null;
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[i - 1]) bad = i;
  const status = bad === null ? 'PASS' : 'FAIL';
  if (bad !== null) failures++;
  console.log(`  ${status}  ${s.name}`);
  console.log(`        ${series.map((x) => `${x.v}:${x.pushes}`).join('  ')}`);
  if (bad !== null) {
    console.log(`        ^ pushes ROSE from ${counts[bad - 1]} to ${counts[bad]} when tightening ` +
      `${s.key} ${series[bad - 1].v} -> ${series[bad].v}  (interaction with another parameter)`);
  }
}

// ---------------------------------------------------------------- P2
const RATE_CAP = 8; // pushes per symbol+module per 30d, any configuration
console.log(`\nP2 — RATE BOUND: no symbol+module may exceed ${RATE_CAP} pushes / 30d\n`);
const combos = [];
for (const maxH of [24, 72, 720]) for (const recurD of [7, 14, 30]) combos.push({ maxH, recurD });
for (const c of combos) {
  const r = replay(c);
  const ok = r.worst <= RATE_CAP;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  maxH=${String(c.maxH).padStart(3)} recurD=${String(c.recurD).padStart(2)}  ` +
    `worst=${r.worst} (${r.worstKey})  pushes=${r.pushes}`);
}

console.log(`\n${failures === 0 ? 'ALL PROPERTIES HOLD' : `${failures} PROPERTY FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
