// Macro calendar — spec §4.3, built to four constraints:
//
//   1. HAND-ENTERED schedule is the source of truth (data/macro-calendar.json).
//      Scraping only VERIFIES: the weekly check compares the file against the BLS
//      page and alerts the OPERATOR on mismatch. A parse failure is loud and
//      non-blocking; it can never silently empty the calendar.
//   2. T+5m reports MARKET REACTION (BTC/ETH move across the print, from exchange
//      data we already poll) — never the print value. FRED/BLS series lag the 08:30
//      release by minutes-to-hours; building T+5m on them ships an empty field. The
//      print itself arrives at T+30m if BLS has it by then, else "not yet published".
//   3. TIERED, because RISK-bypass is a privilege: FULL (FOMC, CPI) get all four
//      stages; STANDARD (PCE, NFP) get T-24h and T+5m; DIGEST (claims, ISM, PPI)
//      never push. ~200 alerts/year of calendar spam is how a channel dies.
//   4. ET wall-clock + America/New_York, UTC derived per date. Never a fixed offset:
//      08:30 ET is 12:30Z or 13:30Z depending on DST.
import { readFileSync, existsSync } from 'node:fs';
import { lagDisclosure } from '../../core/lag.js';
import { join } from 'node:path';
import { config } from '../../config.js';
import { dispatch } from '../../core/dispatcher.js';
import { getState, save } from '../../core/store.js';
import { btcPrice } from '../../core/outcomes.js';
import { notePulse } from '../../core/pulse.js';

const CAL_PATH = join(process.cwd(), 'data', 'macro-calendar.json');
const STAGES = {
  FULL: ['t24h', 't60m', 't5m', 't30m'],
  STANDARD: ['t24h', 't5m'],
  DIGEST: [],
};
const STAGE_AT = { t24h: -24 * 3600e3, t60m: -3600e3, t5m: 5 * 60e3, t30m: 30 * 60e3 };

// Freshness is PER-STAGE because warnings and reports decay in opposite directions
// (learned on the Aug 12 2026 CPI). A WARNING delivered late is worse than silence —
// "CPI in 60 minutes" arriving at T-15m invites a position there's no time to manage,
// so missed-not-late stays strict, and strictest for t60m. An OBSERVATION REPORT
// ("BTC moved X across the print") is still true hours later, PROVIDED the message
// states its observation window and delivery lag rather than presenting stale as live.
const STAGE_FRESH = { t24h: 45 * 60e3, t60m: 20 * 60e3, t5m: 6 * 3600e3, t30m: 6 * 3600e3 };

// ET wall-clock -> UTC ms for that specific date. Tries the two possible NY offsets
// and keeps the one that round-trips — DST handled by construction, no offset table.
export function etToUtc(dateStr, hm) {
  for (const off of [4, 5]) {
    const cand = Date.parse(`${dateStr}T${hm}:00-0${off}:00`);
    const back = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
    }).format(new Date(cand));
    if (back === hm) return cand;
  }
  return Date.parse(`${dateStr}T${hm}:00-05:00`); // unreachable in practice
}

function loadCalendar() {
  if (!existsSync(CAL_PATH)) return [];
  try { return JSON.parse(readFileSync(CAL_PATH, 'utf8')).events || []; }
  catch (e) { console.error('[macro] calendar unreadable:', e.message); return []; }
}

