// PERP LISTS — Bybit linear and Binance USD-M instrument lists, watched (v0.37.20).
//
// Until now futures listings reached the bot only through announcements. On 2026-11-11
// DANGOTEUSDT appeared on Bybit futures and the instrument list, the one place the
// contract is a structured record (type, status, auction phases), was read by nothing
// but a 6-hourly stock-symbol cache. This is the Coinbase model (coinbase.js) applied to
// perps:
//   - a 60 s poll of each venue's FULL list: Bybit's default (Trading) list plus
//     status=PreLaunch, which the default call leaves out (DANGOTE was absent from it);
//     Binance's exchangeInfo, which carries PENDING_TRADING rows in the one list;
//   - full pagination, and a list that hits the page cap still holding a cursor is CUT
//     OFF: refused, baseline kept;
//   - a persisted baseline (st.perpLists), seeded SILENTLY on the first run;
//   - a 90% shrink guard against the stored baseline, and a missing symbol is never a
//     delisting: it is carried forward, unchanged, for MISSING_KEEP_MS, so a short list
//     can neither delist anything nor make the symbols it dropped look new later;
//   - a new contract in pre-launch is alerted, and the move to trading EDITS that
//     message instead of sending another.
//
// What counts as new: a PERPETUAL contract whose BASE the venue has not listed before.
// Dated futures (24 new Bybit expiries in the 30 days to 2026-11-11, all on bases
// already listed) and a second quote for a known base (Binance HYPEUSDC) are logged, not
// alerted. Every new contract is typed by the venue's own field:
//   CRYPTO   Bybit symbolType '' or 'innovation'; Binance PERPETUAL × COIN/INDEX/PREMARKET
//            -> PERP fact, shared key PERP:<venue>:<BASE> with the announcement path.
//   TRADFI   Bybit 'stock'/'ETF'; Binance TRADIFI_PERPETUAL × EQUITY/HK_/KR_/CN_EQUITY/
//            PREMARKET -> tradfi.js (own category).
//   EXCLUDE  Bybit 'commodity'/'forex'; Binance TRADIFI_PERPETUAL × COMMODITY/FX -> noteExcluded.
//   UNKNOWN  any other value: recorded unclassified, never pushed (degrade to caution).
import { dispatch } from '../../core/dispatcher.js';
import { getState, save } from '../../core/store.js';
import { notePulse } from '../../core/pulse.js';
import { classifySymbol } from '../../core/taxonomy.js';
import { noteUnclassified, noteExcluded } from '../../core/unclassified.js';
import { tradfiMessage, tradfiLiveLine, tradfiKey, postTradfi, claimHeld, flushHeld, editThread, utcTime, ahead, VENUE_NAME, VENUE_URL } from './tradfi.js';

export const BYBIT_URL = 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000';
export const BINANCE_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
export const POLL_EVERY_MS = Number(process.env.PERP_LIST_POLL_SEC || 60) * 1000;
export const MAX_PAGES = 5;          // 930 Bybit rows fit one 1,000-row page on 2026-11-11
export const MIN_ROWS = 300;         // absolute floor under the shrink guard (930 and 944 live)
export const SHRINK_FLOOR = 0.9;
export const MISSING_KEEP_MS = 30 * 86400e3;
export const VENUES = ['bybit', 'binance'];

