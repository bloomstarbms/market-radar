// New-listing detection: diff the symbol set per exchange each poll.
// A symbol appearing after the first baseline poll = new listing.
//
// v0.23.4 — this path now calls the SYMBOL classifier. Six tokenized equities and
// leveraged tokens (TSLAX, CRCLX, WDC3L/3S, AXTI3L/3S) reached the channel as LISTING
// facts because isEquityText() was built for announcement TITLES and this path emits
// listings without ever consulting a classifier. Third instance of "a classifier that
// exists but isn't routed to a path that emits what it classifies".
import { CHART_URLS } from './exchanges.js';
import { classifySymbol } from '../../core/taxonomy.js';
import { noteUnclassified, noteExcluded } from '../../core/unclassified.js';

const known = new Map(); // exchange -> Set of symbols
const QUOTE_RX = /(USDT|USDC|USD|BUSD|KRW|BTC|ETH)$/;
const baseOf = (sym) => String(sym).toUpperCase().replace(QUOTE_RX, '');

export function checkListings(exchange, tickers) {
  const current = new Set(tickers.map((t) => t.symbol));
  const prev = known.get(exchange);
  known.set(exchange, current);
  if (!prev) return []; // first poll = baseline

  const fresh = [];
  for (const sym of current) {
    if (prev.has(sym)) continue;
    const t = tickers.find((x) => x.symbol === sym);
    const base = baseOf(sym);
    const verdict = classifySymbol(base, (String(sym).match(QUOTE_RX) || [])[0] || 'USDT', exchange);
    if (verdict.state === 'EXCLUDE') {
      // Recorded, never merely dropped: a wrong exclusion is a listing that silently
      // never arrives, and CRYPTO_EXCEPTIONS is hand-maintained so wrong exclusions
      // are guaranteed to happen. Review with `node review-exclusions.js`.
      noteExcluded(sym, verdict.cls, verdict.reason, exchange);
      console.log(`  [listing] ${exchange}:${sym} excluded — ${verdict.reason}`);
      continue;
    }
    if (verdict.state === 'UNRECOGNISED') {
      // PUSHES anyway (symbols default open — most new symbols are real listings) but
      // is recorded so a genuinely new wrapper convention becomes visible.
      noteUnclassified(exchange, `[SYMBOL_UNRECOGNISED] ${sym} — ${verdict.reason}`);
    }
    fresh.push({ sym, t, base, verdict });
  }
  if (!fresh.length) return [];

  // LONG/SHORT PAIRING is moot after exclusion (leveraged pairs never survive), but a
  // venue can still list several genuine pairs at once, so BATCH COLLAPSE applies:
  // three or more listings from one venue in a single cycle become ONE message.
  // Mirrors the announcement path — four alerts in one minute was the symptom there
  // too, and the mechanism should not differ by which poller saw it.
  if (fresh.length >= 3) {
    const names = fresh.map((f) => f.base);
    return [{
      source: 'CEX', type: 'LISTING', severity: 'HIGH', kind: 'FACT',
      key: `${exchange}:batch:${new Date().toISOString().slice(0, 13)}`,
      dedupeKey: `LISTING:batch:${exchange}:${new Date().toISOString().slice(0, 10)}`,
      cooldownMin: 60,
      title: `${names.length} new pairs listed on ${exchange.toUpperCase()}`,
      lines: [
        names.slice(0, 12).join(', ') + (names.length > 12 ? ` … +${names.length - 12} more` : ''),
        `Batched: ${names.length} listings in one poll cycle from one venue — one event, not ${names.length}.`,
        'Fact only — no directional call.',
      ],
      url: CHART_URLS[exchange]?.(fresh[0].sym),
    }];
  }

  return fresh.map(({ sym, t, verdict }) => ({
    source: 'CEX', type: 'LISTING', severity: 'HIGH', kind: 'FACT', key: `${exchange}:${sym}`,
    cooldownMin: 24 * 60,
    title: `${sym} just listed on ${exchange.toUpperCase()}`,
    lines: [
      'New spot pair detected',
      t?.price ? `Price: $${t.price} · Vol24h: $${Math.round(t.quoteVol24h || 0).toLocaleString()}` : 'No ticker data yet',
      ...(verdict.state === 'UNRECOGNISED' ? [`⚠️ ${verdict.reason}`] : []),
      'Fact only — no directional call.',
    ],
    url: CHART_URLS[exchange]?.(sym),
    track: t?.price ? { kind: 'cex', exchange, symbol: sym, price: t.price } : undefined,
  }));
}
