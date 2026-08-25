// Outcome tracker: records every tracked alert, then measures price change
// +1h/+6h/+24h later so signal quality can be judged from data, not vibes.
// alert.track = { kind:'cex'|'dex', exchange?, symbol?, chainId?, address?, price }
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, copyFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { TRUSTED_QUOTES } from '../sources/dex/dexscreener.js';
import { fallbackPrice } from '../sources/price-fallback.js';

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
  // Binance is a single point of failure here, and a miss is permanent: btc is stamped
  // once when the alert is recorded, so a 0 means that alert never gets an alpha score.
  if (!btcCache.price || Date.now() - btcCache.ts >= 60e3) {
    const p = await fallbackPrice('BTC');
    if (p) {
      btcCache = { price: p, ts: Date.now() };
      console.log('[outcomes] BTC benchmark served by CryptoRank fallback');
    }
  }
  return btcCache.price || 0;
}
export { btcPrice };
const CHECKPOINTS = [[ 'h1', 3600e3 ], [ 'h6', 6 * 3600e3 ], [ 'h24', 24 * 3600e3 ]];
const MAX_ROWS = Number(process.env.OUTCOMES_MAX_ROWS || 20000);
let rows = [];

// Exposed to the scorer without an import cycle (outcomes imports the dispatcher's
// dependencies; the dispatcher imports the scorer). Set once at load.
export function allOutcomes() { return rows; }
globalThis.__outcomesHook = { allOutcomes };

export function loadOutcomes() {
  mkdirSync(config.dataDir, { recursive: true });
  if (existsSync(FILE)) { rows = JSON.parse(readFileSync(FILE, 'utf8')); expectedMtime = statSync(FILE).mtimeMs; }
  // Regime tags are DERIVED, not stored-and-hoped: an earlier file-edit backfill was
  // silently clobbered by the running bot's save() (lost-update race). The floor's
  // epoch is self-evident from the data — the first row carrying a suppression
  // reason — so recompute missing tags on every load. Editing outcomes.json while
  // the bot runs is forbidden; this makes the tag survive it anyway.
  const firstSup = Math.min(...rows.filter((r) => r.suppressed).map((r) => r.ts));
  if (Number.isFinite(firstSup)) {
    for (const r of rows) r.collectedUnder ??= r.ts < firstSup ? 'UNFILTERED' : 'FLOORED';
  }
}
// LOST-UPDATE GUARD (structural, not a rule enforced by memory): the regime-tag
// backfill was clobbered because save() blindly overwrote a file someone else had
// modified. Now every save checks the file's mtime against the one WE last wrote.
// Mismatch = external edit (backfill script, OneDrive restore, conflict copy) ->
// our state goes to a .conflict sidecar and the operator is told, never a clobber.
let expectedMtime = null;
function guardedWrite(file, body) {
  try {
    if (expectedMtime !== null && existsSync(file)) {
      const m = statSync(file).mtimeMs;
      if (Math.abs(m - expectedMtime) > 1) {
        const side = file + '.conflict-' + Date.now() + '.json';
        writeFileSync(side, body);
        console.error(`[outcomes][OPERATOR] ${file} modified externally (mtime drift) — state written to ${side}, reconcile manually. NOT overwriting.`);
        return;
      }
    }
    writeFileSync(file, body);
    expectedMtime = statSync(file).mtimeMs;
  } catch (e) { console.error('[outcomes] save failed:', e.message); }
}
const save = () => guardedWrite(FILE, JSON.stringify(rows, null, 1));

// The row literal below is a WHITELIST — deliberate schema control, but it silently
// discards any field a producer adds and nobody mirrors here. `mult` was dropped that
// way for two days and was only caught because it happened to be instrumented; the
// NEXT field would not be, and the discovery would be a query returning nulls weeks
// later. So: keep the whitelist, make the omission LOUD. Anything a caller supplies
// that is neither persisted nor deliberately transient is named once per process.
const ROW_FIELDS = new Set(['ts', 'source', 'type', 'severity', 'title', 'btc', 'results', 'alpha',
  'suppressed', 'score', 'mult', 'kind', 'collectedUnder', 'rug', 'mfe', 'mae']);
// Transient by design: routing/formatting inputs that were never meant to persist.
const NOT_PERSISTED = new Set(['lines', 'url', 'key', 'dedupeKey', 'cooldownMin', 'track',
  'snapshotTs', 'gate', 'assetClass', 'deferredEval', 'venue', 'delist', 'scoreBonus',
  'novel', 'would', 'provisional', 'updates', 'tier', 'allow', 'mode', 'charge', 'bypass', 'reason']);
// Pure, so it can be tested WITHOUT calling recordAlert against the live module —
// which would push rows into memory and can flush them to the real outcomes file.
export function droppedFields(a) {
  return Object.keys(a || {}).filter((k) => !ROW_FIELDS.has(k) && !NOT_PERSISTED.has(k));
}
const reportedDrops = new Set();
function warnDroppedFields(a) {
  for (const k of droppedFields(a)) {
    if (reportedDrops.has(k)) continue;
    reportedDrops.add(k);
    console.error(`[outcomes][OPERATOR] field '${k}' was supplied to recordAlert but is NOT in the row whitelist — it is being DISCARDED on every write. If it should persist, add it to the row literal AND to ROW_FIELDS in core/outcomes.js; if it is transient, add it to NOT_PERSISTED to silence this.`);
  }
}

