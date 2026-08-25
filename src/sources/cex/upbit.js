// Upbit (Korea) listing monitor.
//
// Upbit listings are among the strongest single catalysts in crypto — Korean retail
// demand is concentrated and a KRW listing routinely repriced a token before the rest
// of the market reacts. Worth its own module rather than another row in listings.js.
//
// Two independent detectors, deliberately redundant:
//   1. ANNOUNCEMENTS — published before trading opens, so this is the lead time. But
//      the titles are Korean, so it depends on phrase matching that could drift.
//   2. MARKET DIFF — new market codes appearing in /v1/market/all. Slower (fires when
//      trading actually opens) but language-independent, so it catches anything the
//      phrase matching misses. dedupeKey stops you being told twice.
import { dispatch } from '../../core/dispatcher.js';
import { getState, save } from '../../core/store.js';
import { notePulse } from '../../core/pulse.js';

const MARKETS_URL = 'https://api.upbit.com/v1/market/all?isDetails=true';
const NOTICE_URL = 'https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=10&category=all';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
const POLL_EVERY = Number(process.env.UPBIT_POLL_SEC || 120) * 1000;

// 신규 거래지원 = "new trading support" (a listing). 거래지원 종료 = delisting.
// 투자유의종목 = "investment warning" designation, which reliably dumps a token.
const RX_LIST = /신규\s*거래지원|거래지원\s*개시|마켓\s*추가/;
const RX_DELIST = /거래지원\s*종료|상장\s*폐지/;
const RX_WARN = /투자유의종목\s*지정|유의종목\s*지정/;

let lastPoll = 0;
let names = new Map(); // TICKER -> English name, for readable alert titles

async function jsonSafe(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// "그래비티토큰(GRVT) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)" -> GRVT
// Skips the market-name parenthetical so KRW/BTC/USDT are never read as the ticker.
const QUOTES = new Set(['KRW', 'BTC', 'USDT']);
function tickersFrom(title) {
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

const label = (tk) => (names.get(tk) ? `${tk} (${names.get(tk)})` : tk);

export async function pollUpbit() {
  if (Date.now() - lastPoll < POLL_EVERY) return;
  lastPoll = Date.now();
  const state = getState();
  let fired = 0;

  // ---- detector 2 (also refreshes the ticker -> English name map) ----
  const markets = await jsonSafe(MARKETS_URL);
  if (Array.isArray(markets)) {
    notePulse('upbit');
    const codes = markets.map((m) => m.market).filter(Boolean);
    for (const m of markets) {
      const tk = String(m.market || '').split('-')[1];
      if (tk && m.english_name) names.set(tk, m.english_name);
    }
    const prev = state.upbitMarkets;
    if (!prev) {
      state.upbitMarkets = codes; save();       // first run = baseline only
    } else if (codes.length) {
      const before = new Set(prev);
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
        if (await dispatch({
          source: 'CEX', type: 'UPBIT', severity: 'HIGH',
          key: `upbit:market:${tk}`, dedupeKey: `UPBIT:${tk}`, cooldownMin: 24 * 60,
          title: `UPBIT listed ${label(tk)} — ${quotes.join(', ')} market${quotes.length > 1 ? 's' : ''}`,
          lines: [
            'Now trading on Upbit (Korea) — detected from the live market list.',
            'Korean listings often reprice a token fast; the first minutes are usually the most violent.',
          ],
          url: `https://upbit.com/exchange?code=CRIX.UPBIT.${quotes[0]}-${tk}`,
        })) fired++;
      }
    }
  }

  // ---- detector 1: announcements (the early one) ----
  const notice = await jsonSafe(NOTICE_URL);
  const list = notice?.data?.notices || [];
  const seen = new Set(state.upbitNotices || []);
  if (list.length) {
    if (!state.upbitNotices) {
      state.upbitNotices = list.map((n) => String(n.id)); save(); // baseline
    } else {
      for (const n of list) {
        const id = String(n.id);
        if (seen.has(id)) continue;
        const title = n.title || '';
        const isList = RX_LIST.test(title);
        const isDelist = RX_DELIST.test(title);
        const isWarn = RX_WARN.test(title);
        if (!isList && !isDelist && !isWarn) continue;
        const tks = tickersFrom(title);
        const who = tks.length ? tks.map(label).join(', ') : title.slice(0, 60);
        if (await dispatch({
          source: 'CEX', type: 'UPBIT',
          severity: isList ? 'HIGH' : 'MEDIUM',
          key: `upbit:notice:${id}`,
          // Same dedupeKey as the market diff: whichever detector sees it first wins.
          dedupeKey: tks.length ? `UPBIT:${tks[0]}` : `UPBIT:notice:${id}`,
          cooldownMin: 24 * 60,
          title: isList ? `UPBIT will list ${who}`
            : isDelist ? `UPBIT delisting ${who}`
            : `UPBIT investment warning on ${who}`,
          lines: [
            isList ? 'Announced BEFORE trading opens — this is your lead time.'
              : isDelist ? '⚠️ Delisting notice — Korean delistings usually dump hard.'
              : '⚠️ Upbit "investment warning" designation — these typically sell off sharply.',
            title.slice(0, 110),
          ],
          url: 'https://upbit.com/service_center/notice',
        })) fired++;
      }
      state.upbitNotices = [...new Set([...list.map((n) => String(n.id)), ...seen])].slice(0, 300);
      save();
    }
  }
  if (fired) console.log(`[upbit] ${fired} alert(s)`);
}
