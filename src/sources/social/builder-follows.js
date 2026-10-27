// BUILDER FOLLOWS — when a watched account follows a new X account, post it as a FACT (v0.34.0;
// 76 verified accounts with kinds, 3-hourly looks, cursor overflow and bio evidence 2026-10-27).
//
// FIRST PAID DEPENDENCY. Operator-approved 2026-10-21, cap $40/month (builder-follows.json,
// REMAINING-WORK-NOTES.md 2026-10-21). The cap is STRUCTURAL: every call is metered at the
// price in effect before it is made, a call that would cross the cap is not made, and the
// module says so on the heartbeat. Nothing here relies on someone remembering the bill.
//
// Source: twitterapi.io (scrapes X, so expect breakage — degrading to silent IS the design).
//   GET /twitter/user/followings?userName=…&pageSize=20   newest follows first; handle only
//   GET /twitter/user/info?userName=…                      handle -> numeric ID, once
//   GET /twitter/user/batch_info_by_ids?userIds=…          daily ID -> current handle
//   GET /oapi/my/info                                      credit balance (daily reconciliation)
// Followings takes only a HANDLE, while handles change. So accounts are keyed by numeric
// ID; the handle is refreshed from the ID daily; and a saturated page (every ID new — also
// the signature of a handle now pointing at a different account) is checked against the
// ID before anything alerts.
//
// PRICE: metered from the first call at the published price (labelled unverified), and
// reconciled daily against the settled credit balance; a disagreement over 20% DMs the
// operator and the observed price is adopted (data/twitterapi-price.json). Polling never
// waits for a price.
//
// FAILURE: a failed look changes nothing (no diff, no baseline, no "no new follows") and is
// flagged on the heartbeat — feedWasLooking's rule: a zero is evidence only when we looked.
import { readFileSync, writeFileSync, existsSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { dispatch, formatAlert, renderMessage } from '../../core/dispatcher.js';
import { getThread } from '../../core/budget.js';
import { broadcast, editBroadcast } from '../../core/telegram.js';
import { getState, save } from '../../core/store.js';
import { followProblems, FOLLOW_CLAIM, DIRECTION } from '../../core/prose-lint.js';

export const API = 'https://api.twitterapi.io';
export const PAGE_SIZE = 20;           // operator spec: newest page only, 20 per call
export const BASELINE_PAGE_SIZE = 200; // FIRST look per account only: a deeper baseline means a re-follow
                                       // of an older account is already known, not "new" (re-follows: ignore)
export const POLL_EVERY_MS = 3 * 3600e3; // operator spec 2026-10-27: every 3 hours (was hourly)
export const MAX_PAGES = 10;            // operator spec 2026-10-27: overflow follows the cursor, at most 10 pages per account per check
export const CALL_SPACING_MS = 6000;   // twitterapi.io publishes no QPS limit; 20 calls in ~2 min stays clear of one
export const REFRESH_IDS_EVERY_MS = 24 * 3600e3;
export const CONVERGE_WINDOW_MS = 7 * 24 * 3600e3;
export const SEEN_CAP = 3000;          // per account: union of IDs ever seen, newest kept
export const USD_PER_CREDIT = 1 / 100000; // published: 100,000 credits = $1 (recharge bonuses only lower it)
export const WARN_AT = 0.8;

// KIND of each watched account (operator spec 2026-10-27), shown as a fact about the WATCHER.
export const KINDS = ['chain', 'ecosystem', 'exchange', 'project', 'fund', 'founder'];
// Bio evidence is quoted only for these kinds ("a watched chain or project"); the ecosystem
// accounts are the chains' own foundations and builder accounts.
export const MENTION_KINDS = new Set(['chain', 'ecosystem', 'project']);

// PRE-REGISTERED VOLUME (2026-10-27, before the 76-account list went live). Basis: the 20
// accounts made 48 new follows over 23-26 Oct (12/day), 20 of them fresh (42%), 4.75
// alerts/day. Their lifetime follow rate is 8.34/day, the 76 accounts' 26.6/day; live ran
// 1.44x lifetime. 26.6 x 0.42 = 11/day; 26.6 x 1.44 x 0.42 = 16/day.
export const EXPECTED_ALERTS_PER_DAY = Object.freeze({ low: 11, high: 16, registered: '2026-10-27' });
// The rule decided in advance: more than 15 alerts on each of 3 consecutive full UTC days ->
// tighten the fresh-account bar (e.g. age <= 30 days). Never a cap on alerts.
export const VOLUME_REVIEW = Object.freeze({ perDay: 15, days: 3, action: 'tighten the fresh-account bar (e.g. age ≤30 days), never cap alerts' });

// FRESHNESS — what makes a follow news. Declared constants with their basis.
export const FRESH_MAX_AGE_DAYS = 90;
export const FRESH_MAX_AGE_BASIS = 'operator spec 2026-10-21: a builder following a young account is the signal; not yet measured against outcomes';
export const FRESH_MAX_FOLLOWERS = 5000;
export const FRESH_MAX_FOLLOWERS_BASIS = 'operator spec 2026-10-21: under 5,000 followers the follow is plausibly discovery, not a large account; not yet measured against outcomes';

const cfgPath = () => join(process.cwd(), 'builder-follows.json');
const pricePath = () => join(config.dataDir, 'twitterapi-price.json');
const recordPath = () => join(config.dataDir, 'builder-follows.jsonl');

// ---------------------------------------------------------------- config, price (refuse the ambiguous case)
export function checkFollowConfig(c) {
  const problems = [];
  const acc = Array.isArray(c?.accounts) ? c.accounts : null;
  if (!acc || !acc.length) problems.push('no accounts');
  const hs = new Set(), ids = new Set();
  for (const a of acc ?? []) {
    const h = String(a?.handle ?? '').replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) problems.push(`bad handle ${a?.handle}`);
    if (!KINDS.includes(a?.kind)) problems.push(`@${h}: kind '${a?.kind}' is not one of ${KINDS.join('|')}`);
    if (a?.id !== undefined && a?.id !== null && !/^\d{1,20}$/.test(String(a.id))) problems.push(`@${h}: id must be numeric`);
    if (a?.bioNames !== undefined && !(Array.isArray(a.bioNames) && a.bioNames.every((x) => typeof x === 'string' && x.trim()))) problems.push(`@${h}: bioNames must be non-empty strings`);
    if (hs.has(h.toLowerCase())) problems.push(`duplicate handle @${h}`);
    hs.add(h.toLowerCase());
    if (a?.id) { if (ids.has(String(a.id))) problems.push(`duplicate id ${a.id}`); ids.add(String(a.id)); }
  }
  if (!(Number(c?.capUsd) > 0)) problems.push('capUsd missing — a paid source with no cap does not run');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c?.approved ?? ''))) problems.push('approved date missing');
  if (problems.length) return { ok: false, why: problems.join('; ') };
  const accounts = acc.map((a) => ({ handle: String(a.handle).replace(/^@/, ''), kind: a.kind, id: a.id ? String(a.id) : null, name: a.name ?? null, bioNames: a.bioNames ?? [] }));
  return { ok: true, cfg: { ...c, capUsd: Number(c.capUsd), accounts, handles: accounts.map((a) => a.handle) } };
}
export function loadFollowConfig(file = cfgPath()) {
  if (!existsSync(file)) return { ok: false, why: 'builder-follows.json absent' };
  try { return checkFollowConfig(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (e) { return { ok: false, why: `builder-follows.json does not parse (${e.message})` }; }
}
// PRICE (v0.34.3). Metered from the FIRST call at the PUBLISHED price, labelled
// unverified; reconciled daily against the credit balance (see reconcile()); a
// disagreement over 20% DMs the operator and the observed price is adopted. Polling is
// never gated on a measurement: v0.34.0-v0.34.2 refused to poll until one succeeded, and
// every restart before it did restarted a ~30-minute blind window.
// A STORED price is a price only if every metered entry is a finite number > 0. Zero,
// negative, NaN, missing: "no price" (the published one applies), never "free". The
// v0.34.0 file on the VPS (every entry 0) is exactly that case.
export const PRICE_KEYS = ['followings20', 'followings200', 'userInfo', 'batchPerUser'];
export const PUBLISHED_PRICE = Object.freeze({
  source: 'published', measuredAt: '2026-10-21',
  credits: Object.freeze({ followings20: 60, followings200: 200, userInfo: 18, batchPerUser: 18 }),
  basis: 'twitterapi.io pricing and endpoint docs, read 2026-10-21: followings 3 credits each at 20-99 per call (60 for a page of 20) and 1 each at 200; user profiles 18 each under 100. Unverified against the balance until a reconciliation agrees. Supporting, not proof: two 8-call measurements on 2026-10-22 each drew 592 credits in total, the documented sum',
});
export function checkPrice(p) {
  const k = p?.credits;
  if (!k || typeof k !== 'object') return null;
  for (const n of PRICE_KEYS) if (!(typeof k[n] === 'number' && Number.isFinite(k[n]) && k[n] > 0)) return null;
  if (!p.measuredAt || !p.basis) return null;
  return p;
}
export function loadPrice(file = pricePath()) {
  try { return existsSync(file) ? checkPrice(JSON.parse(readFileSync(file, 'utf8'))) : null; } catch { return null; }
}
// The price the meter uses: a valid stored (reconciled) price, else the published one. Never null.
export function priceInEffect(stored) { return checkPrice(stored) ?? PUBLISHED_PRICE; }
function writeJsonAtomic(file, obj) { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(obj, null, 1)); renameSync(tmp, file); }

// ---------------------------------------------------------------- spend meter
export const monthKey = (now) => new Date(now).toISOString().slice(0, 7);
export const dayKey = (now) => new Date(now).toISOString().slice(0, 10);
export function spendOf(f, now) {
  const s = f?.spend;
  if (!s || s.month !== monthKey(now)) return { month: monthKey(now), credits: 0, byDay: {}, warned80: false, capHitAt: null };
  return s;
}
export const usd = (credits) => credits * USD_PER_CREDIT;
export function canSpend(f, credits, capUsd, now) { return usd(spendOf(f, now).credits + credits) <= capUsd + 1e-12; }
function charge(f, credits, now) {
  const s = spendOf(f, now);
  s.credits += credits;
  s.byDay[dayKey(now)] = (s.byDay[dayKey(now)] || 0) + credits;
  f.spend = s;
  f.meterTotal = (f.meterTotal || 0) + credits; // never resets: the reconciliation compares windows of it
  return s;
}
export function callCost(price, kind, n = 1) {
  const k = price.credits;
  if (kind === 'followings') return n >= 200 ? k.followings200 : k.followings20;
  if (kind === 'userInfo') return k.userInfo;
  if (kind === 'batch') return k.batchPerUser * n;
  throw new TypeError(`callCost: unknown kind ${kind}`);
}

// ---------------------------------------------------------------- HTTP edge (the key is never logged)
async function defaultFetchJson(url, key) {
  const res = await fetch(url, { headers: { 'X-API-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body: the status decides */ }
  return { status: res.status, json };
}
export function classifyResponse(r) {
  const msg = String(r?.json?.message ?? r?.json?.msg ?? '').slice(0, 80);
  if (r?.status === 401 || r?.status === 403) return { ok: false, kind: 'key', msg: `HTTP ${r.status} ${msg}`.trim() };
  if (r?.status === 429) return { ok: false, kind: 'rate', msg: 'HTTP 429' };
  if (r?.status !== 200) return { ok: false, kind: 'http', msg: `HTTP ${r?.status} ${msg}`.trim() };
  if (r.json?.status === 'error') return { ok: false, kind: /not found/i.test(msg) ? 'notfound' : 'api', msg };
  return { ok: true };
}

// One metered call. Refused locally (no request at all) when it would cross the cap.
async function meteredCall(ctx, kind, url, n = 1) {
  const credits = callCost(ctx.price, kind, n);
  if (!canSpend(ctx.f, credits, ctx.cfg.capUsd, ctx.now())) {
    const s = spendOf(ctx.f, ctx.now()); s.capHitAt ??= ctx.now(); ctx.f.spend = s;
    return { refused: 'cap' };
  }
  if (ctx.calls++ > 0) await ctx.sleep(CALL_SPACING_MS);
  // Metered when MADE: a failed call is assumed billed — the conservative side of a cap.
  const s = charge(ctx.f, credits, ctx.now());
  ctx.f.lastCallAt = ctx.now(); // the reconciliation's settle clock starts here
  if (!s.warned80 && usd(s.credits) >= WARN_AT * ctx.cfg.capUsd) { s.warned80 = true; ctx.warn.push(s); }
  let r;
  try { r = await ctx.fetchJson(url, ctx.key); } catch (e) { return { ok: false, kind: 'network', msg: String(e.message || e).slice(0, 80) }; }
  const c = classifyResponse(r);
  return c.ok ? { ok: true, json: r.json } : c;
}

// ---------------------------------------------------------------- pure: facts about an account
export function accountFacts(u, now) {
  const created = Date.parse(u?.created_at ?? u?.createdAt ?? '');
  const fc = u?.followers_count ?? u?.followers;
  const bio = String(u?.description ?? u?.profile_bio?.description ?? '').replace(/\s+/g, ' ').trim();
  const website = u?.entities?.url?.urls?.[0]?.expanded_url ?? u?.url ?? null;
  return {
    id: String(u?.id ?? u?.id_str ?? ''),
    handle: String(u?.screen_name ?? u?.userName ?? u?.username ?? ''),
    ageDays: Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 86400e3)) : null,
    followers: fc === null || fc === undefined || fc === '' || !Number.isFinite(Number(fc)) ? null : Number(fc),
    bio, website: website ? String(website) : null,
  };
}
// fresh: true | false | null (age AND followers both unknown: the ambiguous case — recorded, never alerted)
export function freshness(f) {
  if (f.ageDays !== null && f.ageDays <= FRESH_MAX_AGE_DAYS) return { fresh: true, why: `account ≤${FRESH_MAX_AGE_DAYS}d old` };
  if (f.followers !== null && f.followers <= FRESH_MAX_FOLLOWERS) return { fresh: true, why: `≤${FRESH_MAX_FOLLOWERS.toLocaleString('en-US')} followers` };
  if (f.ageDays === null && f.followers === null) return { fresh: null, why: 'age and followers not listed' };
  return { fresh: false, why: 'established account' };
}

// ---------------------------------------------------------------- pure: messages
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (x) => x.toLocaleString('en-US');
export function ageText(d) {
  if (d === 0) return 'less than a day';
  if (d <= FRESH_MAX_AGE_DAYS) return `${d} day${d === 1 ? '' : 's'}`;
  if (d < 730) return `${Math.floor(d / 30.44)} months`;
  return `${Math.floor(d / 365.25)} years`;
}
// BIO EVIDENCE: when the new account's own bio names a watched chain, ecosystem account or
// project, the message QUOTES the words it used ("Bio mentions: Solana"). A quote, not an
// inference: the match is the bio's own text, by @handle (any case) or by a listed name
// (exact case, whole word). Names that are ordinary words (Base, Optimism, Polygon, Sky,
// Phantom, Jupiter, Ink) are listed by @handle only, so "home base" is never "Base".
const escRx = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function buildMentionIndex(accounts) {
  const idx = [];
  for (const a of accounts ?? []) {
    if (!MENTION_KINDS.has(a.kind)) continue;
    idx.push(new RegExp(`(?<![A-Za-z0-9_])@${escRx(a.handle)}(?![A-Za-z0-9_])`, 'gi'));
    for (const n of a.bioNames ?? []) idx.push(new RegExp(`(?<![A-Za-z0-9_@$.])${escRx(n)}(?![A-Za-z0-9_])`, 'g'));
  }
  return idx;
}
export function bioMentions(bio, index) {
  const hits = [];
  for (const rx of index ?? []) { rx.lastIndex = 0; for (const m of String(bio ?? '').matchAll(rx)) hits.push({ a: m.index, b: m.index + m[0].length, t: m[0] }); }
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.a <= h.a && o.b >= h.b && (o.b - o.a) > (h.b - h.a))).sort((x, y) => x.a - y.a);
  const seen = new Set(), out = [];
  for (const h of kept) { const k = h.t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(h.t); } }
  return out;
}
// The bio is the account's own words. If they say "backed by" (or anything the lint bars),
// the bio is WITHHELD rather than quoted, and its mentions with it: nothing in this message
// may read as backing.
export function followMessage(watcher, f, fr = freshness(f), { kind = null, mentionIndex = [] } = {}) {
  const bio = [...f.bio].slice(0, 100).join('');
  const bioHit = f.bio ? (f.bio.match(FOLLOW_CLAIM) || f.bio.match(DIRECTION)) : null;
  const facts = [f.ageDays !== null ? `Account ${ageText(f.ageDays)} old` : 'Account age not listed',
    f.followers !== null ? `${fmt(f.followers)} follower${f.followers === 1 ? '' : 's'}` : 'follower count not listed'].join(' · ');
  const about = [bio && !bioHit ? esc(bio) : null, f.website ? esc(f.website) : null].filter(Boolean).join(' · ');
  const mentions = bioHit ? [] : bioMentions(f.bio, mentionIndex);
  return {
    title: `👀 FOLLOW · @${watcher}${kind ? ` (${kind})` : ''} followed @${f.handle}`,
    lines: [facts, ...(about ? [about] : []), ...(mentions.length ? [`Bio mentions: ${mentions.map(esc).join(', ')}`] : [])],
    operatorLines: [`Fresh because: ${fr.why} · target ID ${f.id} · seen on the ${POLL_EVERY_MS / 3600e3}-hourly look (X does not publish the follow time)`,
      ...(bioHit ? [`Bio withheld, and any bio mentions with it: it contains "${bioHit[0]}"`] : [])],
    url: `https://x.com/${f.handle}`,
  };
}
// Times are DETECTION times (3-hourly looks), so the gap is "seen N h later", not a follow timestamp.
export function convergenceLine(handle, deltaMs, kind = null) {
  const h = Math.floor(deltaMs / 3600e3);
  return `also followed by @${handle}${kind ? ` (${kind})` : ''}, ${h < 1 ? 'seen within the hour' : h < 48 ? `seen ${h}h later` : `seen ${Math.floor(h / 24)}d later`}`;
}

