// EXCHANGE ANNOUNCEMENT MONITOR — free, no keys.
// Announcements are published BEFORE trading opens, so this gives lead time the
// ticker-diff listing detector can't: you hear "Binance Will List X" at the
// announcement, not when the pair goes live.
// Also catches TGE / airdrop / unlock wording that the paid calendars charge for.
import { dispatch } from '../../core/dispatcher.js';

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

// Only these classes are worth a notification — everything else is exchange marketing.
function classify(title) {
  const t = (title || '').toLowerCase();
  // delist FIRST: "Delisting of X" would otherwise match the listing pattern
  if (/delist|removal of|will remove|will suspend/.test(t)) return { type: 'LISTING', sev: 'MEDIUM', delist: true };
  if (/unlock|vesting|cliff release/.test(t)) return { type: 'UNLOCK', sev: 'HIGH' };
  if (/token generation|\btge\b|launchpool|launchpad|airdrop/.test(t)) return { type: 'TGE', sev: 'HIGH' };
  if (/will list|to list|lists |listing of|new spot|new trading pair|will add|launch .*perpetual|seed tag/.test(t)) return { type: 'LISTING', sev: 'HIGH' };
  return null;
}

export async function pollAnnouncements() {
  if (Date.now() - lastPoll < POLL_EVERY) return;
  lastPoll = Date.now();
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