export function recordAlert(a) {
  if (!a.track?.price) return;
  warnDroppedFields(a);
  const row = { ts: Date.now(), source: a.source, type: a.type, severity: a.severity,
    title: a.title, ...a.track, btc: 0, results: {}, alpha: {},
    // null when the alert was actually pushed; otherwise the suppression reason, so
    // pushed vs suppressed precision can be compared per module.
    suppressed: a.suppressed ?? null, score: a.score ?? null,
    // Multiplier AT DECISION TIME (v0.20.2). This row is built from an explicit
    // WHITELIST, so a field the caller passes but this literal omits is silently
    // dropped — which is what happened to `mult` for two days: dispatcher stamped it,
    // recordAlert discarded it, and nothing complained. Any new per-row field must be
    // added HERE as well as at the call site.
    mult: a.mult ?? null,
    // FACT | CALL (v0.23.0) — facts are unscored by design, so without this column a
    // future analysis cannot tell an unscored fact from a scoring failure.
    kind: a.kind ?? null,
    // Which sampling regime produced this row. Pre-v0.11 the bot pushed essentially
    // everything, so those rows are an unfiltered census. From v0.11 the floor and
    // budget select what gets pushed, and only the suppression logging keeps the
    // sample complete. The corpus is about to be a mixture of the two, and multipliers
    // will drift for sampling reasons rather than performance reasons — this column is
    // what lets those be told apart later. Unrecoverable if added after the fact.
    collectedUnder: 'FLOORED',
    // Contract-risk verdict at alert time, when one was computed. Recorded even on
    // blocked candidates so the screen accumulates a point-in-time calibration set
    // with forward outcomes attached.
    rug: a.rug ?? null };
  rows.push(row);
  btcPrice().then((p) => { if (p) { row.btc = p; save(); } }).catch(() => {});
  // 2000 was ~2.5 weeks of alerts and the cap was silently evicting the oldest rows
  // right as the history became useful for threshold tuning. At ~320 bytes/row,
  // 20000 is ~6MB — still trivial to load, and roughly six months of runway.
  // Evict-to-archive, never evict-to-nothing. Precision multipliers need long windows,
  // n>=100 accumulates slowly, and the rug calibration set attaches +72h outcomes to
  // verdicts frozen weeks earlier — oldest-first deletion would give all of that a
  // silent shelf life. Archived rows are JSONL (append-only, crash-safe, greppable).
  if (rows.length > MAX_ROWS) {
    const evicted = rows.slice(0, rows.length - MAX_ROWS);
    try {
      appendFileSync(join(config.dataDir, 'outcomes-archive.jsonl'),
        evicted.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch (e) { console.error('[outcomes] archive append failed — keeping rows in memory:', e.message); return; }
    rows = rows.slice(-MAX_ROWS);
  }
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

// Daily consistent backup — the JSON analogue of SQLite's VACUUM INTO.
// The outcomes corpus is the least replaceable artifact in the project: point-in-time
// rug verdicts frozen at alert time, the regime-tagged rows the precision multipliers
// are computed from. Code is rewritable in a weekend; this is not.
// PARSE-VERIFY BEFORE WRITE: the snapshot is round-tripped through JSON.parse first,
// so a torn/corrupt live file can never overwrite a good backup. Resulting files are
// closed, which makes them safe for OneDrive sync in a way the live file never was.
// Keeps 14 dailies.
let lastBackup = 0;
export function backupOutcomes() {
  if (Date.now() - lastBackup < 24 * 3600e3) return;
  lastBackup = Date.now();
  try {
    const dir = join(config.dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const snapshot = JSON.stringify(rows);          // from live memory, not the file
    JSON.parse(snapshot);                           // verify before it touches disk
    writeFileSync(join(dir, `outcomes-${day}.json`), snapshot);
    const arch = join(config.dataDir, 'outcomes-archive.jsonl');
    if (existsSync(arch)) copyFileSync(arch, join(dir, `archive-${day}.jsonl`));
    const stateFile = join(config.dataDir, 'state.json');
    if (existsSync(stateFile)) {
      const s = readFileSync(stateFile, 'utf8');
      JSON.parse(s);                                // same guard for state (ADV, universe, threads)
      writeFileSync(join(dir, `state-${day}.json`), s);
    }
    // prune to 14 days
    for (const f of readdirSync(dir)) {
      const m = f.match(/(\d{4}-\d{2}-\d{2})/);
      if (m && Date.now() - Date.parse(m[1]) > 14 * 86400e3) rmSync(join(dir, f), { force: true });
    }
    console.log(`[backup] daily snapshot written: ${rows.length} rows -> data/backups/*-${day}.*`);
  } catch (e) {
    console.error('[backup][OPERATOR] daily backup FAILED:', e.message);
  }
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
      // 3-point path (h1/h6/h24) MFE/MAE — free, since we fetched the price anyway.
      // Crude, but it is what converts "would a stop/target help" from the path-free
      // approximation (which says stops HURT here) into a measurable question.
      if (typeof r.results[label] === 'number') {
        r.mfe = Math.max(r.mfe ?? -Infinity, r.results[label]);
        r.mae = Math.min(r.mae ?? Infinity, r.results[label]);
      }
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
