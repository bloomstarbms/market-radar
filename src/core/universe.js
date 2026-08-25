// Tradeable-universe sweep — spec §1.2 restored to gate-first for UNIVERSE DEFINITION.
//
// The alert-time gate measurement told the real story: 45 alerting pairs, 2 passed.
// The detectors were pointed at a population pre-selected to fail — 8%+/5m moves are a
// property of illiquid pairs almost by definition — so ~94% of detector surface and
// outcome-table volume was spent on symbols never executable at $10k–$100k.
//
// Fix: universe definition returns to gate-first (as the spec had it); "score first,
// gate survivors" remains only as the RUNTIME order for freshness checks.
//
//   SWEEP    slow background pass over all USDT pairs with >=$2M reported 24h volume,
//            spread across UNIVERSE_SWEEP_H hours — same L2 calls, amortized instead
//            of burst. Volume here is only sweep CANDIDACY (who gets tested); the L2
//            walk is the gate, so wash-inflated volume just earns a test it fails.
//   VERDICT  PASS   -> detector alert proceeds; alert-time check is a cached freshness
//                     confirmation, not the primary filter.
//            FAIL   -> dropped free, before scoring. The 94% stops existing.
//            UNKNOWN-> not swept yet; falls through to the alert-time gate, whose
//                     result seeds this store. Keeps day-one behavior sane and
//                     converges to ~zero alert-time calls.
//
// CARVE-OUT: catalysts (LISTING/UPBIT/PERP/ANNOUNCE/UNLOCK/TGE/CPI) never consult the
// universe. A new listing is <48h old and fails the gate BY CONSTRUCTION — the event
// is the signal; tradeability is answered afterwards on the venue where it now lives.
// Gate the trade, not the catalyst. (They are outside GATED_TYPES, enforced there.)
import { config } from '../config.js';
import { EXCHANGES } from '../sources/cex/exchanges.js';
import { checkExecutable } from './executability.js';
import { getState, save } from './store.js';
import { classifySymbol } from './taxonomy.js';

const SWEEP_H = Number(process.env.UNIVERSE_SWEEP_H || 6);
const MIN_CANDIDATE_VOL = Number(process.env.UNIVERSE_MIN_VOL || 2_000_000);
const STALE_MS = 24 * 3600e3; // a verdict older than this counts as UNKNOWN

const key = (ex, sym) => `${ex}:${sym}`;

export function universeVerdict(exchange, symbol) {
  const u = getState().universe || {};
  const v = u[key(exchange, symbol)];
  if (!v || Date.now() - v.at > STALE_MS) return 'UNKNOWN';
  return v.pass ? 'PASS' : 'FAIL';
}

// The alert-time gate feeds its verdicts back here, so UNKNOWN symbols that alert get
// absorbed into the universe without waiting for the sweep to reach them.
export function recordVerdict(exchange, symbol, result) {
  const st = getState();
  st.universe ??= {};
  st.universe[key(exchange, symbol)] = {
    at: Date.now(), pass: !!result.pass, status: result.status,
    usd: result.executableUsd ?? 0,
  };
  save();
}

export function universeStats() {
  const u = getState().universe || {};
  const fresh = Object.values(u).filter((v) => Date.now() - v.at <= STALE_MS);
  return {
    tracked: fresh.length,
    pass: fresh.filter((v) => v.pass).length,
    fail: fresh.filter((v) => !v.pass && v.status === 'BLOCKED').length,
    unverifiable: fresh.filter((v) => v.status === 'UNVERIFIABLE').length,
  };
}

let sweeping = false;
export function startUniverseSweep() {
  if (sweeping) return;
  sweeping = true;
  (async function loop() {
    while (sweeping) {
      try {
        // Build candidate list fresh each pass, from live tickers.
        const candidates = [];
        for (const [ex, fetcher] of Object.entries(EXCHANGES)) {
          if (!config.cexExchanges.includes(ex)) continue;
          try {
            const tickers = await fetcher();
            const st = getState();
            st.adv ??= {};
            const today = new Date().toISOString().slice(0, 10);
            for (const t of tickers) {
              if ((t.quoteVol24h || 0) >= MIN_CANDIDATE_VOL) candidates.push([ex, t.symbol]);
              // ADV accumulation: persist the daily max reported 24h volume per symbol.
              // In 30 days this becomes the REAL unlock-pressure denominator (§4.2's
              // avg-daily-volume) with zero new dependencies. Until then the only
              // pressure metric we print is pressure_vs_book — book depth and ADV
              // differ by 2+ orders of magnitude, so §4.2's 0.5/2/5 severity bands
              // must NOT be applied to the book-depth proxy.
              // Leveraged tokens and xStocks must not accumulate ADV: they are not
              // tradeable universe members, and 429 of 3,061 entries were EXCLUDE-class
              // before v0.23.5. Harmless to other symbols' denominators, but they
              // inflated the heartbeat's `adv N cells` figure and made the instrument
              // less readable — an instrument you have to mentally discount is a
              // degraded instrument.
              if ((t.quoteVol24h || 0) > 0
                  && classifySymbol(String(t.symbol).toUpperCase().replace(/(USDT|USDC|USD|BUSD|KRW|BTC|ETH)$/, '')).state !== 'EXCLUDE') {
                const a = (st.adv[t.symbol] ??= {});
                a[today] = Math.max(a[today] || 0, Math.round(t.quoteVol24h));
                for (const d of Object.keys(a)) if (Date.now() - Date.parse(d) > 35 * 86400e3) delete a[d];
              }
            }
            save();
          } catch (e) { console.error(`[universe] ${ex} tickers failed: ${e.message}`); }
        }
        const spacing = Math.max(1500, (SWEEP_H * 3600e3) / Math.max(1, candidates.length));
        console.log(`[universe] sweep start: ${candidates.length} candidates, ~${(spacing / 1000).toFixed(0)}s spacing`);
        for (const [ex, sym] of candidates) {
          if (!sweeping) return;
          try { recordVerdict(ex, sym, await checkExecutable(ex, sym)); } catch { /* next */ }
          await new Promise((r) => setTimeout(r, spacing));
        }
        const s = universeStats();
        // The funnel, visible — spec §1.2's startup log.
        console.log(`[universe] sweep done: ${s.tracked} scanned · ${s.pass} PASS · ${s.fail} blocked · ${s.unverifiable} unverifiable`);
      } catch (e) {
        console.error('[universe] sweep error:', e.message);
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
  })();
}
export function stopUniverseSweep() { sweeping = false; }
