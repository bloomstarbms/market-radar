// Upbit (Korea) listing monitor.
//
// Upbit listings are among the strongest single catalysts in crypto — Korean retail
// demand is concentrated and a KRW listing routinely repriced a token before the rest
// of the market reacts. Worth its own module rather than another row in listings.js.
//
// Two independent detectors, deliberately redundant:
//   1. NOTICES — published before trading opens, so this is the lead time. The titles
//      are Korean, so it depends on phrase matching — which DID drift (below). Since
//      v0.33.5 it runs on its own timer (UPBIT_NOTICE_SEC), not the 60 s poll loop.
//   2. MARKET DIFF — new market codes appearing in /v1/market/all. Slower (fires when
//      trading actually opens) but language-independent, so it catches anything the
//      phrase matching misses. dedupeKey stops you being told twice.
//
// THE DRIFT (found 2026-10-06, Numeraire): Upbit titles a KRW market added to a coin it
// already lists as "뉴메레르(NMR) KRW, USDT 마켓 디지털 자산 추가". The old pattern only
// knew "마켓 추가" with nothing between, so seven of these were skipped between 25 Jul
// and 6 Oct (NMR, BFC, NCT, LIT, CRV, PROM, MORPHO), each caught only when trading
// opened, minutes after other channels. KMNO and EUL matched only by ACCIDENT, through
// the word "추가" in their amendment suffix "(거래지원 개시 시점 추가 변경 안내)". And
// investment warnings had drifted the same way: Upbit now writes "거래 유의 종목 지정"
// (spaces), the old pattern wanted "유의종목 지정" — BLAST, SOPH, EGLD and INJ warnings
// never alerted. Every title now goes through classifyUpbitNotice(), matched on the
// title WITH its amendment suffix removed, and a trading notice that matches nothing
// is logged (unclassified, its own shape) and flagged on the heartbeat.
import { dispatch } from '../../core/dispatcher.js';
import { getState, save } from '../../core/store.js';
import { notePulse } from '../../core/pulse.js';
import { noteUnclassified } from '../../core/unclassified.js';

const MARKETS_URL = 'https://api.upbit.com/v1/market/all?isDetails=true';
const NOTICE_URL = 'https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=10&category=all';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
const POLL_EVERY = Number(process.env.UPBIT_POLL_SEC || 120) * 1000;
// Notice cadence: MEASURED from the VPS 2026-10-06 — see the v0.33.5 notes entry for the
// limit and the margin. The market list keeps POLL_EVERY; only notices are lead time.
export const NOTICE_EVERY_MS = Number(process.env.UPBIT_NOTICE_SEC || 15) * 1000;

// 신규 거래지원 = "new trading support" (a listing). 거래지원 개시 = trading support begins.
// 마켓 … 추가 = a market added for a coin already on Upbit ("KRW 마켓 디지털 자산 추가").
// 거래지원 종료 = delisting. 유의 종목 지정 = "caution designation" (spaces optional);
// 지정 해제 = released, 기간 연장 = extended — both are follow-ups, not new warnings.
const RX_LIST = /신규\s*거래지원|거래지원\s*개시/;
const RX_MARKET_ADD = /마켓\s*(?:[가-힣]+\s*){0,3}추가/;
const RX_DELIST = /거래지원\s*종료|상장\s*폐지/;
const RX_WARN = /유의\s*종목\s*지정/;
const RX_CAUTION = /유의\s*촉구/; // "call for caution" — formal, short of a designation
const RX_WARN_FOLLOWUP = /지정\s*해제|기간\s*연장/;
// An amendment suffix is a trailing parenthetical that is itself a notice ("… 안내")
// about timing, change, cancellation or correction.
const RX_AMEND = /안내/;
const RX_AMEND_WHAT = /변경|시점|취소|정정|연장|재개|추가/;

let lastPoll = 0;
let names = new Map(); // TICKER -> English name, for readable alert titles

