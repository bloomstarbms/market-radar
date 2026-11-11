// TRADFI PERPS — their own category, posted (operator decision, 2026-11-11).
//
// Until then a perp on a stock or an ETF was an equity, and equities were dropped: the
// DANGOTE pre-IPO perp on Bybit was seen by the announcement poller 11 s before the
// contract existed and filed as "unclassified". Now these contracts are POSTED, but as
// what they are, never as crypto listings:
//   - own type (TRADFI) and own header, "🏛 TRADFI PERP · <venue>";
//   - no tier-1 bypass (catalystRoute defers TRADFI on every venue, Binance included);
//   - no track, so no outcomes row and nothing for the ladder to count;
//   - at most TRADFI_DAILY_MAX messages per UTC day; the rest share ONE digest line;
//   - the prose lint plus TRADFI_CLAIM (no "opportunity" framing) runs over the public
//     rendering, and a hit is refused, not sent.
// Commodity and forex contracts are not TradFi perps here: they stay excluded
// (noteExcluded), by the instrument list's own type field.
//
// Two sources feed this module. The instrument-list watcher (perp-watch.js) knows the
// name, region and auction times; an announcement knows only its title. On a venue the
// watcher covers, a notice is HELD for HOLD_MS so the watcher's fuller message wins; if
// the watcher has not claimed it by then, the notice is posted in its own form. On any
// other venue the notice is posted at once.
import { dispatch, renderMessage } from '../../core/dispatcher.js';
import { getThread } from '../../core/budget.js';
import { editBroadcast } from '../../core/telegram.js';
import { config } from '../../config.js';
import { getState, save } from '../../core/store.js';
import { tradfiProblems } from '../../core/prose-lint.js';
import { digestWindow } from '../../core/telemetry.js';

export const TRADFI_DAILY_MAX = 5;
export const HOLD_MS = 10 * 60e3;
// Venues whose instrument list is watched (perp-watch.js). A notice from one of these
// waits for the watcher; from any other venue it is posted as soon as it is seen.
export const WATCHED_VENUES = new Set(['bybit', 'binance']);
export const VENUE_NAME = { bybit: 'Bybit', binance: 'Binance', okx: 'OKX', bitget: 'Bitget', kucoin: 'KuCoin', mexc: 'MEXC', gate: 'Gate', bithumb: 'Bithumb', upbit: 'Upbit' };
const venueName = (v) => VENUE_NAME[v] ?? String(v || '?');
export const tradfiKey = (venue, base) => `TRADFI:${venue}:${String(base).toUpperCase()}`;
export const VENUE_URL = {
  bybit: (s) => `https://www.bybit.com/trade/usdt/${s}`,
  binance: (s) => `https://www.binance.com/en/futures/${s}`,
};

// "11:00 UTC" when the time falls on the same UTC day as `now`, "12 Nov 11:00 UTC" otherwise.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function utcTime(ts, now = Date.now()) {
  const d = new Date(ts);
  const hm = d.toISOString().slice(11, 16);
  return d.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? `${hm} UTC` : `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${hm} UTC`;
}

// The legal-form suffix is not part of what a reader recognises ("… Petrochemicals FZE").
const LEGAL_SUFFIX = /[\s,]+(FZE|FZCO|Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|Limited|PLC|LLC|N\.?V\.?|S\.?A\.?|AG|SE|Co\.?|Holdings?|Group)$/i;
export function displayName(full) {
  let s = String(full || '').trim();
  for (let i = 0; i < 3 && LEGAL_SUFFIX.test(s); i++) s = s.replace(LEGAL_SUFFIX, '').trim();
  return s;
}

// ---------------------------------------------------------------- messages, pure
// e (from the instrument list): { venue, symbol, base, name, region, kind, preIpo, stage: 'PRE'|'LIVE', auctionTs, tradingTs }
// A published start time is stated only while it is ahead. Binance GAIBUSDT sat in
// PENDING_TRADING on 2026-11-11 with an onboardDate of 2025-11-20: a past "start" is not
// a schedule, and printing it would state a date that did not happen.
export const ahead = (ts, now) => (Number.isFinite(ts) && ts > now ? ts : null);
export function tradfiMessage(e, now = Date.now()) {
  // Binance publishes no company name, so its line names the base and says "equity".
  const tags = [e.preIpo ? 'pre-IPO' : null, e.kind === 'ETF' ? 'ETF' : null, !e.name && !e.preIpo && e.kind === 'equity' ? 'equity' : null, e.region || null].filter(Boolean);
  const name = displayName(e.name) || e.base;
  const auction = ahead(e.auctionTs, now), trading = ahead(e.tradingTs, now);
  const when = e.stage === 'PRE'
    ? (auction && trading ? `Auction ${utcTime(auction, now)} · trading from ${utcTime(trading, now)}`
      : trading ? `Trading from ${utcTime(trading, now)}` : 'Not trading yet; no start time published')
    : 'Trading now';
  return {
    title: `🏛 TRADFI PERP · ${venueName(e.venue)}`,
    lines: [`${e.symbol}: ${name}${tags.length ? ` (${tags.join(', ')})` : ''}`, when],
    operatorLines: [
      `From ${venueName(e.venue)}'s instrument list (${e.stage === 'PRE' ? 'pre-launch' : 'already trading when first seen'})${e.stage === 'PRE' ? '; this message is edited when trading opens' : ''}`,
      'TradFi perps are their own category: no tier-1 bypass, no outcomes row, not counted as crypto listings',
    ],
    url: VENUE_URL[e.venue]?.(e.symbol),
  };
}
// n (from an announcement): { venue, base, title, url, held }
export function tradfiNoticeMessage(n) {
  return {
    title: `🏛 TRADFI PERP · ${venueName(n.venue)}`,
    lines: [`${n.base ?? 'Contract'}: from the ${venueName(n.venue)} notice`, `"${String(n.title).slice(0, 110)}"`],
    operatorLines: [
      n.held ? `Held ${Math.round(HOLD_MS / 60e3)} min for the instrument-list watcher, which did not show it; posted from the notice`
        : `No instrument-list watcher on ${venueName(n.venue)}; posted from the notice`,
      'TradFi perps are their own category: no tier-1 bypass, no outcomes row, not counted as crypto listings',
    ],
    url: n.url,
  };
}
export function tradfiLiveLine(symbol, now = Date.now()) {
  return `Trading opened ${new Date(now).toISOString().slice(11, 16)} UTC (${symbol})`;
}
export function tradfiAlert(msg, venue, base, key) {
  // No track: a TradFi perp writes no outcomes row and is never a crypto listing.
  return { source: 'CEX', type: 'TRADFI', severity: 'MEDIUM', kind: 'FACT', venue, asset: String(base || key).toUpperCase(),
    key: `${venue}:tradfi:${base ?? key}`, dedupeKey: base ? tradfiKey(venue, base) : `TRADFI:${venue}:notice:${key}`, cooldownMin: 24 * 60, ...msg };
}

