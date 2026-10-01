// PROSE LINT — one home for the two rules fixture 30 enforces over message text.
//
//   RULE 1 (facts): no DIRECTIONAL claims or imperatives. The project's own measurement
//   says agreement predicts MAGNITUDE not DIRECTION, so volatility language stays and
//   direction language goes.
//   RULE 2 (everything): no FREQUENCY CLAIM without a sample size on the same line.
//
// Fixture 30 used to hold these regexes inline and lint SOURCE strings only. The macro
// calendar's `plain` sentence (v0.33.1) is prose that reaches the public rendering from
// a DATA file, so the same rules must reach it — and a second copy of the regex would be
// the drift class this project has paid for three times. Exported once, used by the
// fixture and by macro.js at render time (a `plain` that fails falls back to the
// built-in sentence and the operator is told).
export const DIRECTION = /(close now|exit here|buy now|sell now|take profit|dump hard|sell off sharply|capitulation bottom|blow-off top|reversal risk|front-run|bleeds into|drift usually|cut odds rise|bid on a soft|soft print →|bearish|bullish)/i;
export const FREQ = /\b(usually|typically|historically|often|frequently|tend to|most of the time)\b/i;
export const EVIDENCE = /n\s*[=>≥]|\b\d+\s*of\s*\d+\b|\bmeasured\b|percentile|\bp99\b/i;

// Pure: the problems a line of public prose has, [] when clean.
export function proseProblems(text) {
  const t = String(text ?? '');
  const p = [];
  if (DIRECTION.test(t)) p.push('directional claim');
  if (FREQ.test(t) && !EVIDENCE.test(t)) p.push('frequency claim without evidence');
  return p;
}
