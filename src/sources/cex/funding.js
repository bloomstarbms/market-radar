// Funding-rate extremes on Binance USDT-perps — your best-performing signal.
// v0.6: adds funding VELOCITY (is the squeeze building?) and OPEN INTEREST
// confirmation (is real money behind it?). OI is only fetched for the handful
// of symbols that already clear the funding bar, so the call cost stays tiny.
import { dispatch } from '../../core/dispatcher.js';
import { notePulse } from '../../core/pulse.js';
import { getState, save } from '../../core/store.js';

// 99th percentile of a pair's OWN |funding| over ~90 days (Binance publishes one
// settlement every 8h, so 270 records). Cached 7 days: the shape of a pair's funding
// distribution moves slowly, and this costs one call per candidate.
// Pure so the state machine is fixturable without network or live state.
// fire on ENTRY, on a 50%+ intensification, or on a SIGN FLIP; never on mere
// persistence. Clearing uses hysteresis (0.8x) so a pair oscillating around the
// threshold cannot re-enter every cycle.
export function fundingDecision(f, thresh, state) {
  const abs = Math.abs(f);
  if (abs < thresh) return { fire: false, clear: !!state && abs < thresh * 0.8 };
  if (!state) return { fire: true, clear: false, reason: 'entered' };
  if (Math.sign(f) !== Math.sign(state.entryF)) return { fire: true, clear: false, reason: 'flipped' };
  if (abs >= Math.abs(state.entryF) * 1.5) return { fire: true, clear: false, reason: 'intensified' };
  return { fire: false, clear: false };
}

const PCT_TTL = 7 * 86400e3;
async function pairThreshold(symbol, st) {
  const c = st.fundingPct[symbol];
  if (c && Date.now() - c.at < PCT_TTL) return c.p99;
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=270`);
    if (!res.ok) throw new Error('fundingRate ' + res.status);
    const hist = await res.json();
    const vals = hist.map((h) => Math.abs(Number(h.fundingRate) * 100)).filter(Number.isFinite).sort((a, b) => a - b);
    if (vals.length < 30) { st.fundingPct[symbol] = { p99: null, at: Date.now() }; return null; }
    // length-1 indexing (the winsorize off-by-one lesson: floor(p*n) selects the max)
    const p99 = vals[Math.floor(0.99 * (vals.length - 1))];
    st.fundingPct[symbol] = { p99, at: Date.now() };
    return p99;
  } catch {
    // Unknown distribution must not mean "fire freely": fall back to the absolute
    // floor by returning null, which max()s to RULES.extremePct at the call site.
    st.fundingPct[symbol] = { p99: null, at: Date.now() };
    return null;
  }
}

const RULES = {
  extremePct: Number(process.env.FUNDING_MIN_PCT || 0.5),  // |funding| >= this %/8h -> alert (user-tuned)
  severePct: Number(process.env.FUNDING_SEVERE_PCT || 0.75), // |funding| >= this -> extra-severe
  velocityPct: 0.03,   // funding moved this much since last poll -> squeeze building
  oiSurgePct: 10,      // open interest up this much in ~1h -> real positioning
  intervalSec: 900,    // poll every 15 min
  cooldownMin: 240,
};

let lastPoll = 0;
const prevFunding = new Map(); // symbol -> last funding %
const oiHistory = new Map();   // symbol -> [{oi, ts}]

async function longShortRatio(symbol) {
  try {
    const res = await fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=15m&limit=1`);
    if (!res.ok) return null;
    const j = await res.json();
    if (!j[0]) return null;
    return {
      ratio: Number(j[0].longShortRatio),
      longPct: Number(j[0].longAccount) * 100,
      shortPct: Number(j[0].shortAccount) * 100,
    };
  } catch { return null; }
}