// ---------------------------------------------------------------- the cap, the lint, the send
// deps: { dispatch, state, now, save }. Returns 'sent' | 'digest' | 'refused' | 'not-sent'.
export async function postTradfi(msg, { venue, base, key, label }, deps = {}) {
  const send = deps.dispatch ?? dispatch;
  const st = deps.state ?? getState();
  const persist = deps.save ?? save;
  const now = deps.now ?? Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  if (st.tradfi?.day !== day) st.tradfi = { day, sent: 0 };
  const problems = tradfiProblems(renderMessage(msg, 'public').text);
  if (problems.length) {
    console.error(`[tradfi][OPERATOR] ${label} on ${venue} NOT SENT — the public text fails the prose lint (${problems.join('; ')}): "${renderMessage(msg, 'public').text.replace(/\n/g, ' | ').slice(0, 160)}"`);
    return 'refused';
  }
  if (st.tradfi.sent >= TRADFI_DAILY_MAX) {
    // ONE digest line for the overflow, per digest window: the next one joins it.
    const { start, end } = digestWindow(now);
    st.digestPool ??= [];
    let entry = st.digestPool.find((x) => x.kind === 'TRADFI' && x.ts >= start && x.ts < end);
    if (!entry) { entry = { ts: now, kind: 'TRADFI', items: [] }; st.digestPool.push(entry); }
    entry.items.push(`${label} (${venueName(venue)})`);
    entry.title = `🏛 TradFi perps beyond today's ${TRADFI_DAILY_MAX} messages (${entry.items.length}): ${entry.items.join(', ')}`;
    while (st.digestPool.length > 100) st.digestPool.shift();
    persist();
    console.log(`  [tradfi] ${label} on ${venue} -> digest (${TRADFI_DAILY_MAX} TradFi messages already sent ${day})`);
    return 'digest';
  }
  if (!(await send(tradfiAlert(msg, venue, base, key)))) return 'not-sent';
  st.tradfi.sent++;
  persist();
  return 'sent';
}

// Append a line to the message opened under dedupeKey (the same mechanism as Coinbase's
// full-trading edit and the T+30m depth check).
export async function editThread(dedupeKey, line) {
  const th = getThread({ dedupeKey, type: 'TRADFI' });
  if (!config.telegramToken || !th?.messageIds?.length || !th.lastText) return false;
  const updated = `${th.lastText}\n• <i>${line}</i>`;
  const res = await editBroadcast(th.messageIds, updated);
  if (res.ok) { th.lastText = updated; save(); return true; }
  return false;
}

// ---------------------------------------------------------------- notices: hold, claim, flush
// it: { id, title, url }. deps: { state, now, post }.
export async function tradfiFromNotice(venue, it, base, deps = {}) {
  const st = deps.state ?? getState();
  const now = deps.now ?? Date.now();
  if (base && WATCHED_VENUES.has(venue)) {
    st.tradfiHeld ??= {};
    st.tradfiHeld[`${venue}:${base}`] ??= { at: now, venue, base, title: it.title, url: it.url, id: it.id };
    (deps.save ?? save)();
    console.log(`  [tradfi] ${venue} notice for ${base} held up to ${HOLD_MS / 60e3} min for the instrument-list watcher`);
    return 'held';
  }
  return (deps.post ?? postTradfi)(tradfiNoticeMessage({ venue, base, title: it.title, url: it.url, held: false }),
    { venue, base, key: it.id, label: base ?? String(it.title).slice(0, 40) }, deps);
}
// The watcher saw the contract: its own message (or exclusion) replaces the held notice.
export function claimHeld(venue, base, st = getState()) {
  const k = `${venue}:${String(base).toUpperCase()}`;
  if (!st.tradfiHeld?.[k]) return false;
  delete st.tradfiHeld[k];
  return true;
}
export async function flushHeld(deps = {}) {
  const st = deps.state ?? getState();
  const now = deps.now ?? Date.now();
  const out = [];
  for (const [k, h] of Object.entries(st.tradfiHeld || {})) {
    if (now - h.at < HOLD_MS) continue;
    delete st.tradfiHeld[k];
    out.push(await (deps.post ?? postTradfi)(tradfiNoticeMessage({ ...h, held: true }), { venue: h.venue, base: h.base, key: h.id, label: h.base }, deps));
  }
  if (out.length) (deps.save ?? save)();
  return out;
}
