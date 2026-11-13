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

// FOLLOW CLAIM (v0.34.0, builder-follows). A follow is a follow: nothing in a follow
// message may say or imply that the watcher backs, endorses or invested in the account.
// The module runs this over its whole public rendering and refuses to send on a hit; an
// account bio that trips it is withheld rather than quoted.
// 2026-10-27: + "partner", "partnership" (and their plurals/tense), "in the ecosystem", "backed".
// RELEASE SPIN (2026-11-13, macro forecasts). A release message states the actual beside
// the forecast and the previous figure. "Above/below/in line with forecast" is allowed;
// the words that characterise the print are not: "hotter than expected", "a beat", "a
// miss", "surprise", "dovish", "hawkish". Separate from DIRECTION so the rest of the bot's
// prose (an unlock "near miss" in an operator basis line) is not caught by a macro rule;
// macro.js runs macroProblems over every public line it renders from data.
export const MACRO_SPIN = /\b(hotter|cooler|beats?|beaten|miss(?:es)?|surpris(?:e|es|ed|ing)|dovish|hawkish)\b/i;
export function macroProblems(text) {
  const p = proseProblems(text);
  const m = String(text ?? '').match(MACRO_SPIN);
  if (m) p.push(`release spin ("${m[0]}")`);
  return p;
}

// TRADFI CLAIM (2026-11-11). A TradFi perp message states a contract, its underlying and
// its times. Nothing in it may frame the contract as a chance to be had ("IPO
// opportunity", "get in early"). sources/cex/tradfi.js refuses to send on a hit.
export const TRADFI_CLAIM = /\b(opportunit(?:y|ies)|early access|get in early|ground floor|before (?:the|its) ipo|ipo (?:play|pop|gains?)|upside|undervalued|don'?t miss|last chance|exclusive access)\b/i;
export function tradfiProblems(text) {
  const p = proseProblems(text);
  const m = String(text ?? '').match(TRADFI_CLAIM);
  if (m) p.push(`tradfi claim ("${m[0]}")`);
  return p;
}

export const FOLLOW_CLAIM =/\b(backed by|backed|backing|endorsed|invested|partners?|partnered|partnerships?|in the ecosystem)\b/i;
export function followProblems(text) {
  const p = proseProblems(text);
  const m = String(text ?? '').match(FOLLOW_CLAIM);
  if (m) p.push(`follow claim ("${m[0]}")`);
  return p;
}
