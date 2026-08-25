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
          ev.verified ? 'Date verified against the official schedule.' : '⚠️ Date from hand-entered schedule, not yet re-verified — check bls.gov/schedule.',
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
        const lagMin = Math.round((now - due) / 60e3);
        title = `${ev.kind} released — first reaction (T+${tPlus}m)`;
        lines = [
          b !== null ? `BTC ${b > 0 ? '+' : ''}${b}% · ETH ${e > 0 ? '+' : ''}${e}% from just before the print to T+${tPlus}m`
            : 'Reaction basis unavailable (bot was not up pre-print).',
          ...(lagMin > 5 ? [`⏱ delivered ${lagMin}m after the T+5m mark — the window above is as stated, not live`] : []),
          'Print value not yet published by the source — reaction is the tradeable part; figure follows at T+30m if available.',
        ];
      } else { // t30m
        const snap = await marketSnap();
        const b5 = pct(rec.pre?.btc, rec.post5?.btc), b30 = pct(rec.pre?.btc, snap.btc);
        const held = b5 !== null && b30 !== null
          ? (Math.sign(b30) === Math.sign(b5) && Math.abs(b30) >= Math.abs(b5) * 0.5 ? 'HOLDING' : 'FADING')
          : 'unknown';
        const tPlus = Math.round((now - t0) / 60e3);
        const lagMin = Math.round((now - due) / 60e3);
        title = `${ev.kind} +${tPlus}m — initial move is ${held}`;
        lines = [
          b30 !== null ? `BTC ${b30 > 0 ? '+' : ''}${b30}% from pre-print to T+${tPlus}m (was ${b5 > 0 ? '+' : ''}${b5}% at the first reading)` : 'No pre-print basis.',
          ...(lagMin > 5 ? [`⏱ delivered ${lagMin}m after the T+30m mark — observation window as stated, not live`] : []),
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

// Weekly verifier: fetch the BLS schedule page, look for our hand-entered dates near
// our hand-entered kinds. On mismatch or fetch failure -> OPERATOR log line, loudly.
// Never mutates the calendar.
let lastVerify = 0;
export async function verifyCalendar() {
  if (Date.now() - lastVerify < 7 * 24 * 3600e3) return;
  lastVerify = Date.now();
  try {
    const res = await fetch('https://www.bls.gov/schedule/news_release/cpi.htm', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`bls ${res.status}`);
    const html = await res.text();
    for (const ev of loadCalendar()) {
      if (ev.kind !== 'CPI' || Date.parse(ev.date) < Date.now()) continue;
      const [y, m, d] = ev.date.split('-').map(Number);
      const monthName = new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
      // Look for "Aug. 12" / "Aug 12" style near-matches in the schedule table.
      const rx = new RegExp(`${monthName}\\.?\\s+0?${d}\\b`);
      if (!rx.test(html)) console.error(`[macro][OPERATOR] CPI ${ev.date} not found on BLS schedule page — hand-entered date may be wrong or page reformatted. Verify manually.`);
    }
  } catch (e) {
    console.error(`[macro][OPERATOR] calendar verification fetch failed (${e.message}) — calendar unaffected, verify manually this week.`);
  }
}