// Append a line to the original alert (dispatch keeps the published text on the thread).
async function editThread(dedupeKey, line) {
  const th = getThread({ dedupeKey, type: 'FOLLOW' });
  if (!config.telegramToken || !th?.messageIds?.length || !th.lastText) return false;
  const updated = `${th.lastText}\n• <i>${esc(line)}</i>`;
  const res = await editBroadcast(th.messageIds, updated);
  if (res.ok) { th.lastText = updated; save(); return true; }
  return false;
}
function defaultRecord(row) { try { appendFileSync(recordPath(), JSON.stringify(row) + '\n'); } catch (e) { console.error('[follows] record failed:', e.message); } }
async function defaultWarn(s, capUsd) {
  const text = formatAlert({ source: 'SYS', type: 'FOLLOWS', severity: 'MEDIUM',
    title: `Builder-follows spend at ${Math.round(100 * usd(s.credits) / capUsd)}% of the $${capUsd} monthly cap`,
    lines: [`Month to date $${usd(s.credits).toFixed(2)} (${s.month}). At 100% the module stops calling until the month rolls.`] });
  await broadcast(text, { toChannel: false }).catch(() => []);
}

// ---------------------------------------------------------------- the cycle, edges injectable
// deps: { cfg, price, key, fetchJson, now, sleep, dispatch, edit, record, warn }
export async function followCycle(state, deps = {}) {
  const f = (state.follows ??= {});
  f.accounts ??= {}; f.byHandle ??= {}; f.alerted ??= {}; f.saturated ??= []; f.incomplete ??= []; f.daily ??= {}; f.unresolved ??= {};
  const nowFn = typeof deps.now === 'function' ? deps.now : () => deps.now ?? Date.now();
  const { cfg, price, key } = deps;
  if (!cfg) return { status: 'off', why: 'no config' };
  if (!key) return { status: 'off', why: 'no TWITTERAPI_KEY' };
  if (!price) return { status: 'off', why: 'price unmeasured' };
  const ctx = { f, cfg, price, key, now: nowFn, fetchJson: deps.fetchJson ?? defaultFetchJson,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), calls: 0, warn: [] };
  const send = deps.dispatch ?? dispatch, edit = deps.edit ?? editThread, record = deps.record ?? defaultRecord;
  const out = { status: 'ok', polled: 0, failed: [], baseline: [], newFollows: 0, sent: 0, edited: 0, recorded: 0, saturated: [], incomplete: [], extraPages: 0, capped: false, calls: 0 };
  const day = () => (f.daily[dayKey(nowFn())] ??= { new: 0, fresh: 0, alerted: 0, edited: 0 });
  const fail = (kind, msg) => { f.lastError = { at: nowFn(), kind, msg }; f.failingSince ??= nowFn(); };
  const finish = async (status) => {
    out.status = status; out.calls = ctx.calls;
    for (const s of ctx.warn) await (deps.warn ?? defaultWarn)(s, cfg.capUsd);
    if (status === 'ok' || status === 'partial') { f.lastOkAt = nowFn(); if (status === 'ok') { f.failingSince = null; f.lastError = null; } }
    for (const k of Object.keys(f.daily)) if (k < dayKey(nowFn() - 7 * 86400e3)) delete f.daily[k];
    f.saturated = f.saturated.filter((x) => nowFn() - x.at < 7 * 86400e3);
    f.incomplete = f.incomplete.filter((x) => nowFn() - x.at < 7 * 86400e3);
    return out;
  };

  // 1. Each watched account by its VERIFIED numeric ID (pinned in builder-follows.json after
  //    checking badge, followers and the official site). An unpinned handle is resolved once.
  for (const ca of cfg.accounts) {
    const h = ca.handle;
    if (ca.id) {
      const prev = f.byHandle[h.toLowerCase()];
      if (prev && prev !== ca.id) console.error(`[OPERATOR][follows] @${h} resolved earlier to ${prev}; config pins the verified ID ${ca.id} — using the pinned ID`);
      f.byHandle[h.toLowerCase()] = ca.id;
      f.accounts[ca.id] ??= { id: ca.id, handle: h, seen: null, baselineAt: null };
      delete f.unresolved[h];
      continue;
    }
    if (f.byHandle[h.toLowerCase()]) continue;
    const r = await meteredCall(ctx, 'userInfo', `${API}/twitter/user/info?userName=${encodeURIComponent(h)}`);
    if (r.refused) { out.capped = true; return finish('capped'); }
    if (!r.ok) {
      if (r.kind === 'notfound' || r.kind === 'api') { f.unresolved[h] = { at: nowFn(), msg: r.msg }; continue; }
      fail(r.kind, r.msg); return finish('failed');
    }
    const d = r.json?.data;
    if (!d?.id || d.unavailable) { f.unresolved[h] = { at: nowFn(), msg: d?.unavailable ? 'account unavailable' : 'no id in response' }; continue; }
    const id = String(d.id);
    f.byHandle[h.toLowerCase()] = id;
    f.accounts[id] ??= { id, handle: d.userName ?? h, seen: null, baselineAt: null };
    delete f.unresolved[h];
  }
  const watched = cfg.accounts.map((ca) => { const a = f.accounts[ca.id ?? f.byHandle[ca.handle.toLowerCase()]]; if (a) a.kind = ca.kind; return a; }).filter(Boolean);
  const mentionIndex = buildMentionIndex(cfg.accounts);

  // 2. ID -> current handle (handles change; IDs do not). Daily, and on a saturated page.
  const refresh = async (accts) => {
    const r = await meteredCall(ctx, 'batch', `${API}/twitter/user/batch_info_by_ids?userIds=${accts.map((a) => a.id).join(',')}`, accts.length);
    if (r.refused) { out.capped = true; return null; }
    if (!r.ok) return r;
    const moved = [];
    for (const u of r.json?.users ?? []) {
      const a = f.accounts[String(u.id)];
      const cur = u.userName ?? u.screen_name;
      if (a && cur && cur.toLowerCase() !== a.handle.toLowerCase()) { moved.push(`@${a.handle} → @${cur}`); a.handle = cur; }
    }
    if (moved.length) console.log(`[follows] handle change(s), by ID: ${moved.join(' · ')}`);
    return { ok: true, moved };
  };
  if (watched.length && nowFn() - (f.idsRefreshedAt ?? 0) >= REFRESH_IDS_EVERY_MS) {
    const r = await refresh(watched);
    if (out.capped) return finish('capped');
    if (r?.ok) f.idsRefreshedAt = nowFn();
    else if (r?.kind === 'key' || r?.kind === 'rate') { fail(r.kind, r.msg); return finish('failed'); }
  }

  // 3. Newest page per watched account; diff by ID against the stored set, never by position.
  for (const a of watched) {
    const baseline = !a.seen;
    const size = baseline ? BASELINE_PAGE_SIZE : PAGE_SIZE;
    const pageUrl = `${API}/twitter/user/followings?userName=${encodeURIComponent(a.handle)}&pageSize=${size}`;
    const r = await meteredCall(ctx, 'followings', pageUrl, size);
    if (r.refused) { out.capped = true; break; }
    if (!r.ok) {
      out.failed.push(`@${a.handle} (${r.kind})`);
      if (r.kind === 'key' || r.kind === 'rate') { fail(r.kind, r.msg); return finish('failed'); }
      if (r.kind === 'notfound') f.idsRefreshedAt = 0; // the handle moved: refresh from the ID next cycle
      continue;
    }
    out.polled++;
    const users = (r.json?.followings ?? []).filter((u) => u && (u.id ?? u.id_str));
    const ids = users.map((u) => String(u.id ?? u.id_str));
    if (baseline) { a.seen = ids.slice(0, SEEN_CAP); a.baselineAt = nowFn(); out.baseline.push(a.handle); continue; }
    const seen = new Set(a.seen);
    const isNew = (u) => !seen.has(String(u.id ?? u.id_str));
    if (!users.some(isNew)) continue;
    // OVERFLOW (operator spec 2026-10-27): a FULL page where every ID is new means more follows
    // than one page since the last look, or a handle that now belongs to another account. The
    // ID decides which before another page is paid for; then the cursor is followed until a
    // known ID appears, the list ends, or MAX_PAGES. Every page is metered. Saturation is
    // flagged only if the cap is hit; a page that failed or a spend cap that stopped the
    // paging is flagged as an INCOMPLETE window instead. Neither is pretended complete.
    // (A short page of all-new IDs is not overflow: @ethereum follows nobody, @Pumpfun 3.)
    let all = users, lastJson = r.json, lastUsers = users, pages = 1;
    const fullAndNew = (us) => us.length >= PAGE_SIZE && us.every(isNew);
    if (fullAndNew(users)) {
      const v = await refresh([a]);
      if (out.capped) break;
      if (!v?.ok) { out.failed.push(`@${a.handle} (overflow unverified)`); continue; } // nothing committed; the next look sees them again
      if (v.moved.length) { a.seen = null; a.baselineAt = null; out.failed.push(`@${a.handle} (handle moved — re-baselining)`); continue; }
      let capHit = false, incomplete = null;
      while (fullAndNew(lastUsers) && lastJson?.has_next_page && lastJson?.next_cursor) {
        if (pages >= MAX_PAGES) { capHit = true; break; }
        const p = await meteredCall(ctx, 'followings', `${pageUrl}&cursor=${encodeURIComponent(lastJson.next_cursor)}`, PAGE_SIZE);
        if (p.refused) { out.capped = true; incomplete = 'spend cap reached mid-window'; break; }
        if (!p.ok) { incomplete = `page ${pages + 1} failed (${p.kind})`; break; }
        lastJson = p.json; lastUsers = (p.json?.followings ?? []).filter((u) => u && (u.id ?? u.id_str));
        all = all.concat(lastUsers); pages++;
      }
      out.extraPages += pages - 1;
      if (capHit) {
        f.saturated.push({ at: nowFn(), handle: a.handle, n: all.length, pages });
        out.saturated.push(a.handle);
        console.error(`[OPERATOR][follows] @${a.handle}: ${pages} pages (${all.length} follows) all new — the ${MAX_PAGES}-page cap was hit; follows beyond it may have been missed`);
      } else if (incomplete) {
        f.incomplete.push({ at: nowFn(), handle: a.handle, n: all.length, pages, why: incomplete });
        out.incomplete.push(a.handle);
        console.error(`[OPERATOR][follows] @${a.handle}: overflow paging stopped after ${pages} page(s): ${incomplete} — this window is incomplete`);
      }
    }
    // De-duplicate across pages (a follow arriving mid-paging shifts the list by one).
    const byId = new Map();
    for (const u of all) { const id = String(u.id ?? u.id_str); if (!byId.has(id)) byId.set(id, u); }
    const allIds = [...byId.keys()];
    const fresh = [...byId.values()].filter(isNew);
    const unsent = new Set();
    for (const u of fresh) {
      const t = accountFacts(u, nowFn());
      const fr = freshness(t);
      out.newFollows++; day().new++;
      const row = { at: new Date(nowFn()).toISOString(), watcherId: a.id, watcher: a.handle, watcherKind: a.kind ?? null, targetId: t.id, target: t.handle,
        ageDays: t.ageDays, followers: t.followers, fresh: fr.fresh, why: fr.why, action: 'recorded' };
      if (fr.fresh) {
        day().fresh++;
        const prior = f.alerted[t.id];
        if (prior) {
          // CONVERGENCE: a second watched account, within 7 days, EDITS the original. Never a second alert.
          const delta = nowFn() - prior.at;
          if (prior.by !== a.id && !(prior.also ?? []).some((x) => x.by === a.id) && delta <= CONVERGE_WINDOW_MS) {
            const ok = await edit(prior.dedupeKey, convergenceLine(a.handle, delta, a.kind));
            (prior.also ??= []).push({ by: a.id, handle: a.handle, at: nowFn(), edited: !!ok });
            if (ok) { out.edited++; day().edited++; }
            row.action = ok ? 'edited-original' : 'convergence-logged (no message to edit)';
          } else row.action = 'repeat (already alerted)';
        } else {
          const msg = followMessage(a.handle, t, fr, { kind: a.kind, mentionIndex });
          const problems = followProblems(renderMessage(msg, 'public').text);
          if (problems.length) {
            console.error(`[OPERATOR][follows] refused to send @${a.handle} → @${t.handle}: ${problems.join('; ')}`);
            row.action = `refused (${problems.join('; ')})`;
          } else {
            const dedupeKey = `FOLLOW:${t.id}`;
            const sent = await send({ source: 'SOCIAL', type: 'FOLLOW', severity: 'MEDIUM', kind: 'FACT', key: `follow:${t.id}`, dedupeKey,
              cooldownMin: 7 * 24 * 60, linkLabel: 'profile', ...msg });
            if (sent) { f.alerted[t.id] = { by: a.id, byHandle: a.handle, handle: t.handle, at: nowFn(), dedupeKey, also: [] }; out.sent++; day().alerted++; row.action = 'alerted'; row.mentions = bioMentions(t.bio, mentionIndex); }
            else { unsent.add(t.id); row.action = 'send failed (retried on the next look)'; }
          }
        }
      }
      record(row); out.recorded++;
    }
    // Commit the union of IDs seen, newest first — except a fresh follow whose send failed,
    // which stays "new" so the next look retries it while it is still on the page.
    a.seen = [...allIds.filter((id) => !unsent.has(id)), ...a.seen.filter((id) => !byId.has(id))].slice(0, SEEN_CAP);
  }
  for (const [id, x] of Object.entries(f.alerted)) if (nowFn() - x.at > 180 * 86400e3) delete f.alerted[id];
  if (out.capped) return finish('capped');
  if (watched.length && out.polled === 0) { fail('all-failed', out.failed.join(', ') || 'no account polled'); return finish('failed'); }
  return finish(out.failed.length ? 'partial' : 'ok');
}