async function jsonSafe(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (res.status === 429) return { __rateLimited: true };
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// "그래비티토큰(GRVT) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)" -> GRVT
// Skips the market-name parenthetical so KRW/BTC/USDT are never read as the ticker.
const QUOTES = new Set(['KRW', 'BTC', 'USDT']);
export function tickersFrom(title) {
  const out = [];
  for (const [, inner] of String(title).matchAll(/\(([^)]+)\)/g)) {
    for (const part of inner.split(/[,/]/).map((s) => s.trim())) {
      // Must contain a letter: titles also carry date parentheticals like "(08/06 18:00 ~)"
      // and a bare "08" would otherwise be picked up as a ticker.
      if (/^(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,15}$/.test(part) && !QUOTES.has(part)) out.push(part);
    }
  }
  return [...new Set(out)];
}

// Peel trailing "(… 안내)" amendment groups (balanced, so "(헤미(HEMI) 거래지원 취소 안내)"
// comes off whole). A listing's own "(KRW, BTC, USDT 마켓)" and a date "(10/19 15:00)"
// carry no 안내 and stay.
export function splitAmendment(title) {
  let base = String(title || '').trim();
  const suffixes = [];
  for (let guard = 0; guard < 4 && base.endsWith(')'); guard++) {
    let depth = 0, i = base.length - 1;
    for (; i >= 0; i--) { if (base[i] === ')') depth++; else if (base[i] === '(' && --depth === 0) break; }
    if (i < 0) break;
    const inner = base.slice(i + 1, -1);
    if (!(RX_AMEND.test(inner) && RX_AMEND_WHAT.test(inner))) break;
    suffixes.unshift(inner);
    base = base.slice(0, i).trim();
  }
  return { base, amendment: suffixes.length ? suffixes.join(' · ') : null };
}

// Pure. The ONE classifier for an Upbit notice title.
export function classifyUpbitNotice(title) {
  const { base, amendment } = splitAmendment(title);
  const tickers = tickersFrom(base);
  const cancel = !!amendment && /취소/.test(amendment);
  let kind = null;
  if (RX_DELIST.test(base)) kind = 'DELIST';
  else if (RX_WARN.test(base)) kind = RX_WARN_FOLLOWUP.test(base) ? 'WARN_FOLLOWUP' : 'WARN';
  else if (RX_CAUTION.test(base)) kind = 'CAUTION';
  else if (RX_LIST.test(base)) kind = 'LIST';
  else if (RX_MARKET_ADD.test(base)) kind = 'MARKET_ADD';
  // Markets: "(KRW, BTC, USDT 마켓)" on a listing; "KRW, USDT 마켓 …" on a market add.
  const mk = base.match(/\(([A-Z, ]+)\s*마켓\)/) || base.match(/((?:KRW|BTC|USDT)(?:\s*,\s*(?:KRW|BTC|USDT))*)\s*마켓/);
  const quotes = mk ? mk[1].split(',').map((s) => s.trim()).filter((q) => QUOTES.has(q)) : [];
  return { kind, base, amendment, cancel, tickers, quotes };
}

const label = (tk) => (names.get(tk) ? `${tk} (${names.get(tk)})` : tk);
function learnNames(markets) {
  for (const m of markets) {
    const tk = String(m.market || '').split('-')[1];
    if (tk && m.english_name) names.set(tk, m.english_name);
  }
}