async function openInterest(symbol) {
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`);
    if (!res.ok) return null;
    const j = await res.json();
    return Number(j.openInterest) || null;
  } catch { return null; }
}

export async function pollFunding() {
  if (Date.now() - lastPoll < RULES.intervalSec * 1000) return;
  lastPoll = Date.now();
  let data;
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex');
    if (!res.ok) throw new Error(`fapi ${res.status}`);
    data = await res.json();
  } catch (e) { console.error('[funding] poll failed:', e.message); return; }
  notePulse('funding');

  const candidates = [];
  for (const r of data) {
    if (!r.symbol.endsWith('USDT')) continue;
    const f = Number(r.lastFundingRate) * 100;
    const prev = prevFunding.get(r.symbol);
    prevFunding.set(r.symbol, f);
    // Absolute floor stays as the CHEAP GATE (gate before you invest — it runs on all
    // ~860 pairs and costs nothing); the percentile check below only pays for the
    // handful that survive it.
    if (Math.abs(f) < RULES.extremePct) continue;
    candidates.push({ symbol: r.symbol, f, mark: Number(r.markPrice), prev });
  }

  // PERCENTILE THRESHOLD + STATE-ENTRY DEDUP (v0.23.2).
  //
  // FUNDING fired 455 times in a ~30-day corpus — ~15/day from ONE unbudgeted fact
  // type, enough to take the channel from silent to noisy in a single step. Facts are
  // unbudgeted on the premise that their volume is bounded by how often things
  // HAPPEN; FUNDING breaks that premise because its threshold is ours to choose. So
  // the threshold has to do the work a budget is not allowed to do.
  //
  // 1. RELATIVE, not absolute: a pair whose funding routinely sits at -0.4% is not
  //    extreme at -0.4%. Fire at the 99th percentile of THAT PAIR'S OWN 90-day
  //    distribution, with the absolute floor retained as a backstop.
  // 2. STATE-ENTRY, not state-presence: fire on ENTERING the extreme state and on
  //    material change, never on every poll while it persists. This is the recurrence
  //    lesson applied to facts — without it a single pair parked at extreme funding
  //    produces days of identical alerts.
  const st = getState();
  st.fundingPct ??= {};   // symbol -> { p99, at }
  st.fundingState ??= {}; // symbol -> { enteredAt, entryF, lastF }
  const admitted = [];
  for (const c of candidates) {
    const p = await pairThreshold(c.symbol, st);
    const thresh = Math.max(RULES.extremePct, p ?? 0);
    const abs = Math.abs(c.f);
    const d = fundingDecision(c.f, thresh, st.fundingState[c.symbol]);
    if (d.clear) delete st.fundingState[c.symbol];
    if (d.fire) {
      st.fundingState[c.symbol] = { enteredAt: Date.now(), entryF: c.f, lastF: c.f };
      admitted.push({ ...c, thresh, reason: d.reason });
    } else if (st.fundingState[c.symbol]) st.fundingState[c.symbol].lastF = c.f;
  }
  save();
  if (candidates.length !== admitted.length) {
    console.log(`[funding] ${candidates.length} over absolute floor → ${admitted.length} admitted (percentile + state-entry)`);
  }
  candidates.length = 0;
  candidates.push(...admitted);

  let n = 0;
  for (const c of candidates.slice(0, 25)) { // cap OI calls per cycle
    const [oi, ls] = await Promise.all([openInterest(c.symbol), longShortRatio(c.symbol)]);
    const hist = oiHistory.get(c.symbol) || [];
    if (oi) { hist.push({ oi, ts: Date.now() }); while (hist.length > 5) hist.shift(); oiHistory.set(c.symbol, hist); }
    const oldOi = hist.length > 1 ? hist[0].oi : null;
    const oiChange = oldOi ? ((oi - oldOi) / oldOi) * 100 : null;

    const shortsPay = c.f < 0;
    // velocity: is the funding becoming MORE extreme since last poll?
    const velocity = c.prev !== undefined ? c.f - c.prev : null;
    const building = velocity !== null && Math.sign(velocity) === Math.sign(c.f) && Math.abs(velocity) >= RULES.velocityPct;
    const oiConfirm = oiChange !== null && oiChange >= RULES.oiSurgePct;

    // Severity: extremes alone = MEDIUM; add velocity or OI confirmation for HIGH
    const severe = Math.abs(c.f) >= RULES.severePct;
    const severity = (severe && (building || oiConfirm)) ? 'HIGH'
      : (severe || building || oiConfirm) ? 'HIGH' : 'MEDIUM';

    const lines = [
      // FACT phrasing: state who pays whom and how extreme it is for THIS pair.
      // "squeeze fuel" / "flush risk" were directional editorialising on an unscored
      // fact — the annualised figure and the percentile say more and assert less.
      `${shortsPay ? 'Shorts paying longs' : 'Longs paying shorts'} ${Math.abs(c.f).toFixed(3)}%/8h · ${(c.f * 3 * 365).toFixed(0)}% annualised`,
      `Threshold for this pair: ${c.thresh.toFixed(3)}% (99th pctile of its own 90d funding)`
        + (c.reason === 'entered' ? ' — just entered the extreme state'
          : c.reason === 'flipped' ? ' — funding FLIPPED SIGN'
          : ' — intensified 50%+ since entry'),
    ];
    if (building) lines.push(`⚡ Squeeze BUILDING: funding moved ${velocity > 0 ? '+' : ''}${velocity.toFixed(3)}% since last check`);
    if (oiConfirm) lines.push(`📈 Open interest +${oiChange.toFixed(1)}% — real money entering, not just noise`);
    else if (oiChange !== null) lines.push(`Open interest ${oiChange >= 0 ? '+' : ''}${oiChange.toFixed(1)}%`);
    // Long/short crowd confirmation: extreme positioning is where reversals fire
    if (ls) {
      const crowded = ls.longPct >= 70 ? 'long' : ls.shortPct >= 65 ? 'short' : null;
      let posLine = `Positioning: ${ls.longPct.toFixed(0)}% of traders LONG vs ${ls.shortPct.toFixed(0)}% SHORT`;
      if (crowded) posLine += ` — crowd heavily ${crowded}, reversal risk`;
      if (crowded && shortsPay === (crowded === 'short')) posLine += ' ⚡ matches funding';
      lines.push(posLine);
    }
    lines.push(`Mark price: $${c.mark}`);

    if (await dispatch({
      source: 'CEX', type: 'FUNDING', severity, key: c.symbol, cooldownMin: RULES.cooldownMin,
      title: `${c.symbol} funding ${c.f.toFixed(3)}%/8h${building ? ' (building)' : ''}${oiConfirm ? ' + OI surge' : ''}`,
      lines, url: `https://www.binance.com/en/futures/${c.symbol}`,
      track: { kind: 'cex', exchange: 'binance', symbol: c.symbol, price: c.mark },
    })) n++;
  }
  console.log(`[funding] ${data.length} perps · ${candidates.length} extremes${n ? ` · ${n} alerts` : ''}`);
}
export { RULES };