// ---------------------------------------------------------------- daily reconciliation (settled balance)
// THE BALANCE IS EVERY POOL. /oapi/my/info answers {"recharge_credits":1000000,
// "total_bonus_credits":119408} (2026-10-22): calls draw on the BONUS pool first, so
// recharge_credits alone never moves. The balance is the sum of every *credits field.
// AND IT POSTS LATE: a balance watch showed 592 credits of calls land 30-90 s after the
// last call, in pieces (574, then 18). So a balance is read only once SETTLED: reads
// every 60 s until two consecutive reads agree, at least 3 min after the last metered
// call. Reconciliation runs at the start of a cycle, ~1 h after the last call, so it
// settles in about a minute, once a day. A balance read costs 0 credits (consecutive
// reads agreed for minutes on 2026-10-22) and is not metered.
//
// Per window (anchor -> now): drop = balance fall, metered = what the meter charged.
//   drop < 0           recharged or bonus added: the window is unreadable, re-anchor
//   metered < 5,000    too little traffic to judge a 20% band, keep the anchor
//   drop > 3x metered  ANOMALOUS (bonus expiry, another user of the key): DM, NOT adopted
//   |drop/metered - 1| > 20%  DM + ADOPT: every price scaled by drop/metered
//   otherwise          agree: the published price is now "reconciled"
// In every readable case the meter is corrected UP by drop - metered when positive: the
// month's figure never reads less than the balance says was spent.
export const RECONCILE_EVERY_MS = 24 * 3600e3;
export const RECONCILE_TOLERANCE = 0.2;
export const RECONCILE_MIN_CREDITS = 5000;
export const RECONCILE_ANOMALY_RATIO = 3;
export function balanceOf(j) {
  const pools = Object.entries(j ?? {}).filter(([k, v]) => /credits$/i.test(k) && typeof v === 'number' && Number.isFinite(v));
  return pools.length ? { total: pools.reduce((s, [, v]) => s + v, 0), pools: pools.map(([k]) => k).sort() } : null;
}
// Reads until two consecutive readings agree and minSettle has passed since `since` (the last call).
export async function settledBalance(deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson, key = deps.key;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = deps.clock ?? (() => Date.now());
  const since = deps.since ?? 0, every = deps.settleEveryMs ?? 60e3, minSettle = deps.minSettleMs ?? 180e3, maxSettle = deps.maxSettleMs ?? 10 * 60e3;
  const start = clock();
  const read = async () => {
    const r = await fetchJson(`${API}/oapi/my/info`, key); const c = classifyResponse(r);
    if (!c.ok) throw new Error(`balance read failed: ${c.kind} ${c.msg}`);
    const b = balanceOf(r.json);
    if (!b) throw new Error('balance read returned no credit fields');
    return b;
  };
  let prev = await read();
  for (;;) {
    await sleep(every);
    const cur = await read();
    if (cur.total === prev.total && clock() - since >= minSettle) return cur;
    if (clock() - start > maxSettle) throw new Error(`the balance did not settle within ${Math.round(maxSettle / 60e3)} min`);
    prev = cur;
  }
}
// Pure: what a reconciliation window says.
export function reconcileDecision(anchor, balanceNow, meterTotal, price) {
  if (!anchor) return { kind: 'anchor' };
  const drop = anchor.balance - balanceNow, metered = meterTotal - anchor.metered;
  if (drop < 0) return { kind: 'recharged', drop, metered };
  if (metered < RECONCILE_MIN_CREDITS) return { kind: 'too-small', drop, metered };
  const ratio = drop / metered, correction = Math.max(0, drop - metered);
  if (ratio > RECONCILE_ANOMALY_RATIO) return { kind: 'anomalous', drop, metered, ratio, correction };
  if (Math.abs(ratio - 1) > RECONCILE_TOLERANCE) {
    const credits = Object.fromEntries(PRICE_KEYS.map((n) => [n, Math.max(1, Math.round(price.credits[n] * ratio))]));
    return { kind: 'adopt', drop, metered, ratio, correction, credits };
  }
  return { kind: 'agree', drop, metered, ratio, correction };
}
async function defaultDm(title, lines) {
  await broadcast(formatAlert({ source: 'SYS', type: 'FOLLOWS', severity: 'MEDIUM', title, lines }), { toChannel: false }).catch(() => []);
}
// deps: { key, price, now, fetchJson, sleep, clock, dm(title, lines), writePrice(p), settle opts }
export async function reconcile(state, deps = {}) {
  const f = (state.follows ??= {});
  f.recon ??= {};
  const now = deps.now ?? Date.now();
  let b;
  try { b = await settledBalance({ ...deps, since: f.lastCallAt ?? 0 }); }
  catch (e) { f.recon.lastError = { at: now, msg: String(e.message).slice(0, 120) }; return { status: 'unsettled', msg: e.message }; }
  const total = f.meterTotal || 0;
  const d = reconcileDecision(f.recon.anchor, b.total, total, deps.price);
  const dm = deps.dm ?? defaultDm, writePrice = deps.writePrice ?? ((p) => writeJsonAtomic(pricePath(), p));
  const window = f.recon.anchor ? `${new Date(f.recon.anchor.at).toISOString().slice(0, 16)}Z..${new Date(now).toISOString().slice(0, 16)}Z` : null;
  let adopted = null;
  if (d.correction > 0) charge(f, d.correction, now); // the meter never reads less than the balance says was spent
  if (d.kind === 'adopt') {
    adopted = { source: 'reconciled', measuredAt: new Date(now).toISOString(), credits: d.credits, factor: Number(d.ratio.toFixed(3)), window,
      basis: `daily reconciliation ${window}: balance (${b.pools.join(' + ')}) fell ${d.drop} credits while the meter charged ${d.metered} at the ${deps.price.source} price; every price scaled by ${d.ratio.toFixed(3)}` };
    writePrice(adopted);
    await dm(`Builder-follows price ADOPTED from the balance: ×${d.ratio.toFixed(2)}`,
      [`Window ${window}: balance fell ${d.drop.toLocaleString('en-US')} credits, meter charged ${d.metered.toLocaleString('en-US')} at the ${deps.price.source} price (${Math.round(100 * (d.ratio - 1))}%).`,
        `Now metering ${JSON.stringify(d.credits)} credits per call; month-to-date corrected up by ${d.correction.toLocaleString('en-US')} credits.`]);
  } else if (d.kind === 'anomalous') {
    await dm(`Builder-follows reconciliation ANOMALOUS: balance fell ${d.ratio.toFixed(1)}× what was metered`,
      [`Window ${window}: ${d.drop.toLocaleString('en-US')} credits gone vs ${d.metered.toLocaleString('en-US')} metered. Bonus-credit expiry or another user of the key would do this; the price is NOT adopted. The meter was corrected up by ${d.correction.toLocaleString('en-US')} credits.`]);
  }
  if (d.kind === 'agree') f.recon.agreedAt = now;
  if (d.kind !== 'too-small') f.recon.anchor = { at: now, balance: b.total, metered: f.meterTotal || 0 };
  f.recon.last = { at: now, kind: d.kind, drop: d.drop ?? null, metered: d.metered ?? null, ratio: d.ratio === undefined ? null : Number(d.ratio.toFixed(3)), correction: d.correction ?? 0, window };
  f.recon.lastError = null;
  return { status: d.kind, decision: d, price: adopted };
}

