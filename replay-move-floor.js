// OFFLINE REPLAY — is the 10%-of-peak significance floor binding on MOVE?
//
//   node replay-move-floor.js [SYM]
//
// The floor hid MOVE's August emission after a 52.8M off-schedule move out-sized it
// (logged, not fixed). MOVE's September window closes 2026-09-12, so the question is
// whether a DEMOTE this month would be a real signal or that artifact. Answering it
// AFTER a demotion means reconstructing evidence with the overlay already written and
// the operator DM already sent.
//
// READ-ONLY AND OUT-OF-BAND. It changes no detector, writes no state, and touches no
// live file: changing the floor mid-window would make the verdict answer a different
// question than the one it started. It replays the row's own history through BOTH
// floors and reports whether they ever disagree.
//
// Addresses come from the row's cadence spec (resolveWalletRef discipline), never typed.
import { readFileSync } from 'node:fs';
import { outflowsByDay, detectCadence } from './detect-cadence.js';
import { cadenceDecision, expectedEmissionDate } from './src/sources/calendar/cadence-watch.js';

const sym = (process.argv[2] || 'MOVE').toUpperCase();
const row = JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens.find((t) => t.sym === sym);
if (!row?.cadence) { console.error(`${sym} has no cadence spec`); process.exit(2); }
const spec = row.cadence;
const wallets = Array.isArray(spec.wallets) ? spec.wallets.map((w) => w.addr) : [spec.wallet];

// A median-based alternative to "10% of the largest daily outflow": significance
// measured against the TYPICAL emission day rather than against the biggest single
// day, so one off-schedule whale cannot raise the bar under everything else.
function detectWithMedianFloor(byDay, mult = 0.5) {
  const vals = Object.values(byDay).filter((v) => v > 0).sort((a, b) => a - b);
  if (!vals.length) return null;
  const med = vals[Math.floor(vals.length / 2)];
  const kept = Object.fromEntries(Object.entries(byDay).filter(([, v]) => v >= med * mult));
  return { floor: med * mult, kept, detected: detectCadence(kept, { minMonths: 3 }) };
}

const byWallet = {};
for (const a of wallets) {
  const b = await outflowsByDay(a, sym, 40, Date.now() + 120_000);
  byWallet[a] = b;
  console.log(`${sym} ${a.slice(0, 10)}: ${Object.keys(b).length} active days`);
}
const primary = byWallet[wallets[0]];
if (!Object.keys(primary).length) { console.error('[OPERATOR] empty fetch — NOT evidence; rerun'); process.exit(2); }

const vals = Object.values(primary).filter((v) => v > 0).sort((a, b) => a - b);
const peak = vals[vals.length - 1], med = vals[Math.floor(vals.length / 2)];
console.log(`\npeak day ${Math.round(peak).toLocaleString()} · median active day ${Math.round(med).toLocaleString()}`);
console.log(`current floor  (10% of peak):   ${Math.round(peak * 0.1).toLocaleString()}`);
console.log(`median floor   (50% of median): ${Math.round(med * 0.5).toLocaleString()}`);
const hiddenByCurrent = Object.entries(primary).filter(([, v]) => v < peak * 0.1 && v >= med * 0.5).map(([d]) => d);
console.log(`days the CURRENT floor drops that a median floor keeps: ${hiddenByCurrent.length ? hiddenByCurrent.join(', ') : 'none'}`);

// 1. THE WATCH. This is what produces the live verdict. It takes no significance
//    floor at all — it compares the window's PEAK DAY to 50% of the spec mean.
console.log('\n— what the WATCH would say, month by month (this is the live path) —');
const now = new Date();
let disagreements = 0;
for (let m = 3; m <= 9; m++) {
  const exp = expectedEmissionDate(spec, 2026, m);
  const end = new Date(exp.getTime() + (spec.graceDays ?? 3) * 86400e3);
  const closed = now.getTime() > end.getTime();
  if (!closed) { console.log(`  2026-${String(m).padStart(2, '0')} exp ${exp.toISOString().slice(0, 10)} OPEN    — window has not closed; forcing a verdict here would fabricate a DEMOTE out of an emission that has not happened yet`); continue; }
  const d = cadenceDecision(spec, 2026, m, closed ? now : new Date(end.getTime() + 86400e3), Array.isArray(spec.wallets) ? byWallet : primary);
  // The same decision, run on data with the CURRENT significance floor applied first.
  const filtered = Object.fromEntries(Object.entries(primary).filter(([, v]) => v >= peak * 0.1));
  const dFloor = cadenceDecision(spec, 2026, m, closed ? now : new Date(end.getTime() + 86400e3), Array.isArray(spec.wallets) ? byWallet : filtered);
  const same = d.action === dFloor.action;
  if (!same) disagreements++;
  console.log(`  2026-${String(m).padStart(2, '0')} exp ${exp.toISOString().slice(0, 10)} ${closed ? 'CLOSED ' : 'OPEN   '} ` +
    `raw=${d.action}${d.ratio ? ` ${d.ratio}` : ''} · with-floor=${dFloor.action}${dFloor.ratio ? ` ${dFloor.ratio}` : ''} ${same ? '' : '  <-- DISAGREE'}`);
}

// 2. DISCOVERY. This is where the floor actually lives — it decides which days count
//    as emissions when a cadence is inferred or RE-derived.
console.log('\n— what DISCOVERY would say under each floor (re-promotion path, not the watch) —');
const cur = detectCadence(primary, { minMonths: 3 });
const alt = detectWithMedianFloor(primary);
const fmt = (r) => r ? `${r.verdict}${r.targetDay ? ` day ${r.targetDay}` : ''}${r.monthsRun ? ` over ${r.monthsRun}mo` : ''}${r.meanAmount ? ` mean ${Math.round(r.meanAmount).toLocaleString()}` : ''}${r.cv != null ? ` cv ${r.cv}` : ''}` : 'none';
console.log(`  current (10% of peak):   ${fmt(cur)}`);
console.log(`  median-based:            ${fmt(alt?.detected)}`);
console.log(`  emissions counted: ${cur?.emissions?.length ?? 0} vs ${alt?.detected?.emissions?.length ?? 0}`);

// The bar the OPEN window must clear, stated before it closes.
const bar = (Array.isArray(spec.wallets) ? spec.familyMean ?? spec.wallets.reduce((a, w) => a + w.meanAmount, 0) : spec.meanAmount) * 0.5;
console.log(`\nPRE-REGISTERED BAR for the open window: peak day must be >= ${Math.round(bar).toLocaleString()} ${sym} (50% of the spec mean).`);
// The comparison above is COUNTERFACTUAL on purpose: the watch does not apply the
// significance floor at all. `with-floor` shows what WOULD happen if anyone ever
// wired the discovery floor into the watch — so a disagreement here is a reason to
// keep them apart, not evidence that the live verdict is at risk.
console.log(disagreements
  ? `\nRESULT: the live watch path applies NO significance floor, so this month's verdict cannot be that artifact.\n        ${disagreements} month(s) would have flipped IF the discovery floor were wired into the watch — it is not, and this is the argument for keeping it that way.`
  : '\nRESULT: the live watch path applies no significance floor, and the two floors would not have differed anyway.');