// ---------------------------------------------------------------- normalise, pure
const BYBIT_TYPE = { '': 'CRYPTO', innovation: 'CRYPTO', stock: 'TRADFI', ETF: 'TRADFI', commodity: 'EXCLUDE', forex: 'EXCLUDE' };
const BYBIT_STAGE = { PreLaunch: 'PRE', Trading: 'LIVE' };
export function normBybit(x) {
  const t = String(x.symbolType ?? '');
  const phase = (name) => Number(x.preListingInfo?.phases?.find((p) => p.phase === name)?.startTime) || null;
  return {
    symbol: x.symbol, base: String(x.baseCoin || '').toUpperCase(), quote: x.quoteCoin,
    stage: BYBIT_STAGE[x.status] ?? 'OFF', perpetual: x.contractType === 'LinearPerpetual',
    cls: BYBIT_TYPE[t] ?? 'UNKNOWN', type: t || '(none)', kind: t,
    name: x.fullName || null, region: x.marketRegion || null,
    // Bybit's pre-listing flag on a STOCK contract. The six PreLaunch stock contracts on
    // 2026-11-11 were all private companies (OpenAI, Anthropic, Dangote, …) and Bybit's
    // own notice names the product "Pre-IPO Tradfi Perpetual".
    preIpo: t === 'stock' && x.isPreListing === true,
    auctionTs: x.preListingInfo?.skipCallAuction ? null : phase('CallAuction'),
    tradingTs: phase('ContinuousTrading'),
  };
}
const BN_STAGE = { PENDING_TRADING: 'PRE', TRADING: 'LIVE' };
const BN_REGION = { HK_EQUITY: 'HK', KR_EQUITY: 'KR', CN_EQUITY: 'CN' };
export function normBinance(x) {
  const u = String(x.underlyingType ?? '');
  const cls = x.contractType === 'TRADIFI_PERPETUAL'
    ? (/^([A-Z]{2}_)?EQUITY$/.test(u) || u === 'PREMARKET' ? 'TRADFI' : u === 'COMMODITY' || u === 'FX' ? 'EXCLUDE' : 'UNKNOWN')
    : (['COIN', 'INDEX', 'PREMARKET'].includes(u) ? 'CRYPTO' : 'UNKNOWN');
  return {
    symbol: x.symbol, base: String(x.baseAsset || '').toUpperCase(), quote: x.quoteAsset,
    stage: BN_STAGE[x.status] ?? 'OFF', perpetual: x.contractType === 'PERPETUAL' || x.contractType === 'TRADIFI_PERPETUAL',
    cls, type: `${x.contractType}/${u || '(none)'}`, kind: 'equity',
    name: null, region: BN_REGION[u] ?? null,
    preIpo: x.contractType === 'TRADIFI_PERPETUAL' && u === 'PREMARKET',
    auctionTs: null, tradingTs: x.status === 'PENDING_TRADING' ? Number(x.onboardDate) || null : null,
  };
}

// The baseline holds what a diff needs and nothing else.
export function snapshot(rows) {
  const out = {};
  for (const r of rows) if (r?.symbol) out[r.symbol] = { base: r.base, stage: r.stage, cls: r.cls, perpetual: r.perpetual };
  return out;
}

// Pure: events between the stored baseline and a live list. No baseline -> no events.
export function diffLists(prev, liveRows) {
  if (!prev) return { events: [], skipped: [] };
  const prevBases = new Set(Object.values(prev).map((x) => x.base));
  const events = [], skipped = [];
  for (const r of liveRows) {
    const was = prev[r.symbol];
    if (!was) {
      if (r.stage === 'OFF') { skipped.push(`${r.symbol} (already ${r.stage})`); continue; }
      if (!r.perpetual) { skipped.push(`${r.symbol} (dated future)`); continue; }
      if (prevBases.has(r.base)) { skipped.push(`${r.symbol} (new market for listed ${r.base})`); continue; }
      events.push({ kind: 'NEW', row: r });
    } else if (was.stage === 'PRE' && r.stage === 'LIVE') {
      events.push({ kind: 'LIVE', row: r, cls: was.cls });
    }
  }
  return { events, skipped };
}

// The next baseline: the live list, plus every stored symbol the live list lacks, carried
// forward as it was (missing is not delisted) until it has been missing MISSING_KEEP_MS.
export function nextBaseline(prev, liveRows, now) {
  const live = snapshot(liveRows);
  for (const [sym, x] of Object.entries(prev || {})) {
    if (live[sym]) continue;
    const since = x.missingSince ?? now;
    if (now - since < MISSING_KEEP_MS) live[sym] = { ...x, missingSince: since };
  }
  return live;
}

