// TGE / token-unlock alerts via CoinMarketCal v2 API.
// Free key (no card): coinmarketcal.com/developer — 3K requests/month;
// polling every 6h uses ~120. Degrades silently without a key.
import { config } from '../../config.js';
import { dispatch } from '../../core/dispatcher.js';

const POLL_EVERY = 6 * 3600e3;
let lastPoll = 0;
let disabled = false;

// Be precise about what an event actually IS. A "Memory Market Launch" or a
// "Payment Card Launch" is a PRODUCT launch, not a token generation event —
// labelling those as TGE is misleading (e.g. PYTH's TGE was years ago).
const classify = (title) => {
  const t = (title || '').toLowerCase();
  if (/unlock|vesting|cliff/.test(t)) return 'UNLOCK';
  // Genuine token-genesis events only
  if (/\btge\b|token generation|token sale|token launch|token debut|ido\b|ico\b|fair launch|airdrop claim|token distribution/.test(t)) return 'TGE';
  // Product / protocol milestones — real news, but NOT a TGE. Tagged separately.
  if (/mainnet|launch|upgrade|integration|partnership|listing|migration|hard fork|halving/.test(t)) return 'EVENT';
  return null;
};

export async function pollEvents() {
  if (!config.coinmarketcalKey || disabled) return;
  if (Date.now() - lastPoll < POLL_EVERY) return;
  lastPoll = Date.now();
  const start = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
  let events;
  try {
    const res = await fetch(`https://api.coinmarketcal.com/v2/events?max=100&dateRangeStart=${start}&dateRangeEnd=${end}`, {
      headers: { 'x-api-key': config.coinmarketcalKey, 'Accept': 'application/json' },
    });
    if (res.status === 401 || res.status === 403) { disabled = true; console.error('[events] CoinMarketCal key rejected — disabled this run'); return; }
    if (!res.ok) { console.error(`[events] coinmarketcal ${res.status}`); return; }
    events = (await res.json())?.data || [];
  } catch (e) { console.error('[events] fetch failed:', e.message); return; }

  let n = 0;
  for (const ev of events) {
    const type = classify(ev.title);
    if (!type) continue;
    const t = Date.parse(ev.date || '');
    if (!t || t < Date.now() - 86400e3) continue; // skip long-running/past events
    const daysOut = Math.max(0, Math.round((t - Date.now()) / 86400e3));
    const coins = (ev.coins || []).map((c) => (c.symbol || c.name || '').toUpperCase()).filter(Boolean).slice(0, 3).join(', ') || '?';
    const impact = ev.impact != null ? ` · impact ${ev.impact}/10` : '';
    const blurb = type === 'UNLOCK'
      ? `Token unlock ahead — added supply reaches the market${impact}`
      : type === 'TGE'
        ? `Token generation / first distribution — early volatility cuts both ways${impact}`
        : `Scheduled project milestone (product/protocol event, NOT a token launch)${impact}`;
    await dispatch({
      source: 'CAL', type, severity: type === 'EVENT' ? 'LOW' : (daysOut <= 1 ? 'HIGH' : (ev.impact >= 7 ? 'HIGH' : 'MEDIUM')),
      key: `${ev.id}:${ev.date?.slice(0, 10)}`, cooldownMin: 6 * 24 * 60,
      title: `${coins}: ${ev.title} — ${ev.displayedDate || ev.date?.slice(0, 10)} (${daysOut}d)`,
      lines: [
        blurb,
        ev.description ? String(ev.description).slice(0, 150) : `Coins: ${coins}`,
      ],
      url: ev.sourceUrl || `https://coinmarketcal.com/en/event/${ev.slug || ''}`,
    });
    n++;
  }
  console.log(`[events] coinmarketcal: ${events.length} events scanned, ${n} TGE/unlock alerts considered`);
}
