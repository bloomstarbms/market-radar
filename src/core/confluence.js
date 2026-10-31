// CONFLUENCE ENGINE
// Two independent signals landing on the same token inside a short window are
// worth far more than either alone. The pattern we care about:
//   (1) coins LEAVING an exchange (withdrawal = accumulation / cold storage), and
//   (2) real market activity on that same token (volume spike / price move).
// Accumulation followed by activity is the actual revival footprint — as opposed
// to volume with no accumulation (noise) or accumulation with no follow-through.
//
// INPUTS, as of the 29 Oct burst (11 calls, every one on two Binance batch transfers):
// - One transaction is one event. Binance 14 moved 63 tokens in one tx, 12 of them on the watchlist,
//   and each became its own "withdrawal". An event is keyed by its tx hash, lists every watchlist
//   token it moved, and fires CONFLUENCE at most once.
// - A withdrawal to an address with no history before it is the exchange's own operation (whale.js
//   labels it exchange-internal) and is not accumulation at all.
// - The DEX 1h change is checked against the CEX price before it counts (cexref.js).
// - Events are state, not memory: two restarts on 30 Oct each erased what CONFLUENCE had seen.
import { dispatch } from './dispatcher.js';
import { getState, save } from './store.js';
import { cexRef, dexH1Check } from './cexref.js';

const WINDOW_MS = 12 * 3600e3; // how long a whale event stays "fresh"
const MAX_EVENTS = 500;

const events = () => (getState().whaleEvents ??= {}); // id -> { hash, exchange, direction, label, ts, tokens: { key: { symbol, usd, history } }, consumed? }

function prune(now) {
  const ev = events();
  for (const [id, e] of Object.entries(ev)) if (now - e.ts > WINDOW_MS) delete ev[id];
  const ids = Object.keys(ev);
  if (ids.length > MAX_EVENTS) for (const id of ids.sort((a, b) => ev[a].ts - ev[b].ts).slice(0, ids.length - MAX_EVENTS)) delete ev[id];
}

// Called by the whale module on every dispatched on-chain move.
export function noteWhale(key, { direction, exchange, usd, symbol, isWithdrawal, hash, label, history }, now = Date.now()) {
  const ev = events();
  const id = hash ? `${String(key).split(':')[0]}:${hash}` : `${key}:${now}`;
  const e = (ev[id] ??= { hash: hash ?? null, exchange, direction, label: label ?? (isWithdrawal ? 'accumulation' : 'other'), ts: now, tokens: {} });
  if (label === 'exchange-internal') e.label = label; // one fresh-address verdict marks the whole tx
  e.tokens[key] = { symbol, usd, history: history ?? null };
  prune(now);
  save();
}

// Every live event that moved this token, newest first (the fixtures and the replay read this).
export function whaleEventsFor(key, now = Date.now()) {
  return Object.entries(events()).filter(([, e]) => e.tokens?.[key] && now - e.ts <= WINDOW_MS)
    .map(([id, e]) => ({ id, ...e })).sort((a, b) => b.ts - a.ts);
}
// The newest unconsumed accumulation event that moved this token.
export function accumulationFor(key, now = Date.now()) {
  return whaleEventsFor(key, now).find((e) => e.label === 'accumulation' && !e.consumed) ?? null;
}

const dropLogged = new Set(); // event|token|why: a set-aside DEX 1h is logged once per event, not per poll

// Called by the DEX poll with live market state for a watchlist token.
// Fires only when a recent WITHDRAWAL is paired with genuine market activity.
export async function checkConfluence(pair, { volH1, volAvgH1, priceH1, h1Distrusted = false, cex }) {
  const key = `${pair.chainId}:${pair.baseToken.address}`;
  const e = accumulationFor(key);
  if (!e) return false;
  const w = e.tokens[key];

  const chk = dexH1Check({ dexH1: priceH1, dexPrice: Number(pair.priceUsd), cex: cex !== undefined ? cex : cexRef(pair.baseToken.symbol), chainDistrusted: h1Distrusted });
  const pct = (x) => `${x >= 0 ? '+' : ''}${x}%`;
  if (!chk.use && priceH1) {
    const tag = `${e.id}|${key}|${chk.why}`;
    if (!dropLogged.has(tag)) {
      if (dropLogged.size > 5000) dropLogged.clear();
      dropLogged.add(tag);
      console.log(`  [confluence] ${pair.baseToken.symbol} (${pair.chainId}): DEX 1h ${pct(priceH1)} not used this evaluation — ${chk.reason}`);
    }
  }
  const h1 = chk.use ? priceH1 : 0;
  const volRatio = volAvgH1 > 0 ? volH1 / volAvgH1 : 0;
  const hasActivity = (volRatio >= 2 && volH1 >= 50_000) || h1 >= 8;
  if (!hasActivity) return false;

  const hoursAgo = ((Date.now() - e.ts) / 3600e3).toFixed(1);
  const batch = Object.keys(e.tokens).length;
  const fired = await dispatch({
    source: 'SIG', type: 'CONFLUENCE', severity: 'HIGH', key, cooldownMin: 720,
    title: `${pair.baseToken.symbol}: accumulation + activity (${pair.chainId})`,
    lines: [
      `🔻 ${e.exchange} withdrawal $${fmt(w.usd)} — ${hoursAgo}h ago (coins left the exchange)${batch > 1 ? ` · one tx moving ${batch} watchlist tokens` : ''}`,
      `📊 Now moving: volume $${fmt(volH1)}/h (${volRatio.toFixed(1)}x avg)${h1 ? ` · price ${pct(h1)} 1h` : priceH1 ? ` · DEX 1h ${pct(priceH1)} set aside (${chk.why})` : ''}`,
      `Two independent signals aligned — accumulation followed by real activity`,
      `Price: $${pair.priceUsd} · Liq: $${fmt(pair.liquidity?.usd || 0)}`,
    ],
    url: pair.url,
    track: { kind: 'dex', chainId: pair.chainId, address: pair.baseToken.address, price: Number(pair.priceUsd) || 0 },
  });
  if (fired) { // consume the EVENT, not the token: one tx fires once, and a later token of it cannot revive it
    const ev = events()[e.id];
    if (ev) { ev.consumed = Date.now(); save(); }
  }
  return fired;
}

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Number(n).toFixed(0);