// ---------------------------------------------------------------- crypto perp messages, pure
const UP = (v) => String(v).toUpperCase();
export function perpMessage(r, verdict, now = Date.now()) {
  const auction = ahead(r.auctionTs, now), trading = ahead(r.tradingTs, now);
  const when = r.stage === 'PRE'
    ? `Not trading yet: pre-launch${auction ? ` · auction ${utcTime(auction, now)}` : ''}${trading ? ` · trading from ${utcTime(trading, now)}` : ' · no start time published'}`
    : `Now trading (${r.symbol}); no pre-launch stage was seen`;
  return {
    title: `${r.base}-PERP on ${UP(r.venue)}`,
    lines: [when, ...(verdict?.state === 'UNRECOGNISED' ? [`⚠️ ${verdict.reason}`] : [])],
    operatorLines: [`New contract ${r.symbol} in ${VENUE_NAME[r.venue]}'s instrument list (${r.type})${r.stage === 'PRE' ? '; this message is edited when trading opens' : ''}`],
    url: VENUE_URL[r.venue]?.(r.symbol),
  };
}
export function perpBatchMessage(venue, rows) {
  return {
    title: `${rows.length} new perp markets on ${UP(venue)}`,
    lines: [rows.slice(0, 12).map((r) => r.base).join(', ') + (rows.length > 12 ? ` … +${rows.length - 12} more` : '')],
    operatorLines: [`Batched: ${rows.length} contracts in one poll — one event, not ${rows.length}.`],
    url: VENUE_URL[venue]?.(rows[0].symbol),
  };
}
export const perpKey = (venue, base) => `PERP:${venue}:${UP(base)}`;
export function perpAlert(r, verdict, now) {
  return { source: 'CEX', type: 'PERP', severity: 'MEDIUM', kind: 'FACT', venue: r.venue, asset: r.base,
    key: `${r.venue}:perp:${r.base}`, dedupeKey: perpKey(r.venue, r.base), cooldownMin: 24 * 60, ...perpMessage(r, verdict, now) };
}
export function perpLiveLine(symbol, now = Date.now()) { return tradfiLiveLine(symbol, now); }