// ---------------------------------------------------------------- heartbeat line, pure when deps are injected
export function followStatus(state, now = Date.now(), deps = {}) {
  const c = deps.cfgResult ?? loadFollowConfig();
  if (!c.ok) return { line: `Builder follows: OFF (${c.why})` };
  const key = deps.key ?? config.twitterapiKey;
  if (!key) return { line: 'Builder follows: OFF (no TWITTERAPI_KEY in .env)' };
  const f = state.follows ?? {};
  const price = priceInEffect(deps.price === undefined ? loadPrice() : deps.price);
  const rl = f.recon?.last;
  const priceLabel = price.source === 'reconciled' ? `adopted from the balance ${String(price.measuredAt).slice(0, 10)}, ×${price.factor}`
    : f.recon?.agreedAt && rl?.ratio !== null && rl?.ratio !== undefined ? `published, reconciled ${rl.ratio >= 1 ? '+' : ''}${Math.round(100 * (rl.ratio - 1))}% on ${dayKey(f.recon.agreedAt)}`
    : 'published, unverified';
  const s = spendOf(f, now), cap = c.cfg.capUsd;
  const today = s.byDay[dayKey(now)] || 0, yday = s.byDay[dayKey(now - 86400e3)] || 0;
  const resolved = c.cfg.accounts.filter((x) => f.byHandle?.[x.handle.toLowerCase()]).length;
  const age = f.lastOkAt ? Math.round((now - f.lastOkAt) / 60e3) : null;
  const looking = age !== null && age <= POLL_EVERY_MS / 60e3 + 20 && !f.failingSince;
  const d = f.daily?.[dayKey(now)] ?? { new: 0, fresh: 0, alerted: 0, edited: 0 };
  const sat = (f.saturated ?? []).filter((x) => now - x.at < 24 * 3600e3);
  const next = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const parts = [`Builder follows: ${resolved}/${c.cfg.accounts.length} watched every ${POLL_EVERY_MS / 3600e3}h`,
    `last good look ${age === null ? 'never' : age < 120 ? `${age}m` : `${(age / 60).toFixed(1)}h`} ago`,
    looking ? `today ${d.new} new · ${d.fresh} fresh · ${d.alerted} alerted · ${d.edited} edits` : 'today: not looking — a zero here is not "no new follows"',
    `spend today $${usd(today).toFixed(2)} · yesterday $${usd(yday).toFixed(2)} · month $${usd(s.credits).toFixed(2)} of $${cap}`,
    `price ${price.credits.followings20} credits/call (${priceLabel})`];
  const flags = [];
  if (!canSpend(f, price.credits.followings20, cap, now)) flags.push(`⛔ CAP REACHED — no calls until ${next}`);
  if (f.failingSince) flags.push(`🚨 source failing since ${new Date(f.failingSince).toISOString().slice(0, 16)}Z (${f.lastError?.kind}: ${f.lastError?.msg}) — silent by design`);
  if (sat.length) flags.push(`⚠️ ${sat.length} saturated window(s) 24h, ${MAX_PAGES}-page cap hit: ${[...new Set(sat.map((x) => '@' + x.handle))].join(', ')} — follows beyond ${MAX_PAGES * PAGE_SIZE} may have been missed`);
  const inc = (f.incomplete ?? []).filter((x) => now - x.at < 24 * 3600e3);
  if (inc.length) flags.push(`⚠️ ${inc.length} incomplete window(s) 24h: ${inc.map((x) => `@${x.handle} (${x.why})`).join(', ')}`);
  const vr = volumeReview(f.daily, now);
  if (vr.tripped) flags.push(`⚠️ alerts over ${VOLUME_REVIEW.perDay}/day for ${VOLUME_REVIEW.days} days (${vr.days.map((x) => `${x.day.slice(5)} ${x.alerted}`).join(', ')}) — pre-registered rule: ${VOLUME_REVIEW.action}`);
  if (f.recon?.lastError && now - f.recon.lastError.at < 2 * 86400e3) flags.push(`⚠️ reconciliation unsettled (${f.recon.lastError.msg})`);
  if (rl?.kind === 'anomalous' && now - rl.at < 7 * 86400e3) flags.push(`⚠️ reconciliation anomalous ${dayKey(rl.at)}: balance fell ${rl.ratio}× the meter (not adopted)`);
  const un = Object.keys(f.unresolved ?? {});
  if (un.length) flags.push(`⚠️ unresolved: ${un.map((h) => '@' + h).join(', ')}`);
  return { line: [...parts, ...flags].join(' · ') };
}

