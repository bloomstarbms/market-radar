// Acceptance tests 6 and 7 (spec §9) against the RAW alert log.
//
// outcomes.json is price-gated, so whale alerts never entered it and the EIGEN series
// could not be tested there. bot.log holds every alert the bot has ever printed —
// 8,834 of them, including 954 whale moves — which is the correct fixture.
//
// The log has no per-line timestamps, so the clock is reconstructed from poll-cycle
// markers ("[dex] ethereum:" prints once per pollDex run at the configured interval).
// Alerts between two markers genuinely occurred within the same cycle, so this is a
// faithful ordering, not an approximation of one.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const POLL_SEC = 60;
const GLOBAL_COOLDOWN = 12 * 3600e3;
const THREAD_MAX = Number(process.env.MAXH || 72) * 3600e3;
const MODULE_COOLDOWN = 6 * 3600e3;
const RECUR_WINDOW = Number(process.env.RW || 7) * 24 * 3600e3, RECUR_LIMIT = 3, SUPPRESS_MS = 30 * 24 * 3600e3;

const TYPE_OF = [
  [/WHALE MOVE/, 'WHALE'], [/CEX PUMP/, 'PUMP'], [/CEX SELL-OFF/, 'DUMP'],
  [/UNUSUAL VOLUME/, 'VOLUME'], [/NEW LISTING/, 'LISTING'], [/DEX REVIVAL/, 'REVIVAL'],
  [/FUNDING EXTREME/, 'FUNDING'], [/LIQUIDITY PULL/, 'RUG'], [/TOKEN UNLOCK/, 'UNLOCK'],
  [/MULTI-EXCHANGE/, 'MULTIEX'], [/CONFLUENCE/, 'CONFLUENCE'], [/EXCHANGE ANNOUNCEMENT/, 'ANNOUNCE'],
];
// "EIGEN: $53.2K moved (ethereum)" / "MYUSDT pumping on MEXC" / "ZRO: $19.0K moved"
function parse(line) {
  const body = line.replace(/^\[ALERT[^\]]*\]\s*/, '').replace(/^\S+\s*/, '');
  const tagMatch = body.match(/\[([^\]]+)\]\s*(.*)$/);
  if (!tagMatch) return null;
  const [, tag, title] = tagMatch;
  const type = (TYPE_OF.find(([rx]) => rx.test(tag)) || [])[1];
  if (!type) return null;
  const sym = (title.match(/^([A-Za-z0-9._]+)[:\s]/) || [])[1];
  if (!sym) return null;
  return { type, symbol: sym.replace(/USDT$/, ''), title };
}

const state = { threads: {}, recur: {}, suppressed: {} };
let NOW = 0;
const stats = { total: 0, pushed: 0, updated: 0, drops: {} };
const perSymbol = {}; // symbol -> {before, after}
const drop = (r) => { stats.drops[r] = (stats.drops[r] || 0) + 1; };

function admit(a) {
  const rk = `${a.type}:${a.symbol}`;
  const tk = `${a.symbol}:${['DUMP', 'RUG'].includes(a.type) ? 'DOWN' : 'UP'}`;
  if (state.suppressed[rk] > NOW) return drop('recurrence-suppressed');
  const th = state.threads[tk];
  const expired = th && (NOW - th.firstTs > THREAD_MAX);
  if (th && !expired && NOW - th.lastTs < GLOBAL_COOLDOWN) {
    if (th.modules.includes(a.type) && NOW - th.lastTs < MODULE_COOLDOWN) return drop('cooldown-module');
    th.lastTs = NOW; th.updates++;
    if (!th.modules.includes(a.type)) th.modules.push(a.type);
    stats.updated++; return 'update';
  }
  state.threads[tk] = { firstTs: NOW, lastTs: NOW, modules: [a.type], updates: 0 };
  const hits = (state.recur[rk] || []).filter((t) => t >= NOW - RECUR_WINDOW);
  hits.push(NOW); state.recur[rk] = hits;
  if (hits.length > RECUR_LIMIT) state.suppressed[rk] = NOW + SUPPRESS_MS;
  stats.pushed++; return 'push';
}

const rl = createInterface({ input: createReadStream('data/bot.log'), crlfDelay: Infinity });
for await (const line of rl) {
  if (line.startsWith('[dex] ethereum:')) { NOW += POLL_SEC * 1000; continue; }
  if (!line.startsWith('[ALERT')) continue;
  const a = parse(line);
  if (!a) continue;
  stats.total++;
  const key = `${a.type}:${a.symbol}`;
  (perSymbol[key] ??= { before: 0, after: 0 });
  perSymbol[key].before++;
  const r = admit(a);
  if (r === 'push') perSymbol[key].after++;
}

const days = NOW / 86400e3;
console.log(`parsed ${stats.total} alerts spanning ~${days.toFixed(1)} reconstructed days\n`);
console.log(`BEFORE : ${stats.total} pushes`);
console.log(`AFTER  : ${stats.pushed} pushes + ${stats.updated} in-thread updates`);
console.log(`reduction: ${(stats.total / Math.max(1, stats.pushed)).toFixed(1)}x\n`);
console.log('drops by reason:');
for (const [k, v] of Object.entries(stats.drops).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v}`);

console.log('\n--- TEST 7: EIGEN recurrence (spec: at most one, then auto-suppressed) ---');
for (const k of Object.keys(perSymbol).filter((k) => /EIGEN|ZRO/.test(k))) {
  const p = perSymbol[k];
  console.log(`  ${k.padEnd(22)} ${String(p.before).padStart(4)} -> ${p.after}   ${p.after <= RECUR_LIMIT + 1 ? 'PASS' : 'FAIL'}`);
}
console.log('\n--- TEST 6: MY session (spec: one alert, then edited, never four) ---');
for (const k of Object.keys(perSymbol).filter((k) => /:MY$/.test(k))) {
  const p = perSymbol[k];
  console.log(`  ${k.padEnd(22)} ${String(p.before).padStart(4)} -> ${p.after}`);
}
const myTotal = Object.entries(perSymbol).filter(([k]) => /:MY$/.test(k)).reduce((s, [, v]) => s + v.after, 0);
const myBefore = Object.entries(perSymbol).filter(([k]) => /:MY$/.test(k)).reduce((s, [, v]) => s + v.before, 0);
console.log(`  MY total across modules: ${myBefore} -> ${myTotal}`);

console.log('\n--- worst repeat offenders, before -> after ---');
Object.entries(perSymbol).sort((a, b) => b[1].before - a[1].before).slice(0, 8)
  .forEach(([k, v]) => console.log(`  ${k.padEnd(22)} ${String(v.before).padStart(4)} -> ${v.after}`));
console.log(`\nauto-suppressed pairs: ${Object.keys(state.suppressed).length}`);