// ---------------------------------------------------------------- one venue's list, processed
// deps: { dispatch, edit, now, noteExcluded, noteUnclassified, classify, tradfi: postTradfi deps }
export async function processList(venue, liveRows, state, deps = {}) {
  const send = deps.dispatch ?? dispatch;
  const edit = deps.edit ?? editThread;
  const now = deps.now ?? Date.now();
  const excl = deps.noteExcluded ?? noteExcluded;
  const uncl = deps.noteUnclassified ?? noteUnclassified;
  const classify = deps.classify ?? classifySymbol;
  const rows = liveRows.map((r) => ({ ...r, venue }));
  state.perpLists ??= {};
  const prevV = state.perpLists[venue];
  const { events, skipped } = diffLists(prevV?.rows, rows);
  const out = { sent: 0, edited: 0, digest: 0, excluded: 0, unknown: 0, events, skipped };
  const log = (prevV?.log ?? []).filter((x) => now - x.ts < 24 * 3600e3);
  const crypto = [];
  for (const e of events) {
    const r = e.row;
    if (e.kind === 'LIVE') {
      const key = e.cls === 'TRADFI' ? tradfiKey(venue, r.base) : perpKey(venue, r.base);
      if (await edit(key, perpLiveLine(r.symbol, now))) out.edited++;
      else console.log(`  [perps] ${venue}:${r.symbol} is trading — no opening message to edit; logged only`);
      continue;
    }
    if (r.cls === 'TRADFI') {
      claimHeld(venue, r.base, state);
      const res = await postTradfi(tradfiMessage(r, now), { venue, base: r.base, key: r.symbol, label: r.symbol }, { dispatch: send, state, now, ...(deps.tradfi ?? {}) });
      if (res === 'sent') out.sent++;
      if (res === 'digest') out.digest++;
      log.push({ ts: now, kind: 'tradfi', sym: r.symbol });
    } else if (r.cls === 'EXCLUDE') {
      claimHeld(venue, r.base, state);
      excl(r.symbol, r.type.includes('FX') || r.type === 'forex' ? 'FX' : 'COMMODITY', `${venue} perp typed ${r.type} (not a TradFi perp here)`, venue);
      out.excluded++; log.push({ ts: now, kind: 'excluded', sym: r.symbol });
      console.log(`  [perps] ${venue}:${r.symbol} excluded — typed ${r.type}`);
    } else if (r.cls === 'UNKNOWN') {
      uncl(venue, `[PERP_TYPE_UNRECOGNISED] ${r.symbol} — instrument type '${r.type}'`);
      out.unknown++; log.push({ ts: now, kind: 'unknown', sym: r.symbol });
      console.error(`[perps][OPERATOR] ${venue}:${r.symbol} has an instrument type this watcher does not know ('${r.type}') — not pushed; add it to perp-watch.js`);
    } else {
      const verdict = classify(r.base, r.quote, venue);
      if (verdict.state === 'EXCLUDE') { excl(r.symbol, verdict.cls, verdict.reason, venue); out.excluded++; log.push({ ts: now, kind: 'excluded', sym: r.symbol }); continue; }
      if (verdict.state === 'UNRECOGNISED') uncl(venue, `[SYMBOL_UNRECOGNISED] ${r.symbol} — ${verdict.reason}`);
      crypto.push({ r, verdict });
    }
  }
  if (crypto.length >= 3) {
    if (await send({ source: 'CEX', type: 'PERP', severity: 'MEDIUM', kind: 'FACT', venue,
      key: `${venue}:perp-batch:${new Date(now).toISOString().slice(0, 13)}`, cooldownMin: 60, ...perpBatchMessage(venue, crypto.map((c) => c.r)) })) out.sent++;
  } else {
    for (const { r, verdict } of crypto) if (await send(perpAlert(r, verdict, now))) out.sent++;
  }
  for (const { r } of crypto) log.push({ ts: now, kind: 'crypto', sym: r.symbol });
  state.perpLists[venue] = {
    rows: nextBaseline(prevV?.rows, rows, now), at: now,
    count: rows.length, pre: rows.filter((r) => r.stage === 'PRE').length,
    seededAt: prevV?.seededAt ?? now, log, refused: prevV?.refused ?? [],
  };
  return out;
}