// ---- detector 2: the market list (in the 60 s poll loop, every POLL_EVERY) ----
export async function pollUpbit() {
  if (Date.now() - lastPoll < POLL_EVERY) return;
  lastPoll = Date.now();
  const state = getState();
  let fired = 0;
  const markets = await jsonSafe(MARKETS_URL);
  if (Array.isArray(markets)) {
    notePulse('upbit');
    const codes = markets.map((m) => m.market).filter(Boolean);
    learnNames(markets);
    const prev = state.upbitMarkets;
    if (!prev) {
      state.upbitMarkets = codes; save();       // first run = baseline only
    } else if (codes.length) {
      const before = new Set(prev);
      const listedBefore = new Set(prev.map((c) => c.split('-')[1]));
      const added = codes.filter((c) => !before.has(c));
      state.upbitMarkets = codes; save();
      // A brand-new coin lands on several markets at once (KRW-X, BTC-X, USDT-X);
      // group by ticker so that's one alert, not three.
      const byTicker = new Map();
      for (const c of added) {
        const [quote, tk] = c.split('-');
        if (!tk) continue;
        if (!byTicker.has(tk)) byTicker.set(tk, []);
        byTicker.get(tk).push(quote);
      }
      for (const [tk, quotes] of byTicker) {
        // A ticker already on Upbit under another quote is a MARKET ADD, not a listing.
        const msg = listedBefore.has(tk) ? upbitMarketAddMessage(label(tk), quotes, null, { trading: true }) : upbitMarketMessage(tk, label(tk), quotes);
        if (await dispatch({
          source: 'CEX', type: 'UPBIT', severity: 'HIGH',
          key: `upbit:market:${tk}`, dedupeKey: `UPBIT:${tk}`, cooldownMin: 24 * 60,
          ...msg,
        })) fired++;
      }
    }
  }
  if (fired) console.log(`[upbit] ${fired} alert(s)`);
}

// ---- detector 1: notices. Pure core, testable without network or live state ----
// deps: { dispatch, stamped(tk) -> bool (already announced, any age), note(venue, title) }
export async function processNotices(list, state, deps = {}) {
  const send = deps.dispatch ?? dispatch;
  const stamped = deps.stamped ?? ((tk) => !!getState().lastAlert?.[`CEX:UPBIT:${tk}`]);
  const note = deps.note ?? noteUnclassified;
  const out = { sent: 0, skipped: [] };
  if (!list?.length) return out;
  if (!state.upbitNotices) { state.upbitNotices = list.map((n) => String(n.id)); return out; } // baseline
  const seen = new Set(state.upbitNotices);
  for (const n of list) {
    const id = String(n.id);
    if (seen.has(id)) continue; // an in-place edit keeps its id: never a second alert
    const title = n.title || '';
    const c = classifyUpbitNotice(title);
    if (!c.kind) {
      // A TRADING notice that matched nothing is where the next drift will hide.
      if (/^거래$/.test(n.category || '')) note('upbit', `[UPBIT_TRADE_UNMATCHED] ${title}`);
      continue;
    }
    if (c.kind === 'WARN_FOLLOWUP') continue;
    // A NEW notice that amends a listing we already announced is not a second event.
    if (c.amendment && !c.cancel && c.tickers.length && c.tickers.every(stamped)) {
      out.skipped.push({ id, why: `amendment of an already-announced ${c.tickers.join(',')}` });
      console.log(`  [upbit] notice ${id} amends an already-announced listing (${c.tickers.join(', ')}) — not re-alerted: ${c.amendment}`);
      continue;
    }
    const who = c.tickers.length ? c.tickers.map(label).join(', ') : c.base.slice(0, 60);
    const msg = c.kind === 'MARKET_ADD'
      ? upbitMarketAddMessage(who, c.quotes, title)
      : upbitNoticeMessage(who, title, { isList: c.kind === 'LIST', isDelist: c.kind === 'DELIST', isCaution: c.kind === 'CAUTION' });
    if (await send({
      source: 'CEX', type: 'UPBIT',
      severity: c.kind === 'LIST' || c.kind === 'MARKET_ADD' ? 'HIGH' : 'MEDIUM',
      key: `upbit:notice:${id}`,
      // Same dedupeKey as the market diff: whichever detector sees it first wins.
      dedupeKey: c.tickers.length ? `UPBIT:${c.tickers[0]}` : `UPBIT:notice:${id}`,
      cooldownMin: 24 * 60,
      ...msg,
    })) out.sent++;
  }
  state.upbitNotices = [...new Set([...list.map((n) => String(n.id)), ...seen])].slice(0, 300);
  return out;
}

