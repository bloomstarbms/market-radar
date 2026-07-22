// Normalized ticker fetchers. All public endpoints, no API keys.
// Each returns [{ symbol, price, quoteVol24h, change24hPct }] for USDT spot pairs.
async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// Tokenized STOCKS / ETFs (rNKE, TQQQG, NVDAX…) surge in volume when Wall Street
// opens and are pure equity noise for a crypto bot. We exclude them everywhere:
// pump, dump, volume AND listing alerts (all fed by these ticker fetchers).
const STOCK_NAME_RX = /\b(Inc|Corp|Corporation|Incorporated|Ltd|LLC|PLC|N\.?V|S\.?A|ADR|Company|Holdings?|Group|ETF|ProShares|iShares|Trust|Fund|Index|Bull|Bear|Ultra|UltraPro|Daily|Leveraged|Tokenized|Shares)\b|,\s*Inc|\d+X\b/i;
export const isStockName = (name) => STOCK_NAME_RX.test(name || '');

// Per-exchange stock-symbol sets, each refreshed at most every 6h.
const stockCache = {}; // exchange -> { set, ts }
async function stockSet(exchange, loader) {
  const c = stockCache[exchange];
  if (c && Date.now() - c.ts < 6 * 3600e3 && c.set.size) return c.set;
  try {
    const set = await loader();
    if (set.size) stockCache[exchange] = { set, ts: Date.now() };
    return stockCache[exchange]?.set || new Set();
  } catch { return c?.set || new Set(); }
}

export async function binance() {
  let data;
  try { data = await json('https://api.binance.com/api/v3/ticker/24hr'); }
  catch { data = await json('https://data-api.binance.vision/api/v3/ticker/24hr'); }
  return normBinanceLike(data);
}
export async function mexc() { return normBinanceLike(await json('https://api.mexc.com/api/v3/ticker/24hr')); }
export async function bybit() {
  const [data, stocks] = await Promise.all([
    json('https://api.bybit.com/v5/market/tickers?category=spot'),
    stockSet('bybit', async () => {
      const info = await json('https://api.bybit.com/v5/market/instruments-info?category=spot');
      return new Set((info.result?.list || []).filter((x) => x.symbolType === 'xstocks').map((x) => x.symbol));
    }),
  ]);
  return (data.result?.list || [])
    .filter((t) => t.symbol.endsWith('USDT') && !stocks.has(t.symbol))
    .map((t) => ({ symbol: t.symbol, price: Number(t.lastPrice), quoteVol24h: Number(t.turnover24h), change24hPct: Number(t.price24hPcnt) * 100 }));
}
export async function gate() {
  const [data, stocks] = await Promise.all([
    json('https://api.gateio.ws/api/v4/spot/tickers'),
    stockSet('gate', async () => {
      const pairs = await json('https://api.gateio.ws/api/v4/spot/currency_pairs');
      return new Set(pairs.filter((x) => x.quote === 'USDT' && isStockName(x.base_name)).map((x) => x.id.replace('_', '')));
    }),
  ]);
  return data
    .filter((t) => t.currency_pair.endsWith('_USDT') && !stocks.has(t.currency_pair.replace('_', '')))
    .map((t) => ({ symbol: t.currency_pair.replace('_', ''), price: Number(t.last), quoteVol24h: Number(t.quote_volume), change24hPct: Number(t.change_percentage) }));
}
export async function kucoin() {
  const data = await json('https://api.kucoin.com/api/v1/market/allTickers');
  return (data.data?.ticker || []).filter((t) => t.symbol.endsWith('-USDT')).map((t) => ({
    symbol: t.symbol.replace('-', ''), price: Number(t.last), quoteVol24h: Number(t.volValue), change24hPct: Number(t.changeRate) * 100,
  }));
}
// Bitget flags ~577 tokenized stocks with areaSymbol:"yes".
export async function bitget() {
  const [data, stocks] = await Promise.all([
    json('https://api.bitget.com/api/v2/spot/market/tickers'),
    stockSet('bitget', async () => {
      const j = await json('https://api.bitget.com/api/v2/spot/public/symbols');
      return new Set((j.data || []).filter((x) => x.areaSymbol === 'yes').map((x) => x.symbol));
    }),
  ]);
  return (data.data || [])
    .filter((t) => t.symbol.endsWith('USDT') && !stocks.has(t.symbol))
    .map((t) => ({
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
