// HYPERLIQUID — new perp markets, funding extremes, open-interest moves (v0.33.0).
//
// One POST per poll (`metaAndAssetCtxs`, weight 20 of a 1200/min per-IP budget) returns
// every market with funding, open interest, mark and volume. Everything below reads that
// one answer; the only other calls are a candidate's own funding history (paged, cached
// 7 days, like Binance's) and the executability book the dispatcher fetches for facts.
//
// Three facts, each built the way the Binance modules taught:
//
//   LISTING  Hyperliquid publishes no listing announcements — a new market simply
//            appears in `universe`. So: diff the live (not isDelisted) name set. The
//            baseline is PERSISTED in state (st.hlMarkets), unlike listings.js whose
//            in-memory Map re-baselines on every restart and swallows anything listed
//            while the bot was down (six restarts on 2026-09-25 alone). Names go
//            through classifySymbol (routes.js EMITTERS enforces it); ≥3 in one poll is
//            ONE message, same batch rule as the CEX paths.
//
//   FUNDING  Hyperliquid funding settles HOURLY; Binance every 8h. The floor is the
//            Binance floor converted, not re-chosen: 0.5%/8h = 0.0625%/h. On top, the
//            market's own 99th percentile over ~90 days of hourly history, and the same
//            state-entry machine (fundingDecision) so a market parked at an extreme
//            fires once. A notional OI floor keeps $50k markets out: their funding is a
//            fact about nobody.
//
//   OI       No threshold here can be borrowed, and Hyperliquid serves no OI history,
//            so the percentile is EARNED: hourly 1h-change samples accumulate in state
//            (coin-denominated, so price moves do not masquerade as positioning). A
//            market pushes only once it holds 7 days of its own samples; before that a
//            crossing goes to the digest pool and the log as "would have fired". Same
//            maturity rule as ADV — ship the measurement, earn the severity.
import { dispatch } from '../../core/dispatcher.js';
import { notePulse } from '../../core/pulse.js';
import { getState, save } from '../../core/store.js';
import { classifySymbol } from '../../core/taxonomy.js';
import { noteUnclassified, noteExcluded } from '../../core/unclassified.js';
import { fundingDecision } from '../cex/funding.js';

export const HL_INFO = 'https://api.hyperliquid.xyz/info';
export const RULES = {
  pollSec: Number(process.env.HL_POLL_SEC || 60),
  fundingFloorPctH: Number(process.env.HL_FUNDING_MIN_PCT_H || 0.0625), // = Binance 0.5%/8h, per hour
  fundingMinOiUsd: Number(process.env.HL_FUNDING_MIN_OI_USD || 1_000_000),
  oiFloorPct: Number(process.env.HL_OI_MIN_PCT || 15),                  // backstop under the earned p99
  oiMinOiUsd: Number(process.env.HL_OI_MIN_OI_USD || 2_000_000),
  oiMatureSamples: 168,   // 7 days of hourly samples before an OI move may push
  oiKeepSamples: 336,     // 14 days retained
  fundingCooldownMin: 240,
  oiCooldownMin: 360,
};
const PCT_TTL = 7 * 86400e3;
const post = async (body, fetchImpl = fetch) => {
  const res = await fetchImpl(HL_INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`hyperliquid ${body.type} ${res.status}`);
  return res.json();
};

