// Review symbols the classifier EXCLUDED from listing facts.
//
// EXCLUDE is a silent drop. UNRECOGNISED pushes and is logged; a wrong EXCLUDE
// produces a listing that never arrives, which looks exactly like a quiet day.
// CRYPTO_EXCEPTIONS in taxonomy.js is hand-maintained and therefore incomplete —
// GMX (stem 'GM' + X, and GM is General Motors) was caught only because 3,061 live
// symbols happened to be swept before a deploy. This is where the next one shows up.
//
//   node review-exclusions.js
//
// You are looking for a name you recognise as GENUINE CRYPTO. If you find one, add it
// to CRYPTO_EXCEPTIONS in src/core/taxonomy.js and add a fixture in test-delivery.js.
import { excludedSummary, stampExclusionReview } from './src/core/unclassified.js';

const rows = excludedSummary();
// Stamp the review — running this script IS the review, and the stamp is what lets
// the heartbeat distinguish "reviewed, nothing found" from "nobody looked".
stampExclusionReview();
if (!rows.length) { console.log('Nothing excluded yet.'); process.exit(0); }

const lev = rows.filter((r) => r.cls === 'LEVERAGED_TOKEN');
const eq = rows.filter((r) => r.cls === 'TOKENIZED_EQUITY');
const other = rows.filter((r) => !['LEVERAGED_TOKEN', 'TOKENIZED_EQUITY'].includes(r.cls));

const show = (title, list, note) => {
  if (!list.length) return;
  console.log(`\n${title} (${list.length})${note ? ' — ' + note : ''}`);
  for (const r of list) {
    const age = ((Date.now() - r.firstSeen) / 86400e3).toFixed(1);
    console.log(`  ${r.symbol.padEnd(16)} ${String(r.count).padStart(3)}x  [${r.venues.join(',')}]  ${age}d ago`);
    console.log(`      ${r.reason}`);
  }
};

show('LEVERAGED', lev, 'suffix rule is unambiguous; false positives unlikely');
show('xSTOCK', eq, 'HIGHEST COLLISION RISK — scan these for real crypto names');
show('OTHER', other);

console.log('\nIf any name above is genuine crypto, add it to CRYPTO_EXCEPTIONS in');
console.log('src/core/taxonomy.js and add a fixture so it cannot regress.');