let noticeInFlight = false, noticeBackoffUntil = 0, noticeTimer = null;
export async function pollUpbitNotices() {
  if (noticeInFlight || Date.now() < noticeBackoffUntil) return;
  noticeInFlight = true;
  try {
    const notice = await jsonSafe(NOTICE_URL);
    if (notice?.__rateLimited) {
      noticeBackoffUntil = Date.now() + 60e3;
      console.error('[upbit] notice feed returned 429 — backing off 60 s');
      return;
    }
    if (!names.size) { const m = await jsonSafe(MARKETS_URL); if (Array.isArray(m)) learnNames(m); }
    const state = getState();
    const r = await processNotices(notice?.data?.notices || [], state);
    save();
    if (r.sent) console.log(`[upbit] ${r.sent} notice alert(s)`);
  } finally { noticeInFlight = false; }
}
// Own timer: the 60 s poll loop is too slow for the one source where seconds matter.
export function startUpbitNoticeWatch(everyMs = NOTICE_EVERY_MS) {
  if (noticeTimer) return noticeTimer;
  pollUpbitNotices().catch((e) => console.error('[upbit] notice poll failed:', e.message));
  noticeTimer = setInterval(() => pollUpbitNotices().catch((e) => console.error('[upbit] notice poll failed:', e.message)), everyMs);
  noticeTimer.unref?.();
  console.log(`[upbit] notice watch every ${Math.round(everyMs / 1000)} s`);
  return noticeTimer;
}

// UPBIT MESSAGES, pure (message diet, CEX remainder). "Korean retail concentration
// makes the open violent" was a frequency claim with no sample; "this is your lead
// time" was advice. The facts: listed, on which markets, or announced (before/after
// trading), with the notice title.
export function upbitMarketMessage(tk, name, quotes) {
  return {
    title: `🆕 LISTING · ${name} on UPBIT — ${quotes.join(', ')} market${quotes.length > 1 ? 's' : ''}`,
    lines: ['Now trading on Upbit (Korea)'],
    operatorLines: ['Detected from the live market list (detector 2); the notice detector may have seen it first'],
    url: `https://upbit.com/exchange?code=CRIX.UPBIT.${quotes[0]}-${tk}`,
  };
}
// A market added for a coin Upbit already lists — "adds a KRW market", never "will list".
export function upbitMarketAddMessage(who, quotes, title, { trading = false } = {}) {
  const lead = quotes.includes('KRW') ? 'KRW' : (quotes[0] ?? 'new');
  return {
    title: `Upbit adds a ${lead} market for ${who}`,
    lines: [
      `${quotes.length ? quotes.join(', ') : 'New'} market${quotes.length > 1 ? 's' : ''} · already listed on Upbit · ${trading ? 'now trading' : 'announced before trading opens'}`,
      ...(title ? [title.slice(0, 110)] : []),
    ],
    operatorLines: [trading ? 'Detected from the live market list (detector 2): a known ticker gained a market' : 'Notice form "X 마켓 디지털 자산 추가" (missed before v0.33.5)'],
    url: 'https://upbit.com/service_center/notice',
  };
}
export function upbitNoticeMessage(who, title, { isList = false, isDelist = false, isCaution = false } = {}) {
  return {
    title: isList ? `UPBIT will list ${who}` : isDelist ? `UPBIT delisting ${who}` : isCaution ? `UPBIT caution notice on ${who}` : `UPBIT investment warning on ${who}`,
    lines: [
      isList ? 'Announced before trading opens' : isDelist ? '⚠️ Delisting notice — trading support ends on Upbit' : isCaution ? '⚠️ Upbit "call for caution" notice — formal, short of a warning designation' : '⚠️ Upbit "investment warning" designation — a formal venue risk flag',
      title.slice(0, 110),
    ],
    operatorLines: [],
    url: 'https://upbit.com/service_center/notice',
  };
}
