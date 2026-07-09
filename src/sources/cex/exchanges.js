// Normalized ticker fetchers. All public endpoints, no API keys.
// Each returns [{ symbol, price, quoteVol24h, change24hPct }] for USDT spot pairs.

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export async function binance() {
  let data;
  try { data = await json('https://api.binance.com/api/v3/ticker/24hr'); }
  catch { data = await json('https://data-api.binance.vision/api/v3/ticker/24hr'); } // geo-block fallback
  return normBinanceLike(data);
}

export async function mexc() {
  return normBinanceLike(await json('https://api.mexc.com/api/v3/ticker/24hr'));
}

export async function bybit() {
  const data = await json('https://api.bybit.com/v5/market/tickers?category=spot');
  return (data.result?.list || [])
    .filter((t) => t.symbol.endsWith('USDT'))
    .map((t) => ({
      symbol: t.symbol,
      price: Number(t.lastPrice),
      quoteVol24h: Number(t.turnover24h),
      change24hPct: Number(t.price24hPcnt) * 100,
    }));
}

function normBinanceLike(data) {
  return data
    .filter((t) => t.symbol.endsWith('USDT'))
    .map((t) => ({
      symbol: t.symbol,
      price: Number(t.lastPrice),
      quoteVol24h: Number(t.quoteVolume),
      change24hPct: Number(t.priceChangePercent),
    }));
}

export const EXCHANGES = { binance, mexc, bybit };
