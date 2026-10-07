// COINBASE — new markets, stage by stage (v0.33.6).
//
// Coinbase sat in LISTING_TIER1 (dispatcher.js) — "a listing here reprices the asset
// globally, push immediately" — while NOTHING POLLED IT. A tier-1 entry with no source
// is a coverage claim with nothing behind it; routes.js now refuses boot on exactly that
// (checkVenueCollectors).
//
// Source: api.exchange.coinbase.com/products — keyless, one call, every product with its
// trading state (status, auction_mode, post_only, limit_only, cancel_only,
// trading_disabled, status_message). Answers from the VPS on IPv4 and IPv6 alike; the
// rate limit was measured before choosing COINBASE_POLL_SEC (see the v0.33.6 notes).
//
// A new Coinbase market moves through stages before full trading: auction, post-only or
// limit-only, then online. The FIRST sighting of a new product in a pre-trading stage is
// the lead-time alert ("Coinbase is opening a market for X (limit-only stage)"); the move
// to full trading EDITS that message instead of sending another. Limit-only is not only a
// launch stage — 20 established products sat in it on 2026-10-06 — so stage alerts apply
// to NEW products, never to an old product that happens to be limit-only.
//
// The baseline is PERSISTED (st.coinbase), the lesson from listings.js: an in-memory
// baseline re-baselines on every restart and swallows whatever listed while the bot was
// down. Non-crypto quotes (GBP, EUR, INR, …) are skipped for a coin already on Coinbase;
// a brand-new coin is reported whatever its first quote.
import { dispatch } from '../../core/dispatcher.js';
import { getThread } from '../../core/budget.js';
import { editBroadcast } from '../../core/telegram.js';
import { config } from '../../config.js';
import { getState, save } from '../../core/store.js';
import { notePulse } from '../../core/pulse.js';

export const PRODUCTS_URL = 'https://api.exchange.coinbase.com/products';
export const POLL_EVERY_MS = Number(process.env.COINBASE_POLL_SEC || 60) * 1000;
export const SKIP_QUOTES = new Set(['GBP', 'EUR', 'INR', 'AUD', 'CAD', 'BRL', 'SGD', 'JPY', 'CHF', 'MXN', 'KRW', 'TRY']);
export const PRE_STAGES = new Set(['AUCTION', 'POST_ONLY', 'LIMIT_ONLY', 'CANCEL_ONLY', 'DISABLED']);
const STAGE_LABEL = { AUCTION: 'auction', POST_ONLY: 'post-only', LIMIT_ONLY: 'limit-only', CANCEL_ONLY: 'cancel-only', DISABLED: 'trading not yet enabled', FULL: 'full trading', DELISTED: 'delisted' };
const STAGE_MEANS = {
  AUCTION: 'orders are collected for an opening auction; nothing matches yet',
  POST_ONLY: 'only resting orders are accepted; nothing matches against the book yet',
  LIMIT_ONLY: 'limit orders only; no market orders yet',
  CANCEL_ONLY: 'orders can only be cancelled',
  DISABLED: 'the product exists but trading is not enabled',
};

// Pure: the trading stage a product is in.
export function stageOf(p) {
  if (p.status === 'delisted') return 'DELISTED';
  if (p.trading_disabled) return 'DISABLED';
  if (p.cancel_only) return 'CANCEL_ONLY';
  if (p.auction_mode) return 'AUCTION';
  if (p.post_only) return 'POST_ONLY';
  if (p.limit_only) return 'LIMIT_ONLY';
  if (p.status === 'online') return 'FULL';
  return String(p.status || 'UNKNOWN').toUpperCase();
}
export function snapshot(products) {
  const out = {};
  for (const p of products || []) if (p?.id) out[p.id] = { base: p.base_currency, quote: p.quote_currency, stage: stageOf(p), msg: p.status_message || '' };
  return out;
}

