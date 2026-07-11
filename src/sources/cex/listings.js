// New-listing detection: diff the symbol set per exchange each poll.
// A symbol appearing after the first baseline poll = new listing.
import { CHART_URLS } from './exchanges.js';

const known = new Map(); // exchange -> Set of symbols

export function checkListings(exchange, tickers) {
  const current = new Set(tickers.map((t) => t.symbol));
  const prev = known.get(exchange);
  known.set(exchange, current);
  if (!prev) return []; // first poll = baseline
  const alerts = [];
  for (const sym of current) {
    if (prev.has(sym)) continue;
    const t = tickers.find((x) => x.symbol === sym);
    alerts.push({
      source: 'CEX', type: 'LISTING', severity: 'HIGH', key: `${exchange}:${sym}`,
      cooldownMin: 24 * 60,
      title: `${sym} just listed on ${exchange.toUpperCase()}`,
      lines: [
        `New spot pair detected`,
        t?.price ? `Price: $${t.price} · Vol24h: $${Math.round(t.quoteVol24h || 0).toLocaleString()}` : 'No ticker data yet',
        `Listings often pump early — and dump just as fast. DYOR.`,
      ],
      url: CHART_URLS[exchange]?.(sym),
      track: t?.price ? { kind: 'cex', exchange, symbol: sym, price: t.price } : undefined,
    });
  }
  return alerts;
}