// Pure: the pre-registered review. The last VOLUME_REVIEW.days FULL UTC days (today excluded)
// each over VOLUME_REVIEW.perDay alerts. A day with no record counts as not over.
export function volumeReview(daily, now = Date.now()) {
  const days = [];
  for (let i = 1; i <= VOLUME_REVIEW.days; i++) { const day = dayKey(now - i * 86400e3); days.push({ day, alerted: daily?.[day]?.alerted ?? 0 }); }
  days.reverse();
  return { tripped: days.every((x) => x.alerted > VOLUME_REVIEW.perDay), days };
}

// ---------------------------------------------------------------- the poller (own timer: a 2-minute cycle must not stall the 60 s loop)
let timer = null, running = false;
export async function pollFollows() {
  const st = getState(); const f = (st.follows ??= {});
  const c = loadFollowConfig();
  if (!c.ok || !config.twitterapiKey) return;
  if (Date.now() - (f.lastCycleAt ?? 0) < POLL_EVERY_MS) return; // persisted: a restart does not re-poll (and re-pay) early
  delete f.priceProblem; // v0.34.0-v0.34.2 state: there is no measurement gate any more
  f.lastCycleAt = Date.now();
  let price = priceInEffect(loadPrice());
  // Daily reconciliation BEFORE the cycle, never gating it: with no traffic metered yet there
  // is nothing to anchor, so the first cycle after a deploy polls at once and the anchor is
  // taken an hour later, when the balance has long settled (~1 minute of reads).
  if (f.meterTotal > 0 && (!f.recon?.anchor || Date.now() - f.recon.anchor.at >= RECONCILE_EVERY_MS)) {
    const rr = await reconcile(st, { key: config.twitterapiKey, price });
    save();
    const d = rr.decision;
    console.log(`[follows] reconciliation: ${rr.status}${d?.drop !== undefined ? ` · balance fell ${d.drop} · metered ${d.metered}${d.ratio !== undefined ? ` · ratio ${d.ratio.toFixed(3)}` : ''}${d.correction ? ` · meter corrected +${d.correction}` : ''}` : ''}${rr.msg ? ` · ${rr.msg}` : ''}`);
    if (rr.price) price = rr.price;
  }
  const r = await followCycle(st, { cfg: c.cfg, price, key: config.twitterapiKey });
  save();
  console.log(`[follows] ${r.status}: ${r.polled} polled · ${r.baseline.length ? `baseline ${r.baseline.length} · ` : ''}${r.newFollows} new · ${r.sent} alert(s) · ${r.edited} edit(s) · ${r.calls} call(s) · price ${price.source}${r.failed.length ? ` · failed ${r.failed.join(', ')}` : ''}${r.saturated.length ? ` · SATURATED ${r.saturated.join(', ')}` : ''}`);
}
export function startBuilderFollows(checkEveryMs = 5 * 60e3) {
  if (timer) return timer;
  const tick = () => { if (running) return; running = true; pollFollows().catch((e) => console.error('[follows] cycle failed:', e.message)).finally(() => { running = false; }); };
  tick();
  timer = setInterval(tick, checkEveryMs); timer.unref?.();
  const c = loadFollowConfig();
  console.log(`[follows] ${!c.ok ? `OFF (${c.why})` : !config.twitterapiKey ? 'OFF (no TWITTERAPI_KEY)' : `watching ${c.cfg.handles.length} accounts hourly · cap $${c.cfg.capUsd}/month`}`);
  return timer;
}