// ---------------------------------------------------------------- pure helpers
// One row per market from metaAndAssetCtxs. Funding stays in its native unit (per hour).
export function marketRows(meta, ctxs) {
  return (meta?.universe || []).map((u, i) => {
    const c = ctxs?.[i] || {};
    const oiCoins = Number(c.openInterest), px = Number(c.markPx ?? c.oraclePx);
    return {
      name: u.name, delisted: !!u.isDelisted, maxLeverage: u.maxLeverage, onlyIsolated: !!u.onlyIsolated,
      fundingPctH: Number(c.funding) * 100, oiCoins, px, oiUsd: oiCoins * px, dayVolUsd: Number(c.dayNtlVlm),
    };
  }).filter((r) => r.name);
}
// kPEPE is 1000 PEPE — the classifier wants the asset, not the lot size.
export const baseName = (name) => String(name).replace(/^k(?=[A-Z])/, '');
// LISTING diff against a PERSISTED baseline. No baseline -> this poll IS the baseline.
export function listingDiff(prevNames, rows) {
  const live = rows.filter((r) => !r.delisted).map((r) => r.name);
  if (!Array.isArray(prevNames)) return { baseline: true, live, fresh: [], gone: [] };
  const prev = new Set(prevNames), now = new Set(live);
  return { baseline: false, live, fresh: live.filter((n) => !prev.has(n)), gone: prevNames.filter((n) => !now.has(n)) };
}
// p99 with length-1 indexing (the winsorize off-by-one lesson from funding.js).
export function p99(values) {
  const v = values.map(Math.abs).filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(0.99 * (v.length - 1))] : null;
}
// The ring entry nearest to `ago` ms before now, if the ring reaches that far back.
export function changeOver(ring, ago = 3600e3, now = Date.now(), tolerance = 5 * 60e3) {
  if (!ring?.length) return null;
  const target = now - ago;
  if (ring[0].ts > target + tolerance) return null; // ring does not reach back far enough
  let best = ring[0];
  for (const s of ring) if (Math.abs(s.ts - target) < Math.abs(best.ts - target)) best = s;
  const last = ring[ring.length - 1];
  const pct = (a, b) => (a && b ? ((b - a) / a) * 100 : null);
  return { oiPct: pct(best.oiCoins, last.oiCoins), pxPct: pct(best.px, last.px), fromOiUsd: best.oiCoins * best.px, toOiUsd: last.oiCoins * last.px };
}
// OI maturity: a market pushes only on its own earned distribution.
export function oiThreshold(samples, rules = RULES) {
  const mature = (samples?.length || 0) >= rules.oiMatureSamples;
  return { mature, n: samples?.length || 0, thresh: Math.max(rules.oiFloorPct, (mature ? p99(samples) : null) ?? 0) };
}
const usd = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n || 0)}`);
const sgn = (n, d = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`;
const url = (name) => `https://app.hyperliquid.xyz/trade/${name}`;

// ---------------------------------------------------------------- messages, pure
export function hlListingMessage(r, verdict) {
  return {
    title: `${r.name}-PERP on HYPERLIQUID`,
    lines: [
      `${Number.isFinite(r.px) && r.px > 0 ? `Mark $${r.px}` : 'No mark yet'} · max leverage ${r.maxLeverage}x${r.onlyIsolated ? ' · isolated margin only' : ''}`,
      `Open interest ${usd(r.oiUsd)} · 24h volume ${usd(r.dayVolUsd)}`,
      ...(verdict?.state === 'UNRECOGNISED' ? [`⚠️ ${verdict.reason}`] : []),
    ],
    operatorLines: ['New market in Hyperliquid\'s live market list (no announcement feed exists; baseline persisted across restarts)'],
    url: url(r.name),
  };
}
export function hlListingBatchMessage(names) {
  return {
    title: `${names.length} new perp markets on HYPERLIQUID`,
    lines: [names.slice(0, 12).join(', ') + (names.length > 12 ? ` … +${names.length - 12} more` : '')],
    operatorLines: [`Batched: ${names.length} markets in one poll — one event, not ${names.length}.`],
    url: 'https://app.hyperliquid.xyz/trade',
  };
}
export function hlFundingMessage(c, { oi = null } = {}) {
  const shortsPay = c.fundingPctH < 0;
  const entered = c.reason === 'entered' ? 'just entered' : c.reason === 'flipped' ? 'sign flipped' : 'intensified 50%+ since entry';
  return {
    title: `⚡ FUNDING · ${c.name} (HYPERLIQUID) ${sgn(c.fundingPctH, 4)}%/h`,
    lines: [
      `${(c.fundingPctH * 24 * 365).toFixed(0)}% annualised · ${shortsPay ? 'shorts paying longs' : 'longs paying shorts'} · ${sgn(c.fundingPctH * 8, 3)}%/8h equivalent`,
      `99th pctile of its own 90d · ${entered}`,
      `Open interest ${usd(c.oiUsd)}${oi?.oiPct != null ? ` · ${sgn(oi.oiPct)}% over 1h` : ''}`,
      `mark $${c.px}`,
    ],
    operatorLines: [`Threshold for this market: ${c.thresh.toFixed(4)}%/h (own 90d p99, floor ${RULES.fundingFloorPctH}%/h = Binance's 0.5%/8h) · reason: ${c.reason}`],
    url: url(c.name),
  };
}
export function hlOiMessage(c) {
  const entered = c.reason === 'entered' ? 'just entered' : c.reason === 'flipped' ? 'sign flipped' : 'intensified 50%+ since entry';
  return {
    title: `📊 OPEN INTEREST · ${c.name} (HYPERLIQUID) ${sgn(c.oiPct)}% in 1h`,
    lines: [
      `${usd(c.fromOiUsd)} → ${usd(c.toOiUsd)} · ${sgn(c.oiPct)}% in contracts`,
      `Price ${sgn(c.pxPct)}% over the same hour · funding ${sgn(c.fundingPctH, 4)}%/h`,
      `99th pctile of its own 1h changes (${Math.round(c.n / 24)}d) · ${entered}`,
    ],
    operatorLines: [`Threshold for this market: ${c.thresh.toFixed(1)}% (own p99 of ${c.n} hourly samples, floor ${RULES.oiFloorPct}%) · reason: ${c.reason}`],
    url: url(c.name),
  };
}