// Market snapshot for reaction measurement. ETH via the same Binance ticker family the
// outcome tracker already uses; both fall back gracefully to 0 (= "unavailable").
async function marketSnap() {
  const btc = await btcPrice().catch(() => 0);
  let eth = 0;
  try {
    const j = await (await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT')).json();
    eth = Number(j.price) || 0;
  } catch { /* leave 0 */ }
  return { btc, eth, at: Date.now() };
}
const pct = (from, to) => (from && to ? (((to - from) / from) * 100).toFixed(2) : null);

export async function pollMacro() {
  const st = getState();
  st.macro ??= {};
  const now = Date.now();

  for (const ev of loadCalendar()) {
    const stages = STAGES[ev.tier] ?? [];
    const t0 = etToUtc(ev.date, ev.et);
    if (now - t0 > 24 * 3600e3) continue; // fully in the past
    const rec = (st.macro[ev.id] ??= { fired: {} });
    // DIGEST tier never pushes, but MUST reach a reader (fix 3: Core PPI was
    // computed, classified, and dropped — a tier with no route). One entry into the
    // digest pool at release time; telemetry.js drains it into the daily digest.
    if (!stages.length) {
      if (now >= t0 && !rec.fired.digest) {
        rec.fired.digest = now;
        (st.digestPool ??= []).push({ ts: now, kind: ev.kind, title: `${ev.kind} released — ${ev.date} ${ev.et} ET (digest-tier macro, never pushed by design)` });
        while (st.digestPool.length > 100) st.digestPool.shift();
        save();
      }
      continue;
    }

    // Freeze the pre-print market state just before the release so T+5m has a basis.
    if (now >= t0 - 10 * 60e3 && now < t0 && !rec.pre) { rec.pre = await marketSnap(); save(); }

    for (const stage of stages) {
      if (rec.fired[stage]) continue;
      const due = t0 + STAGE_AT[stage];
      if (now < due) continue;
      if (now - due > STAGE_FRESH[stage]) { rec.fired[stage] = 'missed'; save(); continue; } // bot was down; stale, don't fake it

      const utc = new Date(t0).toISOString().slice(11, 16);
      let title, lines;
      if (stage === 't24h') {
        title = `${ev.kind} in ~24h — ${ev.date} ${ev.et} ET (${utc} UTC)`;
        lines = [
          ev.note || 'Scheduled macro print — crypto trades as a high-beta liquidity asset on these.',
          ev.verified ? `Date verified against the official schedule${ev.verifiedOn ? ' on ' + ev.verifiedOn : ''}.` : '⚠️ Date from hand-entered schedule, not yet re-verified — check the official release calendar.',
        ];
      } else if (stage === 't60m') {
        title = `${ev.kind} in 60 minutes (${utc} UTC)`;
        lines = ['If leveraged, consider reducing before the print — the first move frequently reverses.'];
      } else if (stage === 't5m') {
        const snap = await marketSnap();
        const b = pct(rec.pre?.btc, snap.btc), e = pct(rec.pre?.eth, snap.eth);
        rec.post5 = snap;
        // Observation window is pre-print -> NOW, which is only "the first 5 minutes"
        // when delivery is on time. State the actual window; disclose lag when late.
        const tPlus = Math.round((now - t0) / 60e3);
        title = `${ev.kind} released — first reaction (T+${tPlus}m)`;
        lines = [
          b !== null ? `BTC ${b > 0 ? '+' : ''}${b}% · ETH ${e > 0 ? '+' : ''}${e}% from just before the print to T+${tPlus}m`
            : 'Reaction basis unavailable (bot was not up pre-print).',
          ...[lagDisclosure(now - due, (m) => `delivered ${m}m after the T+5m mark — the window above is as stated, not live`)].filter(Boolean),
          'Print value not yet published by the source — reaction is the tradeable part; figure follows at T+30m if available.',
        ];
      } else { // t30m
        const snap = await marketSnap();
        const b5 = pct(rec.pre?.btc, rec.post5?.btc), b30 = pct(rec.pre?.btc, snap.btc);
        const held = b5 !== null && b30 !== null
          ? (Math.sign(b30) === Math.sign(b5) && Math.abs(b30) >= Math.abs(b5) * 0.5 ? 'HOLDING' : 'FADING')
          : 'unknown';
        const tPlus = Math.round((now - t0) / 60e3);
        title = `${ev.kind} +${tPlus}m — initial move is ${held}`;
        lines = [
          b30 !== null ? `BTC ${b30 > 0 ? '+' : ''}${b30}% from pre-print to T+${tPlus}m (was ${b5 > 0 ? '+' : ''}${b5}% at the first reading)` : 'No pre-print basis.',
          ...[lagDisclosure(now - due, (m) => `delivered ${m}m after the T+30m mark — observation window as stated, not live`)].filter(Boolean),
          'No claim about the follow-through rate yet — that statistic starts accumulating from this event forward.',
        ];
      }
      if (await dispatch({
        source: 'CAL', type: 'MACRO', severity: stage === 't5m' || stage === 't60m' ? 'HIGH' : 'MEDIUM',
        key: `${ev.id}:${stage}`, dedupeKey: `MACRO:${ev.id}:${stage}`, cooldownMin: 12 * 60,
        title, lines,
      })) { rec.fired[stage] = Date.now(); save(); }
    }
  }
  notePulse('macro');
}

// ---- WEEKLY VERIFIER — compares, never mutates -----------------------------------
// Three official sources, three parsers, all pure so fixture 70 feeds them saved HTML.
// BLS pages 403 from datacenter ranges (the VPS, 2026-09-23/25); the Fed and BEA
// pages answer from the VPS. An unreachable source makes its events UNCHECKED — not
// ok, not mismatch — and an unchecked event rests on the file's own `verifiedOn`
// stamp: it goes loud only when the stamp is old or missing and the event is near.
// 2026-09-25: the file held FIVE wrong dates (two CPI, two PCE — one of them "today")
// that the old regex verifier had flagged for weeks as "not found on BLS schedule
// page", one line per kind, easy to read as page noise. A mismatch now carries the
// official date next to the wrong one.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const mon = (name) => { const i = MONTHS.findIndex((m) => m.slice(0, 3).toLowerCase() === String(name).slice(0, 3).toLowerCase()); return i < 0 ? null : i + 1; };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const VERIFY_SOURCES = {
  CPI: 'https://www.bls.gov/schedule/news_release/cpi.htm',
  PPI: 'https://www.bls.gov/schedule/news_release/ppi.htm',
  NFP: 'https://www.bls.gov/schedule/news_release/empsit.htm',
  FOMC: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  PCE: 'https://www.bea.gov/news/schedule',
};
// BLS schedule tables: "Oct. 14, 2026" / "Jan. 09, 2026" / "May 12, 2026" -> ISO.
export function parseBlsSchedule(html) {
  const out = new Set();
  for (const m of String(html).matchAll(/\b([A-Z][a-z]{2})\.?\s+(\d{1,2}),\s+(20\d{2})\b/g)) { const mm = mon(m[1]); if (mm) out.add(iso(m[3], mm, m[2])); }
  return [...out];
}
// Fed FOMC calendar: one panel per year; each meeting is a month plus "27-28" (two
// days) or "22 (notation vote)". The STATEMENT lands on the LAST day of the range.
// The year comes from the panel — its heading, or any statement link inside it; a
// panel with neither is skipped, never guessed.
export function parseFomcCalendar(html) {
  const out = new Set();
  for (const panel of String(html).split(/<div class="panel panel-default">/).slice(1)) {
    const yr = (panel.match(/(20\d{2}) FOMC Meetings/) || panel.match(/monetary(20\d{2})\d{4}/) || panel.match(/panel-heading[\s\S]{0,300}?>(20\d{2})</) || [])[1];
    if (!yr) continue;
    for (const m of panel.matchAll(/fomc-meeting__month[^>]*><strong>([A-Za-z]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]*)</g)) {
      if (/notation|unscheduled/i.test(m[2])) continue;
      const days = m[2].match(/\d{1,2}/g); const mm = mon(m[1]);
      if (days && mm) out.add(iso(yr, mm, days[days.length - 1]));
    }
  }
  return [...out];
}
// BEA release schedule: a "Year 2026" table header, then rows of "October 29" + title.
// Row-scoped, because GDP and PCE share release days. Returns
// { 'Personal Income and Outlays, September 2026': '2026-10-29', ... }.
export function parseBeaSchedule(html) {
  const out = {};
  const blocks = String(html).split(/Year\s+(20\d{2})<\/th>/);
  for (let i = 1; i < blocks.length; i += 2) {
    const yr = blocks[i];
    for (const row of (blocks[i + 1] || '').split(/<tr\b/).slice(1)) {
      const t = row.match(/(Personal Income and Outlays, [A-Za-z]+ 20\d{2})/); if (!t) continue;
      const d = row.match(/release-date">\s*([A-Za-z]+)\s+(\d{1,2})/); const mm = d && mon(d[1]);
      if (mm) out[t[1].trim()] = iso(yr, mm, d[2]);
    }
  }
  return out;
}
// Pure. sources: { CPI: [iso]|null, PPI, NFP, FOMC: [iso]|null, PCE: {title: iso}|null }
// where null means the source did not answer this run. One finding per upcoming event.
export function compareCalendar(events, sources, now = Date.now()) {
  const out = [];
  for (const ev of events) {
    if (Date.parse(ev.date) < now - 86400e3) continue;
    const src = sources[ev.kind];
    const f = { id: ev.id, kind: ev.kind, date: ev.date, verifiedOn: ev.verifiedOn || null };
    if (src === null || src === undefined) { out.push({ ...f, status: 'unchecked' }); continue; }
    if (ev.kind === 'PCE') {
      // PCE releases the PREVIOUS month's Personal Income and Outlays.
      const [y, m] = ev.date.split('-').map(Number);
      const title = `Personal Income and Outlays, ${MONTHS[(m + 10) % 12]} ${m === 1 ? y - 1 : y}`;
      const official = src[title];
      out.push(official === undefined ? { ...f, status: 'unlisted', title } : official === ev.date ? { ...f, status: 'ok' } : { ...f, status: 'mismatch', official });
      continue;
    }
    if (!Array.isArray(src) || !src.length) { out.push({ ...f, status: 'unchecked' }); continue; }
    if (src.includes(ev.date)) { out.push({ ...f, status: 'ok' }); continue; }
    const near = src.filter((d) => d.slice(0, 7) === ev.date.slice(0, 7)); // same month says what it should have been
    out.push(near.length ? { ...f, status: 'mismatch', official: near[0] } : { ...f, status: 'unlisted' });
  }
  return out;
}
// Pure formatter: mismatches are [OPERATOR] lines carrying both dates; unchecked events
// are loud only when near AND not freshly stamped; exactly one summary line.
export function verifyReport(findings, unreachable = {}, now = Date.now()) {
  const lines = [];
  for (const f of findings.filter((x) => x.status === 'mismatch')) lines.push(`[macro][OPERATOR] ${f.kind} ${f.id}: calendar says ${f.date}, official schedule says ${f.official} — fix data/macro-calendar.json (the file is truth; nothing here edits it)`);
  const soon = (f) => Date.parse(f.date) - now < 14 * 86400e3;
  const stale = (f) => !f.verifiedOn || now - Date.parse(f.verifiedOn) > 45 * 86400e3;
  for (const f of findings.filter((x) => (x.status === 'unchecked' || x.status === 'unlisted') && soon(x) && stale(x))) lines.push(`[macro][OPERATOR] ${f.kind} ${f.id} on ${f.date} is within 14d, ${f.status} this week and ${f.verifiedOn ? 'last verified ' + f.verifiedOn : 'never verified'} — check ${VERIFY_SOURCES[f.kind]} by hand (browser pane)`);
  const n = (s) => findings.filter((x) => x.status === s).length;
  const un = Object.entries(unreachable).map(([k, why]) => `${k} ${why}`).join(', ');
  lines.push(`[macro] calendar verified: ${n('ok')} ok · ${n('mismatch')} mismatch · ${n('unchecked') + n('unlisted')} unchecked of ${findings.length} upcoming${un ? ` · unreachable: ${un}` : ''}`);
  return lines;
}
let lastVerify = 0;
export async function verifyCalendar({ fetchImpl = fetch, force = false, now = Date.now() } = {}) {
  if (!force && now - lastVerify < 7 * 24 * 3600e3) return null;
  lastVerify = now;
  const sources = {}, unreachable = {};
  const get = async (kind, parse) => {
    try {
      const res = await fetchImpl(VERIFY_SOURCES[kind], { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(String(res.status));
      sources[kind] = parse(await res.text());
    } catch (e) { sources[kind] = null; unreachable[kind] = e.message; }
  };
  await Promise.all([get('CPI', parseBlsSchedule), get('PPI', parseBlsSchedule), get('NFP', parseBlsSchedule), get('FOMC', parseFomcCalendar), get('PCE', parseBeaSchedule)]);
  const findings = compareCalendar(loadCalendar(), sources, now);
  const lines = verifyReport(findings, unreachable, now);
  for (const l of lines) (l.includes('[OPERATOR]') ? console.error : console.log)(l);
  return { findings, unreachable, lines };
}
