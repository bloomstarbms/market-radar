// Rolling vocabulary of announcement product-line phrasing.
//
// WHY: isEquityText() was BINARY — equity or not-equity — while every other
// classifier in this system is three-state (unlocks verified/estimated/unverifiable,
// rug PASS/BLOCKED/UNVERIFIABLE/NOT_APPLICABLE, bypass audit structural/contingent/
// untested). Binary meant an unrecognised product line silently became "not equity,
// therefore crypto, therefore push": that is exactly why Bybit's "TradFi" rename
// surfaced as six pushes instead of one operator line.
//
// GRADUATION REQUIRES AN EXPLICIT ACT — it is NOT time-based.
// The first version quarantined new tokens for 7 days and then trusted them
// automatically. That expires on TIME, not on REVIEW: away for a week, or the
// operator line scrolls past during a busy stretch, and the token graduates itself.
// A silent policy change is precisely what the quarantine existed to prevent — the
// same "safeguard whose lapse is indistinguishable from its success" pattern fixed
// three times this week. So:
//
//   approved{} — REVIEWED. A human put it there. Trusted.
//   pending{}  — SEEN. Never trusted, however often or long it has been seen.
//                Recorded so it is not re-reported from scratch, and so the operator
//                line can ESCALATE with recurrence instead of fading.
//
// Promote with:  node approve-token.js <token> [...]
// The vocabulary is a REVIEWED ARTIFACT, not an accumulating cache.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const PATH = join(config.dataDir, 'announcement-vocab.json');

// Words that carry no product-line meaning: actions, plumbing, dates, boilerplate.
const STOP = new Set([
  'new', 'listing', 'listings', 'listed', 'list', 'lists', 'will', 'to', 'the', 'of', 'on', 'in', 'at',
  'and', 'or', 'a', 'an', 'for', 'with', 'up', 'now', 'available', 'launch', 'launches', 'launched',
  'launching', 'add', 'adds', 'added', 'support', 'supports', 'announcement', 'announces', 'notice',
  'contract', 'contracts', 'perpetual', 'perpetuals', 'perp', 'perps', 'futures', 'spot', 'margin',
  'trading', 'trade', 'pair', 'pairs', 'market', 'markets', 'leverage', 'x', 'usdt', 'usdc', 'usd',
  'delist', 'delisting', 'removal', 'remove', 'removes', 'suspend', 'suspension', 'update', 'updates',
  'is', 'are', 'be', 'been', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that', 'from', 'by',
  'am', 'pm', 'utc', 'today', 'tomorrow', 'week', 'month', 'day', 'days', 'hours', 'hour', 'time',
  'about', 'regarding', 're', 'more', 'other', 'others', 'all', 'some', 'via', 'per', 'as', 'into',
  'zone', 'seed', 'tag', 'innovation', 'assessment', 'monitoring', 'open', 'opens', 'opening', 'close',
  'closes', 'closing', 'start', 'starts', 'begin', 'begins', 'end', 'ends', 'complete', 'completed',
]);

// A title's candidate CATEGORY tokens: alphabetic words, not stopwords, not tickers.
export function categoryTokens(title) {
  const t = String(title || '')
    .replace(/,?\s*with up to \d+x leverage/ig, ' ')
    .replace(/\([^)]*\)/g, ' ')          // parentheticals: dates, market lists
    .replace(/[^A-Za-z\s]/g, ' ');       // digits/punctuation carry no category meaning
  const out = new Set();
  for (const raw of t.split(/\s+/)) {
    const w = raw.trim();
    if (w.length < 3 || w.length > 20) continue;
    const lower = w.toLowerCase();
    if (STOP.has(lower)) continue;
    if (/^[A-Z0-9]+$/.test(w)) continue; // ALL-CAPS = ticker or acronym, not a category
    out.add(lower);
  }
  return [...out];
}

const EMPTY = { approved: {}, pending: {} };
let cache = null;

export function loadVocab() {
  if (cache) return cache;
  try {
    const raw = existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : null;
    if (!raw) cache = structuredClone(EMPTY);
    else if (raw.approved || raw.pending) cache = { approved: raw.approved || {}, pending: raw.pending || {} };
    // Migration from the flat {token: ts} format: those were seeded from the
    // historical corpus, i.e. reviewed-by-bootstrap. Treat as approved.
    else cache = { approved: raw, pending: {} };
  } catch { cache = structuredClone(EMPTY); }
  return cache;
}

export function saveVocab(v = cache) {
  if (!v) return;
  const tmp = PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(v, null, 1));
  renameSync(tmp, PATH); // atomic, OneDrive-safe (same pattern as store.js)
}

// NOVEL = not in `approved`. Presence in `pending` never confers trust, no matter how
// old or how often seen — only review does.
export function novelTokens(title, { vocab = loadVocab() } = {}) {
  const approved = vocab.approved || {};
  return categoryTokens(title).filter((tok) => approved[tok] === undefined);
}

// Record sightings in `pending` (first/last seen, count, an example title) so the
// operator line can escalate rather than repeat identically.
export function notePending(title, { vocab = loadVocab(), now = Date.now() } = {}) {
  vocab.pending ??= {};
  const novel = novelTokens(title, { vocab });
  for (const tok of novel) {
    const e = (vocab.pending[tok] ??= { firstSeen: now, count: 0, example: String(title).slice(0, 120) });
    e.lastSeen = now; e.count += 1;
  }
  if (novel.length) saveVocab(vocab);
  return novel.map((tok) => ({ token: tok, ...vocab.pending[tok] }));
}

// Escalating prominence: an unreviewed token that keeps recurring gets louder.
export function pendingUrgency(entries, now = Date.now()) {
  const worst = entries.reduce((m, e) => Math.max(m, (now - e.firstSeen) / 86400e3), 0);
  const hits = entries.reduce((s, e) => s + (e.count || 0), 0);
  if (worst >= 7 || hits >= 10) return { level: 'UNREVIEWED-STALE', mark: '🚨🚨' };
  if (worst >= 1 || hits >= 3) return { level: 'UNREVIEWED-REPEAT', mark: '🚨' };
  return { level: 'UNREVIEWED-NEW', mark: '⚠️' };
}

export function approve(tokens, { now = Date.now() } = {}) {
  const v = loadVocab();
  const done = [];
  for (const tok of tokens.map((t) => String(t).toLowerCase())) {
    v.approved[tok] = now;
    delete v.pending?.[tok];
    done.push(tok);
  }
  saveVocab(v);
  return done;
}

export function pendingSummary() {
  const v = loadVocab();
  return Object.entries(v.pending || {})
    .map(([token, e]) => ({ token, ...e }))
    .sort((a, b) => (b.count || 0) - (a.count || 0));
}