// ---------------------------------------------------------------- funding percentile
// ~90 days of hourly history = 2160 records at 500 per call: page forward from the
// start. Bounded to 6 calls; a short history is a smaller sample, not a wrong one, and
// fewer than 72 records means "unknown", which falls back to the floor.
export async function fundingP99(name, st, { fetchImpl = fetch, now = Date.now() } = {}) {
  const c = st.hlFundingPct[name];
  if (c && now - c.at < PCT_TTL) return c.p99;
  const vals = [];
  try {
    let start = now - 90 * 86400e3;
    for (let page = 0; page < 6 && start < now; page++) {
      const j = await post({ type: 'fundingHistory', coin: name, startTime: start }, fetchImpl);
      if (!Array.isArray(j) || !j.length) break;
      for (const h of j) vals.push(Number(h.fundingRate) * 100);
      const lastT = j[j.length - 1].time;
      if (j.length < 500 || !(lastT > start)) break;
      start = lastT + 1;
    }
  } catch { /* unknown distribution -> floor */ }
  const v = vals.length >= 72 ? p99(vals) : null;
  st.hlFundingPct[name] = { p99: v, n: vals.length, at: now };
  return v;
}

// ---------------------------------------------------------------- poll
let lastPoll = 0;
const rings = new Map(); // name -> [{ts, oiCoins, px}], ~70 min, in memory (a restart re-fills in an hour)
const RING_MS = 70 * 60e3;

