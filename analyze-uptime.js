// Macro exposure vs. measured uptime — the "don't wait for a second instance" move.
// A machine asleep at 12:30 UTC misses every stage at 12:30 UTC: the failure is
// deterministic, so measure the overlap instead of collecting instances.
//
// Uptime proxy: outcomes.json row timestamps (~5.6 rows/hour when the bot is up —
// suppressed candidates record continuously, so an empty hour ≈ machine asleep).
// An (UTC-date, hour) bucket counts UP if any row landed in it. Read-only.
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync('data/outcomes.json', 'utf8'));
const ts = rows.map((r) => r.ts).sort((a, b) => a - b);

// resolution check: if typical gaps are >> 1h while up, hour buckets under-count
const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
const medGap = gaps[Math.floor(gaps.length / 2)];

const up = new Set(); // "YYYY-MM-DD:HH"
const dates = new Set();
for (const t of ts) {
  const d = new Date(t).toISOString();
  up.add(d.slice(0, 10) + ':' + d.slice(11, 13));
  dates.add(d.slice(0, 10));
}
// full days only (first and last day are partial by construction)
const allDates = [...dates].sort();
const fullDates = allDates.slice(1, -1);
const covByHour = Array.from({ length: 24 }, (_, h) => {
  const hh = String(h).padStart(2, '0');
  return fullDates.filter((d) => up.has(d + ':' + hh)).length / fullDates.length;
});

console.log(`rows ${ts.length} · ${allDates.length} days observed (${fullDates.length} full) · median row gap ${(medGap / 60e3).toFixed(1)}m`);
console.log('\nawake fraction by UTC hour:');
covByHour.forEach((c, h) => console.log(`  ${String(h).padStart(2, '0')}:00  ${'#'.repeat(Math.round(c * 30)).padEnd(30)} ${(c * 100).toFixed(0)}%`));

// --- future macro stages vs this profile
function etToUtc(dateStr, hm) {
  for (const off of [4, 5]) {
    const cand = Date.parse(`${dateStr}T${hm}:00-0${off}:00`);
    const back = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(cand));
    if (back === hm) return cand;
  }
  return Date.parse(`${dateStr}T${hm}:00-05:00`);
}
const STAGES = { FULL: ['t24h', 't60m', 't5m', 't30m'], STANDARD: ['t24h', 't5m'], DIGEST: [] };
const STAGE_AT = { t24h: -24 * 3600e3, t60m: -3600e3, t5m: 5 * 60e3, t30m: 30 * 60e3 };
const ASLEEP = 0.5;

const cal = JSON.parse(readFileSync('data/macro-calendar.json', 'utf8')).events;
const summary = {};
console.log('\nfuture stages vs measured awake fraction (UTC):');
for (const ev of cal) {
  const t0 = etToUtc(ev.date, ev.et);
  if (t0 < Date.now()) continue;
  for (const stage of STAGES[ev.tier] ?? []) {
    const due = new Date(t0 + STAGE_AT[stage]);
    const cov = covByHour[due.getUTCHours()];
    const flag = cov < ASLEEP ? 'AT RISK' : 'ok     ';
    (summary[ev.tier] ??= { total: 0, risk: 0 });
    summary[ev.tier].total++; if (cov < ASLEEP) summary[ev.tier].risk++;
    console.log(`  ${flag} ${ev.id.padEnd(14)} ${stage.padEnd(5)} ${due.toISOString().slice(0, 16)}Z  awake ${(cov * 100).toFixed(0)}%`);
  }
}
console.log('\nsummary (stage falls in an hour historically awake <50% of days):');
for (const [tier, s] of Object.entries(summary))
  console.log(`  ${tier.padEnd(9)} ${s.risk}/${s.total} stages at risk`);
