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
  catch { data = await json('https://data-api.binance.vision/api/v3/ticker/24hr'); }
  return normBinanceLike(data);
}
export async function mexc() { return normBinanceLike(await json('https://api.mexc.com/api/v3/ticker/24hr')); }
export async function bybit() {
  const data = await json('https://api.bybit.com/v5/market/tickers?category=spot');
  return (data.result?.list || []).filter((t) => t.symbol.endsWith('USDT')).map((t) => ({
    symbol: t.symbol, price: Number(t.lastPrice), quoteVol24h: Number(t.turnover24h), change24hPct: Number(t.price24hPcnt) * 100,
  }));
}
export async function gate() {
  const data = await json('https://api.gateio.ws/api/v4/spot/tickers');
  return data.filter((t) => t.currency_pair.endsWith('_USDT')).map((t) => ({
    symbol: t.currency_pair.replace('_', ''), price: Number(t.last), quoteVol24h: Number(t.quote_volume), change24hPct: Number(t.change_percentage),
  }));
}
export async function kucoin() {
  const data = await json('https://api.kucoin.com/api/v1/market/allTickers');
  return (data.data?.ticker || []).filter((t) => t.symbol.endsWith('-USDT')).map((t) => ({
    symbol: t.symbol.replace('-', ''), price: Number(t.last), quoteVol24h: Number(t.volValue), change24hPct: Number(t.changeRate) * 100,
  }));
}
export async function bitget() {
  const data = await json('https://api.bitget.com/api/v2/spot/market/tickers');
  return (data.data || []).filter((t) => t.symbol.endsWith('USDT')).map((t) => ({
    symbol: t.symbol, price: Number(t.lastPr), quoteVol24h: Number(t.usdtVolume), change24hPct: Number(t.change24h) * 100,
  }));
}
function normBinanceLike(data) {
  return data.filter((t) => t.symbol.endsWith('USDT')).map((t) => ({
    symbol: t.symbol, price: Number(t.lastPrice), quoteVol24h: Number(t.quoteVolume), change24hPct: Number(t.priceChangePercent),
  }));
}
export const EXCHANGES = { binance, mexc, bybit, gate, kucoin, bitget };
export const CHART_URLS = {
  binance: (s) => `https://www.binance.com/en/trade/${s.replace('USDT', '_USDT')}`,
  mexc: (s) => `https://www.mexc.com/exchange/${s.replace('USDT', '_USDT')}`,
  bybit: (s) => `https://www.bybit.com/en/trade/spot/${s.replace('USDT', '/USDT')}`,
  gate: (s) => `https://www.gate.io/trade/${s.replace('USDT', '_USDT')}`,
  kucoin: (s) => `https://www.kucoin.com/trade/${s.replace('USDT', '-USDT')}`,
  bitget: (s) => `https://www.bitget.com/spot/${s}`,
};
