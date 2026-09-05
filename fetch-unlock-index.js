// UNLOCK INDEX FETCH — this is the INDEX, not evidence.
//
//   node fetch-unlock-index.js            refresh data/unlock-index.json
//   node fetch-unlock-index.js --all      keep every protocol (default: only symbols
//                                         already tracked in unlocks.json + the file's
//                                         existing set, to keep the file small)
//
// Loads https://defillama.com/unlocks, parses the embedded __NEXT_DATA__
// (props.pageProps.data, ~370 protocols) and emits a dated index of names, symbols,
// chain:address tokens and BATCH events (cliff, or linear with rateDurationDays>=28).
// Every field is a CLAIM attributed to DefiLlama. Nothing here is a verified fact;
// dates from this file never reach a verified row. Sourced rows cite it BY NAME.
//
// FAILS LOUD. An empty or unparseable page must never return an empty index: an
// empty index would read as "every source event was removed" and demote every
// sourced row at once. Exit code 2 = fetch/parse failure, nothing written.
//
// KNOWN: the sandbox this was first built in receives HTTP 403 (Cloudflare) from
// defillama.com; the first index (2026-09-05) was captured through the browser pane.
// On the operator's desktop a plain fetch may succeed. If it does not, the weekly
// recheck does NOTHING (feedWasLooking) and sourced rows go STALE at 21 days —
// the failure surfaces as staleness in the heartbeat, never as a false demotion.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

const OUT = 'data/unlock-index.json';
const keepAll = process.argv.includes('--all');

export async function fetchIndex() {
  const r = await fetch('https://defillama.com/unlocks', {
    headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' }, signal: AbortSignal.timeout(30000),
  });
  if (r.status !== 200) throw new Error(`defillama.com/unlocks HTTP ${r.status} — index NOT refreshed`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('__NEXT_DATA__ not found in page — the embed moved; index NOT refreshed');
  const j = JSON.parse(m[1]);
  const data = j?.props?.pageProps?.data;
  if (!Array.isArray(data) || data.length < 50) throw new Error(`pageProps.data missing or implausibly small (${Array.isArray(data) ? data.length : typeof data}) — index NOT refreshed`);
  return { data, generatedAtSec: j.props.pageProps.generatedAtSec };
}

export function trim(data, generatedAtSec, keep = null) {
  const now = Math.floor(Date.now() / 1000), W = 400 * 86400, PAST = 120 * 86400;
  const protocols = [];
  for (const p of data) {
    const sym = (p.tSymbol || '').toUpperCase();
    if (keep && !keep.has(sym)) continue;
    const byT = {};
    for (const e of p.events || []) {
      if (e.timestamp < now - PAST || e.timestamp > now + W) continue;
      if (!(e.unlockType === 'cliff' || (e.unlockType === 'linear' && (e.rateDurationDays || 0) >= 28))) continue;
      const k = e.timestamp + '|' + e.unlockType;
      byT[k] = byT[k] || { t: e.timestamp, type: e.unlockType, n: 0, cats: new Set(), rd: e.rateDurationDays };
      const amt = Array.isArray(e.noOfTokens) ? Number(e.noOfTokens[e.noOfTokens.length - 1] || 0) : Number(e.noOfTokens || 0);
      byT[k].n += amt; byT[k].cats.add(e.category);
    }
    protocols.push({ name: p.name, symbol: sym, token: p.token, gecko_id: p.gecko_id,
      circSupply: p.circSupply, totalLocked: p.totalLocked, maxSupply: p.maxSupply,
      events: Object.values(byT).sort((a, b) => a.t - b.t).map((e) => ({ t: e.t, type: e.type, n: Math.round(e.n), cats: [...e.cats].join('+'), ...(e.rd ? { rd: +e.rd.toFixed(2) } : {}) })) });
  }
  return { fetchedAt: new Date().toISOString().slice(0, 16), generatedAtSec,
    source: 'defillama.com/unlocks __NEXT_DATA__ props.pageProps.data — INDEX ONLY: every field is a CLAIM attributed to DefiLlama, never a verified fact',
    note: 'events merged by (timestamp,type), categories joined, past window 120d, future 400d', protocols };
}

const IS_CLI = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (IS_CLI) {
  try {
    const { data, generatedAtSec } = await fetchIndex();
    let keep = null;
    if (!keepAll) {
      keep = new Set();
      try { for (const t of JSON.parse(readFileSync('unlocks.json', 'utf8')).tokens) keep.add(t.sym); } catch { /* none */ }
      if (existsSync(OUT)) { try { for (const p of JSON.parse(readFileSync(OUT, 'utf8')).protocols) keep.add(p.symbol); } catch { /* ignore */ } }
    }
    const out = trim(data, generatedAtSec, keep);
    writeFileSync(OUT + '.tmp', JSON.stringify(out));
    renameSync(OUT + '.tmp', OUT);
    console.log(`index refreshed: ${out.protocols.length} protocols, ${out.protocols.reduce((s, p) => s + p.events.length, 0)} batch events → ${OUT}`);
  } catch (e) {
    console.error('[OPERATOR] fetch-unlock-index FAILED — index NOT refreshed:', e.message);
    process.exit(2);
  }
}
