// BROWSER-PANE IMPORT PATH for the unlock index.
//
//   node import-unlock-index.js <file.b64>
//
// defillama.com/unlocks returns Cloudflare 403 to BOTH the sandbox and the
// operator's desktop (re-tested 2026-09-07), so fetch-unlock-index.js cannot run
// unattended. The working route is the in-app browser pane, which loads the page
// normally. This script is the second half of that route: the pane emits a
// gzip+base64 blob of a COMPACT encoding, this expands it to the exact schema
// fetch-unlock-index.js would have written.
//
// The exact browser-pane snippet is recorded in NEXT-SESSION.md. Two properties
// make the hand-carried transfer safe:
//   - gzip's CRC fails loud on any truncation or transcription slip; a corrupt
//     blob produces no file at all rather than a partial index.
//   - the same plausibility gate as the direct fetch (>= 20 protocols, >= 50
//     events) refuses a suspiciously empty import, because an empty index would
//     read as "every source event was removed" and demote every sourced row.
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const OUT = 'data/unlock-index.json';
const src = process.argv[2];
if (!src) { console.error('usage: node import-unlock-index.js <file.b64>'); process.exit(2); }

export function expand(compact) {
  const { f, g, cats, P } = compact;
  if (!Array.isArray(P)) throw new Error('compact.P missing');
  const protocols = P.map(([name, symbol, token, gecko_id, circSupply, totalLocked, maxSupply, ev]) => ({
    name, symbol, token, gecko_id, circSupply, totalLocked, maxSupply,
    events: ev.map(([t, ty, n, ci, rd]) => ({ t, type: ty === 0 ? 'cliff' : 'linear', n, cats: cats[ci], ...(rd ? { rd } : {}) })),
  }));
  return { fetchedAt: f, generatedAtSec: g,
    source: 'defillama.com/unlocks __NEXT_DATA__ props.pageProps.data via browser pane — INDEX ONLY: every field is a CLAIM attributed to DefiLlama, never a verified fact',
    note: 'events merged by (timestamp,type), categories joined, past window 120d, future 400d; carried from the browser pane as gzip+base64 (CRC-checked)',
    protocols };
}

try {
  const compact = JSON.parse(gunzipSync(Buffer.from(readFileSync(src, 'utf8').trim(), 'base64')).toString());
  const out = expand(compact);
  const events = out.protocols.reduce((s, p) => s + p.events.length, 0);
  if (out.protocols.length < 20 || events < 50) throw new Error(`implausibly small import (${out.protocols.length} protocols, ${events} events) — index NOT replaced`);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(out.fetchedAt || '')) throw new Error(`fetchedAt '${out.fetchedAt}' is not a timestamp — index NOT replaced`);
  if (existsSync(OUT)) copyFileSync(OUT, OUT.replace('.json', `.${new Date().toISOString().slice(0, 10)}.bak.json`));
  writeFileSync(OUT + '.tmp', JSON.stringify(out));
  renameSync(OUT + '.tmp', OUT);
  console.log(`index imported: ${out.protocols.length} protocols, ${events} batch events, fetchedAt ${out.fetchedAt} → ${OUT}`);
} catch (e) {
  console.error('[OPERATOR] import-unlock-index FAILED — index NOT replaced:', e.message);
  process.exit(2);
}