// Pure: what changed between two snapshots, as events. No baseline -> no events.
export function diffProducts(prev, live) {
  if (!prev) return [];
  const prevBases = new Set(Object.values(prev).map((x) => x.base));
  const events = [];
  const opening = new Map(); // base -> { quotes, stages }
  for (const [id, x] of Object.entries(live)) {
    if (prev[id]) continue;
    if (x.stage === 'DELISTED') continue; // appears already delisted: history, not news
    if (!prevBases.has(x.base)) {
      const o = opening.get(x.base) ?? { quotes: [], stages: new Set(), msgs: new Set(), ids: [] };
      o.quotes.push(x.quote); o.stages.add(x.stage); o.ids.push(id); if (x.msg) o.msgs.add(x.msg);
      opening.set(x.base, o);
    } else if (!SKIP_QUOTES.has(x.quote)) {
      events.push({ kind: 'MARKET_ADD', base: x.base, quote: x.quote, id, stage: x.stage, msg: x.msg });
    }
  }
  for (const [base, o] of opening) {
    const pre = [...o.stages].find((s) => PRE_STAGES.has(s));
    events.push({ kind: pre ? 'OPENING' : 'LISTED', base, quotes: o.quotes.sort(), ids: o.ids.sort(), stage: pre ?? 'FULL', msg: [...o.msgs][0] ?? '' });
  }
  const full = new Map(), delisted = new Map();
  for (const [id, x] of Object.entries(live)) {
    const was = prev[id];
    if (!was || was.stage === x.stage) continue;
    if (PRE_STAGES.has(was.stage) && x.stage === 'FULL') (full.get(x.base) ?? full.set(x.base, []).get(x.base)).push(id);
    if (was.stage !== 'DELISTED' && x.stage === 'DELISTED') (delisted.get(x.base) ?? delisted.set(x.base, []).get(x.base)).push(id);
  }
  for (const [base, ids] of full) events.push({ kind: 'FULL', base, ids: ids.sort() });
  for (const [base, ids] of delisted) {
    const all = Object.values(live).filter((x) => x.base === base);
    events.push({ kind: 'DELISTED', base, ids: ids.sort(), allGone: all.every((x) => x.stage === 'DELISTED'), msg: live[ids[0]]?.msg ?? '' });
  }
  return events;
}

// ---------------------------------------------------------------- messages, pure
const url = (id) => `https://exchange.coinbase.com/trade/${id}`;
export function coinbaseOpeningMessage(e) {
  return {
    title: `Coinbase is opening a market for ${e.base} (${STAGE_LABEL[e.stage]} stage)`,
    lines: [`${e.quotes.join(', ')} market${e.quotes.length > 1 ? 's' : ''} · ${STAGE_MEANS[e.stage] ?? STAGE_LABEL[e.stage]}`, ...(e.msg ? [`Coinbase: "${e.msg.slice(0, 100)}"`] : [])],
    operatorLines: [`New product(s) ${e.ids.join(', ')} in stage ${e.stage}; this message is edited when full trading opens`],
    url: url(e.ids[0]),
  };
}
export function coinbaseListedMessage(e) {
  return {
    title: `Coinbase lists ${e.base} — now trading`,
    lines: [`${e.quotes.join(', ')} market${e.quotes.length > 1 ? 's' : ''} · full trading on first sighting (no pre-trading stage was seen)`],
    operatorLines: [`New product(s) ${e.ids.join(', ')} first seen already online`],
    url: url(e.ids[0]),
  };
}
export function coinbaseMarketAddMessage(e) {
  return {
    title: `Coinbase adds a ${e.quote} market for ${e.base}`,
    lines: [`${e.base} already trades on Coinbase · ${e.id} is ${e.stage === 'FULL' ? 'trading now' : `in ${STAGE_LABEL[e.stage]} (${STAGE_MEANS[e.stage] ?? ''})`}`],
    operatorLines: [`New product ${e.id} for a known base`],
    url: url(e.id),
  };
}
export function coinbaseDelistMessage(e) {
  return {
    title: e.allGone ? `Coinbase delisted ${e.base}` : `Coinbase delisted ${e.ids.join(', ')}`,
    lines: [e.allGone ? `Every ${e.base} market on Coinbase is now delisted` : `${e.base} still trades on Coinbase in other markets`, ...(e.msg ? [`Coinbase: "${e.msg.slice(0, 100)}"`] : [])],
    operatorLines: [`Status moved to delisted: ${e.ids.join(', ')}`],
    url: 'https://exchange.coinbase.com',
  };
}
export function fullTradingLine(ids, now = Date.now()) {
  return `Full trading open from ${new Date(now).toISOString().slice(11, 16)} UTC (${ids.join(', ')})`;
}