// ---------------------------------------------------------------- fetch, with the cut-off rule
const withTimeout = () => ({ signal: AbortSignal.timeout(20e3), headers: { Accept: 'application/json' } });
async function bybitPages(fetchImpl, url) {
  const list = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(`${url}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, withTimeout());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j?.retCode !== 0 || !Array.isArray(j?.result?.list)) throw new Error(`retCode ${j?.retCode} ${j?.retMsg ?? ''}`.trim());
    list.push(...j.result.list);
    cursor = j.result.nextPageCursor || '';
    if (!cursor) return list;
  }
  throw new Error(`still paginating after ${MAX_PAGES} pages (${list.length} rows) — treated as cut off, baseline kept`);
}
export const FETCHERS = {
  async bybit(fetchImpl) {
    const [trading, pre] = await Promise.all([bybitPages(fetchImpl, BYBIT_URL), bybitPages(fetchImpl, `${BYBIT_URL}&status=PreLaunch`)]);
    return { rows: [...trading, ...pre].map(normBybit), listCount: trading.length };
  },
  async binance(fetchImpl) {
    const res = await fetchImpl(BINANCE_URL, withTimeout());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j?.symbols)) throw new Error('no symbols array');
    return { rows: j.symbols.map(normBinance), listCount: j.symbols.length };
  },
};

// One venue: fetch, guard, diff. deps: { fetchImpl, pulse, ...processList deps }
export async function perpListCycle(venue, state, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now();
  let got;
  try {
    got = await FETCHERS[venue](fetchImpl);
    if (got.rows.length < (deps.minRows ?? MIN_ROWS)) throw new Error(`implausible list (${got.rows.length} rows)`);
    // TRUNCATION GUARD: a short list ACCEPTED would overwrite the baseline, and the next
    // full one would make every symbol it lost look new. Compared against the symbols
    // the baseline holds as present (carried-forward missing ones are not counted).
    const known = Object.values(state.perpLists?.[venue]?.rows || {}).filter((x) => !x.missingSince).length;
    if (known && got.rows.length < known * SHRINK_FLOOR) throw new Error(`list shrank from ${known} to ${got.rows.length} — treated as truncated, baseline kept`);
  } catch (e) {
    console.error(`[perps] ${venue} poll refused: ${e.message}`);
    // Recorded even before the seed, so a venue that never answers says so in the heartbeat.
    const v = ((state.perpLists ??= {})[venue] ??= {});
    v.refused = [...(v.refused || []).filter((x) => now - x.ts < 24 * 3600e3), { ts: now, why: e.message.slice(0, 80) }];
    return { status: 'failed', error: e.message };
  }
  (deps.pulse ?? notePulse)(`perps:${venue}`);
  const seeding = !state.perpLists?.[venue]?.rows;
  const r = await processList(venue, got.rows, state, deps);
  return { status: seeding ? 'baseline' : 'ok', ...r, count: got.rows.length };
}

let lastPoll = 0;
export async function pollPerpLists() {
  if (Date.now() - lastPoll < POLL_EVERY_MS) return;
  lastPoll = Date.now();
  const st = getState();
  for (const venue of VENUES) {
    const r = await perpListCycle(venue, st);
    save();
    if (r.status === 'baseline') console.log(`[perps] ${venue} baseline: ${r.count} contracts (persisted, nothing sent)`);
    else if (r.status === 'ok' && (r.events.length || r.skipped.length)) console.log(`[perps] ${venue}: ${r.events.map((e) => `${e.kind} ${e.row.symbol}`).join(' · ') || 'no events'}${r.skipped.length ? ` · not alerted: ${r.skipped.join(', ')}` : ''}${r.sent ? ` · ${r.sent} alert(s)` : ''}${r.edited ? ` · ${r.edited} edit(s)` : ''}${r.digest ? ` · ${r.digest} to digest` : ''}`);
  }
  await flushHeld();
}

// ---------------------------------------------------------------- heartbeat: one line per venue
export function perpListStatus(st, now = Date.now()) {
  const fmt = (s) => (s < 120 ? `${Math.round(s)}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
  const lines = VENUES.map((venue) => {
    const v = st?.perpLists?.[venue];
    if (!v?.rows) return `Perp list ${VENUE_NAME[venue]}: not seeded yet${v?.refused?.length ? ` · ${v.refused.length} refused (${v.refused.at(-1).why})` : ''}`;
    const ageS = (now - v.at) / 1000;
    const log = (v.log || []).filter((x) => now - x.ts < 24 * 3600e3);
    const n = (k) => log.filter((x) => x.kind === k).length;
    const refused = (v.refused || []).filter((x) => now - x.ts < 24 * 3600e3);
    return `Perp list ${VENUE_NAME[venue]}: ${v.count} contracts (${v.pre} pre-launch) · last good poll ${fmt(ageS)} ago${ageS > 15 * 60 ? ' 🚨 stale' : ''}`
      + ` · 24h: ${n('crypto')} new crypto · ${n('tradfi')} TradFi · ${n('excluded')} excluded${n('unknown') ? ` · ${n('unknown')} unknown type` : ''}`
      + (refused.length ? ` · ${refused.length} poll(s) refused (last: ${refused.at(-1).why})` : '');
  });
  return { lines };
}
