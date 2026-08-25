// Promote announcement vocabulary tokens from `pending` (seen) to `approved`
// (reviewed). Graduation is an EXPLICIT ACT — tokens never trust themselves with the
// passage of time, because an expiring quarantine is a silent policy change.
//
//   node approve-token.js                 -> list what is pending review
//   node approve-token.js tradfi neofi    -> approve those tokens
import { approve, pendingSummary, pendingUrgency } from './src/core/vocab.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));

if (!args.length) {
  const pend = pendingSummary();
  if (!pend.length) { console.log('Nothing pending review — every seen token is approved.'); process.exit(0); }
  console.log(`${pend.length} token(s) awaiting review. These are NOT trusted; announcements carrying them\n` +
    'route to the digest instead of pushing, indefinitely, until approved here.\n');
  for (const e of pend) {
    const age = ((Date.now() - e.firstSeen) / 86400e3).toFixed(1);
    const u = pendingUrgency([e]);
    console.log(`  ${u.mark} ${e.token.padEnd(18)} seen ${String(e.count).padStart(3)}x · first ${age}d ago`);
    console.log(`     e.g. "${e.example}"`);
  }
  console.log('\nApprove ONLY tokens that are legitimate crypto product lines:');
  console.log('  node approve-token.js <token> [...]');
  console.log('If a token marks TOKENIZED EQUITIES, do NOT approve it — add the label to');
  console.log('EQUITY_TEXT_RX in src/core/taxonomy.js so those announcements are dropped.');
  process.exit(0);
}

const done = approve(args);
console.log(`approved: ${done.join(', ')}`);
console.log('Announcements carrying these tokens will now classify normally.');
