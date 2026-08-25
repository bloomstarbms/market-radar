// Review announcement titles that matched NO catalyst pattern.
//
// Hand-written patterns against free text always have silent holes — both 16 Aug bugs
// were patterns that looked right and matched nothing. This is where a title that
// SHOULD have matched becomes visible instead of vanishing.
//
//   node review-unclassified.js          -> recurring shapes first (count >= 2)
//   node review-unclassified.js --all    -> everything, including one-offs
//
// Most rows are genuine non-news: venue blog posts, regional notices, wallet updates.
// You are looking for a shape that describes a real catalyst we are blind to.
import { unclassifiedSummary } from './src/core/unclassified.js';

const all = process.argv.includes('--all');
const rows = unclassifiedSummary({ minCount: all ? 1 : 2 });

if (!rows.length) {
  console.log(all ? 'Nothing unclassified recorded yet.' : 'No RECURRING unclassified shapes. Use --all to see one-offs.');
  process.exit(0);
}

console.log(`${rows.length} unclassified shape(s)${all ? '' : ' seen 2+ times'}:\n`);
for (const e of rows) {
  const ageD = ((Date.now() - e.firstSeen) / 86400e3).toFixed(1);
  console.log(`  ${String(e.count).padStart(3)}x  [${e.venues.join(',')}]  first ${ageD}d ago`);
  console.log(`        "${e.example}"`);
}
console.log('\nIf a shape is a real catalyst we are missing, add the phrasing to the');
console.log('relevant branch in src/sources/cex/announcements.js classify() — and add a');
console.log('fixture for it in test-delivery.js so it cannot silently break again.');
