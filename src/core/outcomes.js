// Outcome tracker: records every tracked alert, then measures price change
// +1h/+6h/+24h later so signal quality can be judged from data, not vibes.
// alert.track = { kind:'cex'|'dex', exchange?, symbol?, chainId?, address?, price }
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { TRUSTED_QUOTES } from '../sources/dex/dexscreener.js';

const FILE = join(config.dataDir, 'outcomes.json');
// Market benchmark: every alert stores BTC's price so returns can be judged
// as ALPHA (alert return minus BTC return) instead of raw drift.
let btcCache = { price: 0, ts: 0 };
async function btcPrice() {
  if (Date.now() - btcCache.ts < 60e3 && btcCache.price) return btcCache.price;
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const j = await res.json();
    const p = Number(j.price);
    if (p) btcCache = { price: p, ts: Date.now() };
  } catch {}
  return btcCache.price || 0;
}
export { btcPrice };
const CHECKPOINTS = [[ 'h1', 3600e3 ], [ 'h6', 6 * 3600e3 ], [ 'h24', 24 * 3600e3 ]];
let rows = [];

export function loadOutcomes() {
  mkdirSync(config.dataDir, { recursive: true });
  if (existsSync(FILE)) rows = JSON.parse(readFileSync(FILE, 'utf8'));
}
const save = () => writeFileSync(FILE, JSON.stringify(rows, null, 1));

export function recordAlert(a) {
  if (!a.track?.price) return;
  const row = { ts: Date.now(), source: a.source, type: a.type, severity: a.severity,
    title: a.title, ...a.track, btc: 0, results: {}, alpha: {} };
  rows.push(row);
  btcPrice().then((p) => { if (p) { row.btc = p; save(); } }).catch(() => {});
  if (rows.length > 2000) rows = rows.slice(-2000);
  save();
}

async function currentPrice(r) {
  try {
    if (r.kind === 'cex') {
      const urls = {
        binance: `https://api.binance.com/api/v3/ticker/price?symbol=${r.symbol}`,
        mexc: `https://api.mexc.com/api/v3/ticker/price?symbol=${r.symbol}`,
        bybit: `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${r.symbol}`,
        gate: `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${r.symbol.replace('USDT','_USDT')}`,
        kucoin: `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${r.symbol.replace('USDT','-USDT')}`,
        bitget: `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${r.symbol}`,
      };
      const res = await fetch(urls[r.exchange]);
      const j = await res.json();
      return Number(j.price ?? j?.result?.list?.[0]?.lastPrice ?? j?.[0]?.last ?? j?.data?.price ?? j?.data?.[0]?.lastPr) || null;
    }
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/${r.chainId}/${r.address}`);
    const pairs = await res.json();
    let best = null;
    for (const p of pairs || []) {
      if (!TRUSTED_QUOTES.has((p.quoteToken?.symbol || '').toUpperCase())) continue;
      if (!best || (p.liquidity?.usd||0) > (best.liquidity?.usd||0)) best = p;
    }
    return Number(best?.priceUsd) || null;
  } catch { return null; }
}

// Called periodically: fill in any due checkpoints.
export async function checkOutcomes() {
  const now = Date.now();
  let dirty = false;
  for (const r of rows) {
    for (const [label, ms] of CHECKPOINTS) {
      if (r.results[label] !== undefined || now - r.ts < ms) continue;
      if (now - r.ts > ms + 2 * 3600e3) { r.results[label] = null; dirty = true; continue; } // too late, skip
      const p = await currentPrice(r);
      r.results[label] = p ? Number((((p - r.price) / r.price) * 100).toFixed(2)) : null;
      // alpha = asset return minus BTC return over the same window
      if (p && r.btc) {
        const nowBtc = await btcPrice();
        if (nowBtc) {
          const btcRet = ((nowBtc - r.btc) / r.btc) * 100;
          (r.alpha ??= {})[label] = Number((r.results[label] - btcRet).toFixed(2));
        }
      }
      dirty = true;
    }
  }
  if (dirty) save();
}

export function statsSummary() {
  const byType = {};
  for (const r of rows) {
    const k = `${r.source}:${r.type}`;
    const v = (byType[k] ||= { n: 0, h1: [], h24: [], a1: [], a24: [] });
    v.n++;
    if (typeof r.results?.h1 === 'number') v.h1.push(r.results.h1);
    if (typeof r.results?.h24 === 'number') v.h24.push(r.results.h24);
    if (typeof r.alpha?.h1 === 'number') v.a1.push(r.alpha.h1);
    if (typeof r.alpha?.h24 === 'number') v.a24.push(r.alpha.h24);
  }
  const avg = (a) => a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : '—';
  const win = (a) => a.length ? Math.round(100 * a.filter((x) => x > 0).length / a.length) + '%' : '—';
  const sign = (x) => (x !== '—' && Number(x) > 0 ? '+' : '') + x;
  // rank by 24h alpha — the number that actually matters
  const ranked = Object.entries(byType).sort((A, B) => (Number(avg(B[1].a24)) || -99) - (Number(avg(A[1].a24)) || -99));
  let out = `📊 Alert scoreboard (${rows.length} tracked)\nALPHA = return minus BTC over same window\n`;
  for (const [k, v] of ranked)
    out += `\n<b>${k}</b> · ${v.n} alerts\n  +1h  raw ${sign(avg(v.h1))}% · <b>alpha ${sign(avg(v.a1))}%</b> · win ${win(v.a1)}\n  +24h raw ${sign(avg(v.h24))}% · <b>alpha ${sign(avg(v.a24))}%</b> · win ${win(v.a24)}  (n=${v.a24.length})`;
  return rows.length ? out : '📊 No tracked alerts yet.';
}