// ---------------------------------------------------------------- the poll, with injectable edges
// deps: { dispatch, edit(dedupeKey, line) -> bool, now }
export async function processProducts(products, state, deps = {}) {
  const send = deps.dispatch ?? dispatch;
  const edit = deps.edit ?? editThread;
  const now = deps.now ?? Date.now();
  const live = snapshot(products);
  const events = diffProducts(state.coinbase?.products, live);
  const out = { sent: 0, edited: 0, events };
  for (const e of events) {
    if (e.kind === 'OPENING' || e.kind === 'LISTED') {
      if (await send({ source: 'CEX', type: 'LISTING', severity: 'HIGH', kind: 'FACT', venue: 'coinbase', asset: e.base,
        key: `coinbase:${e.base}`, dedupeKey: `COINBASE:${e.base}`, cooldownMin: 24 * 60,
        ...(e.kind === 'OPENING' ? coinbaseOpeningMessage(e) : coinbaseListedMessage(e)) })) out.sent++;
    } else if (e.kind === 'MARKET_ADD') {
      if (await send({ source: 'CEX', type: 'LISTING', severity: 'MEDIUM', kind: 'FACT', venue: 'coinbase', asset: `${e.base}-${e.quote}`,
        key: `coinbase:${e.id}`, dedupeKey: `COINBASE:${e.id}`, cooldownMin: 24 * 60, ...coinbaseMarketAddMessage(e) })) out.sent++;
    } else if (e.kind === 'FULL') {
      // EDIT the opening message, never a second one. No thread (bot was down, or the
      // product was limit-only before the baseline) -> logged, not re-announced.
      if (await edit(`COINBASE:${e.base}`, fullTradingLine(e.ids, now))) out.edited++;
      else console.log(`  [coinbase] ${e.base} reached full trading (${e.ids.join(', ')}) — no opening message to edit; logged only`);
    } else if (e.kind === 'DELISTED') {
      if (await send({ source: 'CEX', type: 'ANNOUNCE', severity: 'MEDIUM', kind: 'FACT', venue: 'coinbase', asset: `${e.base}:delist`, delist: true,
        key: `coinbase:delist:${e.ids.join(',')}`, dedupeKey: `COINBASE:delist:${e.base}`, cooldownMin: 24 * 60, ...coinbaseDelistMessage(e) })) out.sent++;
    }
  }
  // The ETag is stored WITH the products it describes, so a 304 after a restart still
  // means "unchanged from the persisted baseline", never "unchanged from something else".
  state.coinbase = { products: live, at: now, ...(deps.etag ? { etag: deps.etag } : {}) };
  return out;
}

// Append a line to the thread opened by dedupeKey, the same way the T+30m depth check does.
async function editThread(dedupeKey, line) {
  const th = getThread({ dedupeKey, type: 'LISTING' });
  if (!config.telegramToken || !th?.messageIds?.length || !th.lastText) return false;
  const updated = `${th.lastText}\n• <i>${line}</i>`;
  const res = await editBroadcast(th.messageIds, updated);
  if (res.ok) { th.lastText = updated; save(); return true; }
  return false;
}

// One fetch-and-diff, conditional on the stored ETag. Node's fetch already asks for gzip
// (accept-encoding: gzip, deflate): the 354 KB list is ~26 KB on the wire. With
// If-None-Match an unchanged list is HTTP 304 and 0 bytes. A 304 is a SUCCESSFUL look —
// the venue answered and nothing changed — so it notes the pulse (feedWasLooking stays
// true) and produces no diff and no warning. deps: { fetchImpl, pulse, ...processProducts deps }
export async function coinbaseCycle(state, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pulse = deps.pulse ?? notePulse;
  const headers = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
  if (state.coinbase?.products && state.coinbase.etag) headers['If-None-Match'] = state.coinbase.etag;
  let res, products;
  try {
    res = await fetchImpl(PRODUCTS_URL, { headers });
    if (res.status === 304) { pulse('coinbase'); return { status: 'not-modified' }; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    products = await res.json();
    // TRUNCATION GUARD, two parts. A missing product is not read as delisted (only a
    // status of "delisted" is), so a short list cannot produce delistings directly. The
    // damage is one step later: a short list ACCEPTED would overwrite the baseline, and
    // the next full list would make every product it lost look NEW — hundreds of
    // "opening a market" alerts. So: an absolute floor, and a list that shrank more than
    // 10% against the stored baseline is refused. Coinbase does not remove products
    // (839 = 512 online + 327 delisted, 2026-10-06); delisted ones stay in the list.
    if (!Array.isArray(products) || products.length < (deps.minProducts ?? 100)) throw new Error(`implausible product list (${Array.isArray(products) ? products.length : typeof products})`);
    const known = Object.keys(state.coinbase?.products || {}).length;
    if (known && products.length < known * 0.9) throw new Error(`product list shrank from ${known} to ${products.length} — treated as truncated, baseline kept`);
  } catch (e) { console.error('[coinbase] poll failed:', e.message); return { status: 'failed', error: e.message }; }
  pulse('coinbase');
  const baseline = !state.coinbase?.products;
  const r = await processProducts(products, state, { ...deps, etag: res.headers?.get?.('etag') ?? null });
  return { status: baseline ? 'baseline' : 'ok', ...r, count: products.length };
}

let lastPoll = 0;
export async function pollCoinbase() {
  if (Date.now() - lastPoll < POLL_EVERY_MS) return;
  lastPoll = Date.now();
  const st = getState();
  const r = await coinbaseCycle(st);
  if (r.status === 'not-modified' || r.status === 'failed') return;
  save();
  if (r.status === 'baseline') console.log(`[coinbase] baseline: ${r.count} products (persisted)`);
  else if (r.events.length) console.log(`[coinbase] ${r.events.map((e) => `${e.kind} ${e.base}`).join(' · ')}${r.sent ? ` · ${r.sent} alert(s)` : ''}${r.edited ? ` · ${r.edited} edit(s)` : ''}`);
}
