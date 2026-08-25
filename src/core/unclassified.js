// NULL-CLASSIFICATION LOG.
//
// Both bugs on 16 Aug were the same shape: a hand-written pattern that LOOKED right
// and matched NOTHING. SUSPEND_RX searched for "suspend" inside titles that all say
// "suspension"; the spot-listing pattern lacked "new listing", the commonest phrasing
// of all. Neither failed loudly — the titles simply classified null and vanished, and
// the historical count is UNRECOVERABLE because nulls were never recorded. That
// irrecoverability is the argument for this file.
//
// Patterns against free text always have silent holes. So every announcement that
// matches no catalyst pattern is recorded with its title and a count, and reviewed
// periodically the same way pending vocabulary tokens are. A title that SHOULD have
// matched and didn't becomes visible instead of vanishing.
//
// Deliberately NOT an alert: an unmatched title is usually genuine non-news (venue
// blog posts, regional notices). The signal is in the review, not in a push.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const PATH = join(config.dataDir, 'unclassified.json');
const MAX = 400;

// Collapse to a shape so twenty near-identical titles become one reviewable row:
// strip tickers, digits, dates and parentheticals, keep the phrasing skeleton.
export function shapeOf(title) {
  return String(title || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b[A-Z0-9]{2,15}(?:USDT|USD|KRW)?\b/g, '<SYM>')
    .replace(/\d+/g, 'N')
    .replace(/[^\w<>\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 90);
}

let cache = null;
function load() {
  if (cache) return cache;
  try { cache = existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : {}; } catch { cache = {}; }
  return cache;
}
function persist(v) {
  const tmp = PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(v, null, 1));
  renameSync(tmp, PATH);
}

export function noteUnclassified(venue, title, now = Date.now()) {
  const v = load();
  const shape = shapeOf(title);
  if (!shape) return;
  const e = (v[shape] ??= { count: 0, firstSeen: now, venues: [], example: String(title).slice(0, 140) });
  e.count += 1;
  e.lastSeen = now;
  if (venue && !e.venues.includes(venue)) e.venues.push(venue);
  // Keep the most-seen shapes; a one-off blog post matters less than a recurring
  // phrasing we may be blind to.
  const keys = Object.keys(v);
  if (keys.length > MAX) {
    const worst = keys.sort((a, b) => (v[a].count || 0) - (v[b].count || 0)).slice(0, keys.length - MAX);
    for (const k of worst) delete v[k];
  }
  persist(v);
}

export function unclassifiedSummary({ minCount = 1 } = {}) {
  const v = load();
  return Object.entries(v)
    .filter(([, e]) => e.count >= minCount)
    .map(([shape, e]) => ({ shape, ...e }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------- exclusion log
//
// EXCLUDE is a SILENT DROP, and that is where the damage lives. The null log covers
// titles that matched nothing, and the review log covers UNRECOGNISED — but both of
// those still PUSH or are visibly pending. A wrong EXCLUDE produces a listing that
// never arrives, which is indistinguishable from a quiet day.
//
// GMX was caught only because 3,061 live symbols happened to be swept before deploy.
// CRYPTO_EXCEPTIONS is hand-maintained and therefore guaranteed incomplete, so its
// failure mode is permanent invisible suppression. Every exclusion is recorded with
// the rule that matched it, and the count is surfaced in the heartbeat — an
// unexpected name in a weekly review catches the next collision in days, not never.
const EX_PATH = join(config.dataDir, 'excluded-symbols.json');
let exCache = null;
function loadEx() {
  if (exCache) return exCache;
  try { exCache = existsSync(EX_PATH) ? JSON.parse(readFileSync(EX_PATH, 'utf8')) : {}; } catch { exCache = {}; }
  return exCache;
}
export function noteExcluded(symbol, cls, reason, venue, now = Date.now()) {
  const v = loadEx();
  const key = String(symbol || '').toUpperCase();
  if (!key) return;
  const e = (v[key] ??= { cls, reason, venues: [], count: 0, firstSeen: now });
  e.count += 1; e.lastSeen = now; e.cls = cls; e.reason = reason;
  if (venue && !e.venues.includes(venue)) e.venues.push(venue);
  const tmp = EX_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(v, null, 1));
  renameSync(tmp, EX_PATH);
}
export function excludedSummary() {
  const v = loadEx();
  return Object.entries(v).map(([symbol, e]) => ({ symbol, ...e }))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}
// Review stamp — "the next weekly review" is a HABIT, not a mechanism, and that is
// the self-expiring-quarantine shape again: a safeguard whose lapse (nobody looked)
// is indistinguishable from its success (nothing to see). review-exclusions.js stamps
// its run; the heartbeat escalates only when COLLISION-PRONE exclusions (xStock) have
// accrued since the last stamp — leveraged is unambiguous and needs no review.
const REVIEW_STAMP = join(config.dataDir, 'review-exclusions-stamp.json');
export function stampExclusionReview(now = Date.now()) {
  const tmp = REVIEW_STAMP + '.tmp';
  writeFileSync(tmp, JSON.stringify({ at: now }, null, 1));
  renameSync(tmp, REVIEW_STAMP);
}
export function exclusionReviewAt() {
  try { return JSON.parse(readFileSync(REVIEW_STAMP, 'utf8')).at ?? null; } catch { return null; }
}

export function excludedStats(now = Date.now(), deps = {}) {
  const all = deps.rows ?? excludedSummary();
  const by = {};
  for (const e of all) by[e.cls] = (by[e.cls] || 0) + 1;
  const reviewedAt = deps.reviewedAt !== undefined ? deps.reviewedAt : exclusionReviewAt();
  const xstockSinceReview = all.filter((e) => e.cls === 'TOKENIZED_EQUITY'
    && (e.lastSeen || 0) > (reviewedAt || 0)).length;
  const reviewAgeD = reviewedAt ? (now - reviewedAt) / 86400e3 : null;
  // Escalate ONLY when there is something unreviewed to see. No xStock accrual since
  // the stamp = nothing to review = no nag, however old the stamp is.
  const overdue = xstockSinceReview > 0 && (reviewAgeD === null || reviewAgeD >= 14);
  return {
    total: all.length,
    leveraged: by.LEVERAGED_TOKEN || 0,
    equity: by.TOKENIZED_EQUITY || 0,
    seen24h: all.filter((e) => now - (e.lastSeen || 0) < 24 * 3600e3).length,
    xstockSinceReview, reviewAgeD, overdue,
    mark: !overdue ? '' : (reviewAgeD === null || reviewAgeD >= 28) ? '🚨' : '⚠️',
  };
}

export function unclassifiedStats(now = Date.now()) {
  const all = unclassifiedSummary();
  const recurring = all.filter((e) => e.count >= 3);
  const fresh = all.filter((e) => now - e.lastSeen < 24 * 3600e3);
  return { shapes: all.length, recurring: recurring.length, seen24h: fresh.length, top: recurring[0]?.shape ?? null };
}
