// EXCHANGE ANNOUNCEMENT MONITOR — free, no keys.
// Announcements are published BEFORE trading opens, so this gives lead time the
// ticker-diff listing detector can't: you hear "Binance Will List X" at the
// announcement, not when the pair goes live.
// Also catches TGE / airdrop / unlock wording that the paid calendars charge for.
import { dispatch } from '../../core/dispatcher.js';
import { isStockName, isStockSymbol, loadDerivStockSymbols } from './exchanges.js';

const POLL_EVERY = 10 * 60e3;
let lastPoll = 0;
const seen = new Map(); // exchange -> Set of article ids (baseline on first poll)

async function jsonSafe(url, opts) {
  try {
    const res = await fetch(url, { headers: { 'accept': 'application/json' }, ...opts });
    if (!res.ok) return null;
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  } catch { return null; }
}

const FEEDS = {
  binance: async () => {
    const j = await jsonSafe('https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=48&pageNo=1&pageSize=20');
    const arts = (j?.data?.catalogs || []).flatMap((c) => c.articles || []);
    return arts.map((a) => ({ id: String(a.id ?? a.code ?? a.title), title: a.title || '', ts: a.releaseDate || Date.now(),
      url: `https://www.binance.com/en/support/announcement/${a.code || ''}` }));
  },
  okx: async () => {
    const j = await jsonSafe('https://www.okx.com/api/v5/support/announcements?page=1');
    const arr = (j?.data?.[0]?.details) || j?.data || [];
    return arr.map((a) => ({ id: String(a.url || a.title), title: a.title || '', ts: Number(a.pTime) || Date.now(), url: a.url || 'https://www.okx.com/help/section/announcements-new-listings' }));
  },
  bitget: async () => {
    const j = await jsonSafe('https://api.bitget.com/api/v2/public/annoucements?language=en_US&annType=coin_listings');
    return (j?.data || []).map((a) => ({ id: String(a.annId ?? a.annTitle), title: a.annTitle || '', ts: Number(a.cTime) || Date.now(), url: a.annUrl || 'https://www.bitget.com/support/sections/5955813039257' }));
  },
  bybit: async () => {
    const j = await jsonSafe('https://api.bybit.com/v5/announcements/index?locale=en-US&type=new_crypto&limit=20');
    return (j?.result?.list || []).map((a) => ({ id: String(a.url || a.title), title: a.title || '', ts: Number(a.dateTimestamp) || Date.now(), url: a.url || 'https://announcements.bybit.com/' }));
  },
};

// Spot listings / TGE / unlock / perp listings matter. Ongoing derivatives plumbing
// (expiry, settlement, options, structured products) and tokenized equities do not.
//
// A new PERP listing is a genuine signal and used to be discarded: opening leverage and
// a short side on a token reliably precedes volatility. The old filter killed anything
// containing "perpetual", which silently dropped 20/20 of Bybit's feed. What we still
// drop is equity perps — Bybit and Bitget list far more tokenized stocks than coins.
const LEVERAGE_BOILERPLATE = /,?\s*with up to \d+x leverage/ig;

function isEquityAnnouncement(title, t) {
  if (/tokenized stock|tokenised stock|xstock|equit(y|ies)|\bstocks?\b/.test(t)) return true;
  // "with up to 25x leverage" is on every perp announcement and would trip the \d+X
  // ETF-name rule, so strip it before the company-name check.
  if (isStockName(String(title).replace(LEVERAGE_BOILERPLATE, ''))) return true;
  // Titles give a bare ticker ("JNJUSDT") with no company name — match it against the
  // tokenized-stock symbol sets the ticker fetchers already maintain.
  for (const [, sym] of String(title).toUpperCase().matchAll(/\b([A-Z0-9]{2,15}USDT)\b/g)) {
    if (isStockSymbol(sym)) return true;
  }
  return false;
}

export function classify(title) {
  const t = (title || '').toLowerCase();
  // Equities first — they arrive dressed as perp listings, so this must precede both
  // the perp branch and the derivatives drop.
  if (isEquityAnnouncement(title, t)) return null;
  // delist FIRST: "Delisting of X" would otherwise match the listing pattern
  if (/delist|removal of|will remove|will suspend/.test(t)) return { type: 'LISTING', sev: 'MEDIUM', delist: true };
  if (/unlock|vesting|cliff release/.test(t)) return { type: 'UNLOCK', sev: 'HIGH' };
  if (/token generation|\btge\b|launchpool|launchpad|airdrop/.test(t)) return { type: 'TGE', sev: 'HIGH' };
  // Perp/futures LISTING — before the spot branch, whose "will list" also matches these.
  if (/perpetual|\bperps?\b|futures|x-perp/.test(t)
      && /will list|to list|lists |listing of|new listing|now launched|will launch|launches|now available|will add/.test(t)) {
    return { type: 'PERP', sev: 'MEDIUM' };
  }
  // Remaining derivatives are plumbing, not events: settlement, expiry, param changes.
  if (/x-perp|perpetual|\bperp\b|expiry|futures|margined|quarterly|options?\b|dual currency|dual investment|leveraged token|structured/.test(t)) return null;
  if (/will list|to list|lists |listing of|new spot|spot trading|new trading pair|will add|seed tag/.test(t)) { return { type: 'LISTING', sev: 'HIGH' }; }
  return null;
}

export async function pollAnnouncements() {
  if (Date.now() - lastPoll < POLL_EVERY) return;
  lastPoll = Date.now();
  // Warm the equity-perp symbol set (6h cache) so classify() can tell a stock perp
  // from a crypto perp. Failure is non-fatal: the name-based checks still apply.
  await loadDerivStockSymbols().catch(() => {});
  let total = 0, fired = 0;
  for (const [exch, fetcher] of Object.entries(FEEDS)) {
    const items = await fetcher();
    if (!items || !items.length) continue;
    total += items.length;
    const prev = seen.get(exch);
    const ids = new Set(items.map((i) => i.id));
    seen.set(exch, ids);
    if (!prev) continue; // first poll = baseline, don't replay history
    for (const it of items) {
      if (prev.has(it.id)) continue;
      const c = classify(it.title);
      if (!c) continue;
      const isDelist = !!c.delist;
      if (await dispatch({
        source: 'CEX', type: c.type === 'LISTING' ? 'ANNOUNCE' : c.type,
        severity: c.sev, key: `${exch}:${it.id}`, cooldownMin: 24 * 60,
        title: `${exch.toUpperCase()}: ${it.title.slice(0, 110)}`,
        lines: [
          c.type === 'UNLOCK' ? 'Token unlock notice — added supply hits the market'
            : c.type === 'TGE' ? 'Token generation / launchpool event — early volatility both ways'
            : c.type === 'PERP' ? 'Perp/futures listing — leverage and a short side open up, so expect wider swings'
            : isDelist ? '⚠️ Delisting notice — these usually dump hard and fast'
            : 'Listing announced — published BEFORE trading opens, so this is your lead time',
          'Announcements move price on their own; verify on the exchange before acting.',
        ],
        url: it.url,
      })) fired++;
    }
  }
  console.log(`[announce] ${total} announcements scanned${fired ? ` · ${fired} alerts` : ''}`);
}