export async function pollHyperliquid() {
  if (Date.now() - lastPoll < RULES.pollSec * 1000) return;
  lastPoll = Date.now();
  let rows;
  try {
    const [meta, ctxs] = await post({ type: 'metaAndAssetCtxs' });
    rows = marketRows(meta, ctxs);
    if (!rows.length) throw new Error('empty universe');
  } catch (e) { console.error('[hyperliquid] poll failed:', e.message); return; }
  notePulse('dex:hyperliquid');
  const st = getState();
  st.hlFundingPct ??= {}; st.hlFundingState ??= {}; st.hlOiState ??= {}; st.hlOiHist ??= {};
  const now = Date.now();
  let alerts = 0;

  // -- LISTINGS
  const d = listingDiff(st.hlMarkets?.names, rows);
  st.hlMarkets = { names: d.live, at: now };
  if (d.baseline) console.log(`[hyperliquid] baseline: ${d.live.length} live markets (persisted — restarts no longer re-baseline)`);
  for (const g of d.gone) console.log(`  [hyperliquid] ${g} left the live market list (delisted)`);
  const fresh = [];
  for (const name of d.fresh) {
    const r = rows.find((x) => x.name === name);
    const verdict = classifySymbol(baseName(name), 'USD', 'hyperliquid');
    if (verdict.state === 'EXCLUDE') { noteExcluded(name, verdict.cls, verdict.reason, 'hyperliquid'); console.log(`  [hyperliquid] ${name} excluded — ${verdict.reason}`); continue; }
    if (verdict.state === 'UNRECOGNISED') noteUnclassified('hyperliquid', `[SYMBOL_UNRECOGNISED] ${name} — ${verdict.reason}`);
    fresh.push({ r, verdict });
  }
  if (fresh.length >= 3) {
    if (await dispatch({ source: 'PERPDEX', type: 'PERP', severity: 'HIGH', kind: 'FACT', venue: 'hyperliquid',
      key: `hyperliquid:batch:${new Date(now).toISOString().slice(0, 13)}`, cooldownMin: 60,
      ...hlListingBatchMessage(fresh.map((f) => f.r.name)) })) alerts++;
  } else {
    for (const { r, verdict } of fresh) {
      if (await dispatch({ source: 'PERPDEX', type: 'PERP', severity: 'HIGH', kind: 'FACT', venue: 'hyperliquid',
        key: `hyperliquid:${r.name}`, cooldownMin: 24 * 60, ...hlListingMessage(r, verdict),
        track: r.px > 0 ? { kind: 'cex', exchange: 'hyperliquid', symbol: r.name, price: r.px } : undefined })) alerts++;
    }
  }

  // -- rings and hourly OI samples (coin-denominated)
  const live = rows.filter((r) => !r.delisted && r.px > 0 && Number.isFinite(r.oiCoins));
  for (const r of live) {
    const ring = rings.get(r.name) || [];
    ring.push({ ts: now, oiCoins: r.oiCoins, px: r.px });
    while (ring.length && now - ring[0].ts > RING_MS) ring.shift();
    rings.set(r.name, ring);
    if (r.oiUsd < RULES.oiMinOiUsd) continue;
    const h = (st.hlOiHist[r.name] ??= { t: 0, d: [] });
    if (now - h.t >= 3600e3) {
      const ch = changeOver(ring, 3600e3, now);
      if (ch?.oiPct != null) { h.d.push(Math.round(ch.oiPct * 10) / 10); h.t = now; while (h.d.length > RULES.oiKeepSamples) h.d.shift(); }
    }
  }

  // -- FUNDING
  for (const r of live) {
    if (r.oiUsd < RULES.fundingMinOiUsd || Math.abs(r.fundingPctH) < RULES.fundingFloorPctH) {
      const s = st.hlFundingState[r.name];
      if (s && Math.abs(r.fundingPctH) < RULES.fundingFloorPctH * 0.8) delete st.hlFundingState[r.name];
      continue;
    }
    const p = await fundingP99(r.name, st);
    const thresh = Math.max(RULES.fundingFloorPctH, p ?? 0);
    const dec = fundingDecision(r.fundingPctH, thresh, st.hlFundingState[r.name]);
    if (dec.clear) delete st.hlFundingState[r.name];
    if (!dec.fire) { if (st.hlFundingState[r.name]) st.hlFundingState[r.name].lastF = r.fundingPctH; continue; }
    st.hlFundingState[r.name] = { enteredAt: now, entryF: r.fundingPctH, lastF: r.fundingPctH };
    const c = { ...r, thresh, reason: dec.reason };
    if (await dispatch({ source: 'PERPDEX', type: 'FUNDING', severity: 'MEDIUM', key: `hyperliquid:${r.name}`,
      cooldownMin: RULES.fundingCooldownMin, ...hlFundingMessage(c, { oi: changeOver(rings.get(r.name), 3600e3, now) }),
      track: { kind: 'cex', exchange: 'hyperliquid', symbol: r.name, price: r.px } })) alerts++;
  }

  // -- OPEN INTEREST
  let wouldHave = 0;
  for (const r of live) {
    if (r.oiUsd < RULES.oiMinOiUsd) continue;
    const ch = changeOver(rings.get(r.name), 3600e3, now);
    if (ch?.oiPct == null) continue;
    const t = oiThreshold(st.hlOiHist[r.name]?.d);
    const dec = fundingDecision(ch.oiPct, t.thresh, st.hlOiState[r.name]);
    if (dec.clear) delete st.hlOiState[r.name];
    if (!dec.fire) { if (st.hlOiState[r.name]) st.hlOiState[r.name].lastF = ch.oiPct; continue; }
    st.hlOiState[r.name] = { enteredAt: now, entryF: ch.oiPct, lastF: ch.oiPct };
    const c = { ...r, ...ch, thresh: t.thresh, n: t.n, reason: dec.reason };
    if (!t.mature) {
      wouldHave++;
      (st.digestPool ??= []).push({ ts: now, kind: 'OI', title: `Hyperliquid ${r.name} open interest ${sgn(ch.oiPct)}% in 1h (${usd(ch.toOiUsd)}) — not pushed: ${t.n}/${RULES.oiMatureSamples} hourly samples of its own` });
      while (st.digestPool.length > 100) st.digestPool.shift();
      continue;
    }
    if (await dispatch({ source: 'PERPDEX', type: 'OI', severity: 'MEDIUM', key: `hyperliquid:${r.name}`,
      cooldownMin: RULES.oiCooldownMin, ...hlOiMessage(c),
      track: { kind: 'cex', exchange: 'hyperliquid', symbol: r.name, price: r.px } })) alerts++;
  }
  save();
  const matureN = Object.values(st.hlOiHist).filter((h) => h.d.length >= RULES.oiMatureSamples).length;
  console.log(`[hyperliquid] ${live.length} live markets${alerts ? ` · ${alerts} alerts` : ''}${wouldHave ? ` · ${wouldHave} OI moves to digest (maturing)` : ''} · OI history mature ${matureN}/${Object.keys(st.hlOiHist).length}`);
}
