// EXCHANGE ANNOUNCEMENT MONITOR — free, no keys.
// Announcements are published BEFORE trading opens, so this gives lead time the
// ticker-diff listing detector can't: you hear "Binance Will List X" at the
// announcement, not when the pair goes live.
// Also catches TGE / airdrop / unlock wording that the paid calendars charge for.
import { dispatch } from '../../core/dispatcher.js';
import { loadDerivStockSymbols } from './exchanges.js';
import { classifyAnnouncementText, setNovelTokenFn } from '../../core/taxonomy.js';
import { novelTokens, notePending, pendingUrgency } from '../../core/vocab.js';
import { noteUnclassified } from '../../core/unclassified.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from '../../config.js';
import { getState, save } from '../../core/store.js';

setNovelTokenFn(novelTokens); // wire the persisted vocabulary into the classifier

const POLL_EVERY = 10 * 60e3;
let lastPoll = 0;
const seen = new Map(); // exchange -> Set of article ids (baseline on first poll)

async function jsonSafe(url, opts) {
  try {
    const res = await fetch(url, { headers: { 'accept': 'application/json' }, ...opts });
    if (!res.ok) return null;
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  } catch { return null; }
}

const FEEDS = {
  binance: async () => {
    const j = await jsonSafe('https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=48&pageNo=1&pageSize=20');
    const arts = (j?.data?.catalogs || []).flatMap((c) => c.articles || []);
    return arts.map((a) => ({ id: String(a.id ?? a.code ?? a.title), title: a.title || '', ts: a.releaseDate || Date.now(),
      url: `https://www.binance.com/en/support/announcement/${a.code || ''}` }));
  },
  okx: async () => {
    const j = await jsonSafe('https://www.okx.com/api/v5/support/announcements?page=1');
    const arr = (j?.data?.[0]?.details) || j?.data || [];
    return arr.map((a) => ({ id: String(a.url || a.title), title: a.title || '', ts: Number(a.pTime) || Date.now(), url: a.url || 'https://www.okx.com/help/section/announcements-new-listings' }));
  },
  bitget: async () => {
    const j = await jsonSafe('https://api.bitget.com/api/v2/public/annoucements?language=en_US&annType=coin_listings');
    return (j?.data || []).map((a) => ({ id: String(a.annId ?? a.annTitle), title: a.annTitle || '', ts: Number(a.cTime) || Date.now(), url: a.annUrl || 'https://www.bitget.com/support/sections/5955813039257' }));
  },
  bybit: async () => {
    const j = await jsonSafe('https://api.bybit.com/v5/announcements/index?locale=en-US&type=new_crypto&limit=20');
    return (j?.result?.list || []).map((a) => ({ id: String(a.url || a.title), title: a.title || '', ts: Number(a.dateTimestamp) || Date.now(), url: a.url || 'https://announcements.bybit.com/' }));
  },
  // KOREAN VENUES — added v0.23.2. The suspension and scheduled-delisting detectors
  // were built for events that ONLY appear here: POKT/ALLO suspensions were Bithumb,
  // the STORJ/TT/JASMY delistings were Upbit AND Bithumb. Without these feeds both
  // detectors were starved of the exact input that justified them. These are also the
  // two venues whose delistings genuinely reprice an asset.
  upbit: async () => {
    const j = await jsonSafe('https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=all');
    return (j?.data?.notices || []).map((a) => ({ id: 'upbit:' + (a.id ?? a.title), title: a.title || '',
      ts: Date.parse(a.listed_at || a.first_listed_at) || Date.now(),
      url: `https://upbit.com/service_center/notice?id=${a.id ?? ''}` }));
  },
  bithumb: async () => {
    const j = await jsonSafe('https://api.bithumb.com/v1/notices?count=20');
    return (Array.isArray(j) ? j : []).map((a) => ({ id: 'bithumb:' + (a.pc_url || a.title), title: a.title || '',
      ts: Date.parse(String(a.published_at || '').replace(' ', 'T') + '+09:00') || Date.now(),
      url: a.pc_url || 'https://feed.bithumb.com/notice' }));
  },
  kucoin: async () => {
    const j = await jsonSafe('https://api.kucoin.com/api/v3/announcements?currentPage=1&pageSize=20');
    return (j?.data?.items || []).map((a) => ({ id: 'kucoin:' + (a.annId ?? a.annTitle), title: a.annTitle || '',
      ts: Number(a.cTime) || Date.now(), url: a.annUrl || 'https://www.kucoin.com/announcement' }));
  },
};

// Spot listings / TGE / unlock / perp listings matter. Ongoing derivatives plumbing
// (expiry, settlement, options, structured products) and tokenized equities do not.
//
// A new PERP listing is a genuine signal and used to be discarded: opening leverage and
// a short side on a token reliably precedes volatility. The old filter killed anything
// containing "perpetual", which silently dropped 20/20 of Bybit's feed. Equity
// detection lives in core/taxonomy.js (isEquityText) — ONE classifier, shared with the
// symbol-level taxonomy, after the 14 Aug 'TradFi' drift showed two hand-synced
// copies is one too many.

// PROMOTIONAL / OPERATIONAL NOISE (v0.23.0). Venue marketing and housekeeping — the
// bulk of what makes an unfiltered announcement channel unreadable. Suppressed
// ENTIRELY: no push, no digest, no operator line, and deliberately checked BEFORE the
// novelty classifier so a tournament with a new brand name doesn't generate review
// noise either.
const PROMO_RX = /competition|tournament|prize pool|prize|giveaway|lucky draw|carnival|festival|campaign|referral|invite friends|rewards? (?:program|hub)|share (?:a )?(?:pool of )?\d|win up to|exclusive:|airdrop event|trading challenge|\bama\b|earn (?:up to )?\d+%|staking (?:promo|reward)|hold .* and share|new users?|deposit bonus|welcome bonus/i;
const OPERATIONAL_RX = /tick size|contract (?:parameter|specification|adjust)|margin tier|leverage (?:tier|adjust)|funding (?:rate )?(?:interval|cap|frequency) (?:adjust|update)|system (?:maintenance|upgrade)|wallet maintenance|scheduled maintenance|api (?:update|upgrade|deprecat)|risk limit|position limit adjust|settlement (?:time|schedule) (?:change|adjust)/i;
export function isNoise(title) {
  const s = String(title || '');
  if (PROMO_RX.test(s)) return 'promo';
  if (OPERATIONAL_RX.test(s)) return 'operational';
  return null;
}

// SUSPENSION (3a) — deposits/withdrawals halted. Frequently precedes delistings,
// chain halts and incidents. TWO KINDS, and the distinction is the whole signal:
// ROUTINE carries a stated resumption time or a named chain upgrade; OPEN states
// neither, which is when it matters.
// STEMS, and BOTH word orders. First cut used the literal "suspend", which does not
// appear inside "suspension" (suspen-D vs suspen-SION), so every real Bithumb/Upbit
// notice — all of which say "Suspension" — failed to match. Stem on "suspen" and allow
// the action either before or after the asset word.
const SUSPEND_RX = /(?:suspen|halt|paus|disabl)[a-z]*[^.]{0,40}(?:deposit|withdrawal)|(?:deposit|withdrawal)[a-z]*[^.]{0,40}(?:suspen|halt|paus|disabl)/i;
// KOREAN. Upbit and Bithumb publish in Korean, so English-only patterns would have
// read their feeds as pure noise — adding the venues without these buys nothing.
//   입출금 deposit+withdrawal · 입금 deposit · 출금 withdrawal
//   중지/중단/일시 정지 suspension/halt · 재개 resume · 점검 maintenance
//   거래지원 종료 / 상장폐지 end of trading support / delisting
//   네트워크 업그레이드 network upgrade · 메인넷 스왑 mainnet swap
const KO_SUSPEND_RX = /(입출금|입금|출금)[^.]{0,20}(중지|중단|정지|일시\s*중단)|(중지|중단|정지)[^.]{0,20}(입출금|입금|출금)/;
const KO_DELIST_RX = /거래지원\s*종료|상장\s*폐지|거래\s*종료/;
const KO_RESUME_RX = /재개|정상화|완료\s*후|이후\s*재개/;
const KO_UPGRADE_RX = /네트워크\s*업그레이드|메인넷\s*스왑|하드\s*포크|토큰\s*스왑|마이그레이션|점검/;
const KO_DEPOSIT_ONLY = /입금/, KO_WITHDRAW_ONLY = /출금/;
const RESUME_RX = /resum\w+|will reopen|restor\w+|re-?enable|expected to (?:resume|complete)|after (?:the )?(?:upgrade|maintenance|migration)|estimated completion/i;
const UPGRADE_RX = /(?:network|chain|mainnet|hard ?fork|token) (?:upgrade|swap|migration|fork)/i;

// SCHEDULED DELISTING (3b) — a dated forward event, not a one-shot. Treated like an
// unlock: announce now, remind at T-7d and T-1d.
const DELIST_RX = /delist|will (?:be )?remov|removal of|terminat\w+ (?:of )?(?:trading|support)|end (?:of )?(?:trading )?support|cease trading/i;
// "effective 14/09 15:00 KST" / "on 2026-09-14" / "September 14, 2026"
const DATE_RX = /(\d{4}-\d{2}-\d{2})|(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)|((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?)/i;
// "there is a date in this notice and we failed to read it" vs "no date exists".
const SCHEDULING_RX = /effective|as of|starting|from\s+\d|on\s+\d|scheduled|will (?:be )?(?:end|cease|stop)|기준|부터|예정|일자/i;

// Asset ticker from a notice title. Korean venues put it in parentheses:
// "포켓네트워크(POKT) 입출금..." -> POKT. English feeds give a bare ticker or a pair.
const QUOTE_WORDS = new Set(['KRW', 'BTC', 'USDT', 'USDC', 'USD', 'ETH']);
// Does a routine suspension carry information? Pure-ish (reads state + unlocks file),
// returns the REASONS so the message can state why it was worth sending.
const SUSPEND_MEMORY_MS = 12 * 3600e3;
export function suspensionInterest(asset, exch, deps = {}) {
  if (!asset) return [];
  const now = deps.now ?? Date.now();
  const st = deps.st ?? getState();
  const reasons = [];
  // CROSS-VENUE: same asset halted on another venue recently.
  st.suspensions ??= {};
  const rec = (st.suspensions[asset] ??= { venues: [], at: now });
  if (now - rec.at > SUSPEND_MEMORY_MS) { rec.venues = []; rec.at = now; }
  if (!rec.venues.includes(exch)) rec.venues.push(exch);
  rec.at = now;
  if (rec.venues.length >= 2) reasons.push(`halted on ${rec.venues.length} venues (${rec.venues.join(', ')}) within 12h`);
  // PENDING DELISTING for this asset.
  if ((st.pendingDelists ?? {})[asset]) reasons.push('asset already has a scheduled delisting');
  // UNLOCK OVERLAP: a verified unlock inside the next 7 days.
  const unlocks = deps.unlocks ?? loadUnlockEvents();
  const soon = unlocks.filter((e) => e.token === asset && e.ts >= now && e.ts - now < 7 * 86400e3);
  if (soon.length) reasons.push('a verified unlock falls within 7 days — supply cannot move during the halt');
  return reasons;
}
let unlockCache = { at: 0, events: [] };
export function loadUnlockEvents(path = null) {
  if (!path && Date.now() - unlockCache.at < 3600e3) return unlockCache.events;
  try {
    // TWO BUGS FIXED 21 Aug, found the day the first real events[] shipped:
    // (1) the file lives at REPO ROOT, not dataDir — this read ENOENT'd silently and
    //     the unlock-overlap condition was structurally empty since it shipped;
    // (2) j.tokens is an ARRAY, so Object.entries keys were '0','1',... and a symbol
    //     lookup could never match. An untested integration point is an untested
    //     premise — the suspension fixtures injected `unlocks` and never exercised
    //     this loader (hermetic tests cut both ways).
    const j = JSON.parse(readFileSync(path ?? join(ROOT, 'unlocks.json'), 'utf8'));
    const list = Array.isArray(j.tokens) ? j.tokens : Object.entries(j.tokens ?? j).map(([k, v]) => ({ sym: v?.sym ?? k, ...v }));
    const events = [];
    for (const t of list) {
      if (t?.retired) continue; // retired is a positive state; boot asserts it stays clean
      for (const e of (t?.events ?? [])) {
        const ts = Date.parse(e.date);
        if (Number.isFinite(ts)) events.push({ token: t.sym, ts });
      }
    }
    if (path) return events; // fixture path: no cache pollution
    unlockCache = { at: Date.now(), events };
  } catch { if (path) return []; unlockCache = { at: Date.now(), events: [] }; }
  return unlockCache.events;
}

export function assetOf(title) {
  for (const [, inner] of String(title || '').matchAll(/\(([^)]+)\)/g)) {
    for (const part of inner.split(/[,/]/).map((s) => s.trim())) {
      if (/^(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,15}$/.test(part) && !QUOTE_WORDS.has(part)) return part;
    }
  }
  const m = String(title || '').match(/\b([A-Z0-9]{2,15})(?:\/|-)?USDT\b/);
  return m ? m[1] : null;
}

export function classify(title) {
  const t = (title || '').toLowerCase();
  // Noise first: cheapest check, and it must precede novelty so a rebranded promo
  // does not land in the review queue.
  const noise = isNoise(title);
  if (noise) return { type: 'NOISE', noise };
  // Equities first — they arrive dressed as perp listings, so this must precede both
  // the perp branch and the derivatives drop. UNRECOGNISED (novel product-line
  // vocabulary) is handled by the caller, which routes it to digest and tells the
  // operator; here it is simply not pushable.
  const eq = classifyAnnouncementText(title);
  if (eq.cls === 'EQUITY') return null;

  const kind = (() => {
    // SUSPENSION before delist: "suspend withdrawals" would match the delist pattern.
    if (SUSPEND_RX.test(title) || KO_SUSPEND_RX.test(title)) {
      const ko = KO_SUSPEND_RX.test(title);
      const routine = ko ? (KO_RESUME_RX.test(title) || KO_UPGRADE_RX.test(title))
                         : (RESUME_RX.test(title) || UPGRADE_RX.test(title));
      const both = ko ? /입출금/.test(title) || (KO_DEPOSIT_ONLY.test(title) && KO_WITHDRAW_ONLY.test(title))
                      : /deposit/i.test(title) && /withdrawal/i.test(title);
      const which = both ? 'deposits and withdrawals'
        : ko ? (KO_WITHDRAW_ONLY.test(title) ? 'withdrawals' : 'deposits')
        : (/withdrawal/i.test(title) ? 'withdrawals' : 'deposits');
      return { type: 'SUSPENSION', sev: routine ? 'MEDIUM' : 'HIGH', routine, both, which, ko };
    }
    // SCHEDULED delist (dated, forward) before the immediate delist path.
    //
    // PARTIAL PARSE FAILURE gets its OWN state. The null log only catches titles that
    // match NOTHING; it would never see a delisting that matches the pattern but whose
    // DATE extraction fails. Both possible degradations are bad — a dateless delisting
    // alert asserts less than it appears to, and a silent drop loses a real event. So:
    // detected event + failed field parse = OPERATOR line, never a degraded alert.
    // Three-state discipline applied one level down, to fields rather than classes.
    if (KO_DELIST_RX.test(title) || DELIST_RX.test(title)) {
      const ko = KO_DELIST_RX.test(title);
      const m = title.match(DATE_RX) || title.match(/(\d{4}년\s*\d{1,2}월\s*\d{1,2}일)|(\d{1,2}월\s*\d{1,2}일)/);
      if (m) return { type: 'DELIST_SCHEDULED', sev: 'HIGH', delist: true, dateText: m[0], ko };
      // Scheduling language present but no parseable date => we KNOW a date exists and
      // we failed to read it. That is a parse failure, not an immediate delisting.
      if (SCHEDULING_RX.test(title)) return { type: 'PARSE_FAILED', field: 'date', event: 'DELIST_SCHEDULED', ko };
      // No scheduling language at all => a genuine effective-immediately delisting.
      return { type: 'LISTING', sev: 'MEDIUM', delist: true, ko };
    }
    if (/will suspend/.test(t)) return { type: 'LISTING', sev: 'MEDIUM', delist: true };
    if (/unlock|vesting|cliff release/.test(t)) return { type: 'UNLOCK', sev: 'HIGH' };
    if (/token generation|\btge\b|launchpool|launchpad|airdrop/.test(t)) return { type: 'TGE', sev: 'HIGH' };
    // Perp/futures LISTING — before the spot branch, whose "will list" also matches these.
    if (/perpetual|\bperps?\b|futures|x-perp/.test(t)
        && /will list|to list|lists |listing of|new listing|now launched|will launch|launches|now available|will add/.test(t)) {
      return { type: 'PERP', sev: 'MEDIUM' };
    }
    // Remaining derivatives are plumbing, not events: settlement, expiry, param changes.
    if (/x-perp|perpetual|\bperp\b|expiry|futures|margined|quarterly|options?\b|dual currency|dual investment|leveraged token|structured/.test(t)) return null;
    // "new listing" / "gets listed" / "now listed" were MISSING — the most common
    // phrasings of all. The PERP branch already matched "new listing", so equity perps
    // classified while a plain MEXC spot listing fell through to null and vanished.
    // Found by replaying the reference window rather than by reading the regex.
    if (/will list|to list|lists |listing of|new listing|newly listed|now listed|gets? listed|has listed|gets listing|new spot|spot trading|new trading pair|will add|seed tag/.test(t)) {
      return { type: 'LISTING', sev: 'HIGH' };
    }
    return null;
  })();

  // NOVELTY IS CHECKED LAST, and only on titles that would otherwise PUSH. Ordering
  // discovered by running the seeded vocabulary against the live Bybit feed before
  // deploy: with the check first, three promotional "Token Splash" posts — which match
  // no catalyst pattern and were always correctly dropped — became UNRECOGNISED and
  // generated operator lines. Novelty only matters when it would change a push
  // decision; a non-catalyst is a non-catalyst whatever words it contains.
  if (!kind) return null;
  // NOVELTY IS SCOPED to the types where PRODUCT-LINE ambiguity actually lives.
  // The gate exists because 'TradFi' — a product label — hid tokenized equities in
  // PERP titles. It is not a general unknown-word filter: applied to every type it
  // masked the new SUSPENSION and DELIST_SCHEDULED detectors outright (their titles
  // contain ordinary words like "deposit" and "termination" that a 31-token seeded
  // vocabulary has never seen), and it would have suppressed legitimate spot listings
  // for using an unfamiliar adjective. Equity risk in those types is already covered
  // by the EQUITY check above, which runs first.
  const NOVELTY_GATED = new Set(['PERP', 'ANNOUNCE']);
  if (NOVELTY_GATED.has(kind.type) && eq.cls === 'UNRECOGNISED') {
    return { type: 'UNRECOGNISED', sev: 'LOW', novel: eq.novel, would: kind.type };
  }
  return kind;
}

export async function pollAnnouncements() {
  if (Date.now() - lastPoll < POLL_EVERY) return;
  lastPoll = Date.now();
  // Warm the equity-perp symbol set (6h cache) so classify() can tell a stock perp
  // from a crypto perp. Failure is non-fatal: the name-based checks still apply.
  await loadDerivStockSymbols().catch(() => {});
  let total = 0, fired = 0, routineSuppressed = 0;
  const noiseDropped = {};
  for (const [exch, fetcher] of Object.entries(FEEDS)) {
    const items = await fetcher();
    if (!items || !items.length) continue;
    total += items.length;
    const prev = seen.get(exch);
    const ids = new Set(items.map((i) => i.id));
    seen.set(exch, ids);
    if (!prev) continue; // first poll = baseline, don't replay history
    const fresh = [];
    for (const it of items) {
      if (prev.has(it.id)) continue;
      const c = classify(it.title);
      // NULL = matched no catalyst pattern. Recorded rather than dropped: the two
      // pattern bugs on 16 Aug both vanished here, and their historical count is
      // unrecoverable because nothing was written down. Review with
      // `node review-unclassified.js`.
      if (!c) { noteUnclassified(exch, it.title); continue; }
      if (c.type === 'NOISE') { noiseDropped[c.noise] = (noiseDropped[c.noise] || 0) + 1; continue; }
      // PARSE FAILURE — the event is real but a field we depend on could not be read.
      // Loud to the operator, recorded for review, and NOT pushed in degraded form.
      if (c.type === 'PARSE_FAILED') {
        noteUnclassified(exch, `[PARSE_FAILED:${c.field}] ${it.title}`);
        console.error(`[announce][OPERATOR] ${c.event} detected on ${exch} but '${c.field}' FAILED TO PARSE — not pushed (a dateless delisting asserts less than it appears to). Title: "${it.title.slice(0, 110)}". Add the date form to DATE_RX in announcements.js.`);
        continue;
      }
      // ROUTINE SUSPENSION — corrected 17 Aug. Scheduled wallet maintenance with a
      // stated resumption is OPERATIONAL HOUSEKEEPING, the same category as tick-size
      // updates, and Korean venues publish many of them. It only reaches the channel
      // when it carries information a holder could act on:
      //   OPEN-ENDED       no resumption stated — the original signal
      //   UNLOCK OVERLAP   supply cannot move during the window, distorting the event
      //   PENDING DELIST   suspension before delisting is what traps holders
      //   CROSS-VENUE      two venues halting the same asset at once is not maintenance
      // Anything else goes to the review log, not the channel.
      if (c.type === 'SUSPENSION' && c.routine) {
        const asset = assetOf(it.title);
        const reasons = suspensionInterest(asset, exch);
        if (!reasons.length) {
          noteUnclassified(exch, `[ROUTINE_SUSPENSION] ${it.title}`);
          routineSuppressed++;
          continue;
        }
        c.interest = reasons;
      }
      if (c.type === 'UNRECOGNISED') {
        // Degrade to caution, not to a default. Never pushed: recorded to the digest
        // pool (its reader) and reported to the operator, exactly like unlocks'
        // `estimated` state. Sightings are noted so the message can ESCALATE with
        // recurrence — but a noted token is NOT a trusted one. Only `node
        // approve-token.js` grants trust, so an unread operator line can never
        // silently become an accepted policy.
        const entries = notePending(it.title);
        const u = pendingUrgency(entries);
        const st = getState();
        (st.digestPool ??= []).push({ ts: Date.now(), kind: 'UNRECOGNISED', title: `${u.mark} UNRECOGNISED product line · ${exch.toUpperCase()}: ${it.title.slice(0, 80)} [unreviewed: ${c.novel.join(', ')}]` });
        while (st.digestPool.length > 100) st.digestPool.shift();
        save();
        const seen = entries.map((e) => `${e.token}(x${e.count})`).join(', ') || c.novel.join(', ');
        console.error(`[announce][OPERATOR] ${u.mark} ${u.level}: would have been ${c.would} on ${exch} — unreviewed token(s) [${seen}] in: "${it.title.slice(0, 100)}". Not pushed; routed to digest and STAYS THERE until reviewed. Run: node approve-token.js  (or, if this marks tokenized equities, add the label to EQUITY_TEXT_RX in core/taxonomy.js)`);
        continue;
      }
      fresh.push({ it, c });
    }
    // BATCH COLLAPSE — the class-level defense against the next label drift: 3+
    // same-type announcements from one venue in one cycle is a product-line rollout
    // (today: six "TradFi" equity perps pushed individually at 10:34), which is ONE
    // event, not N catalysts. Whatever the next unrecognized label is, it arrives as
    // a batch and gets one message instead of a flood.
    const byKind = {};
    for (const f of fresh) (byKind[f.c.type + (f.c.delist ? ':delist' : '')] ??= []).push(f);
    for (const group of Object.values(byKind)) {
      if (group.length < 3) continue;
      const { c } = group[0];
      if (await dispatch({
        source: 'CEX', type: c.type === 'LISTING' ? 'ANNOUNCE' : c.type, severity: c.sev,
        venue: exch, delist: !!c.delist,
        key: `${exch}:batch:${c.type}:${new Date().toISOString().slice(0, 10)}`, cooldownMin: 24 * 60,
        title: `${exch.toUpperCase()}: ${group.length} ${c.type} announcements in one batch`,
        lines: [
          ...group.slice(0, 8).map((f) => f.it.title.slice(0, 80)),
          `Batched: ${group.length} same-type announcements in one poll cycle = a product-line rollout — one event, not ${group.length} catalysts.`,
        ],
        url: group[0].it.url,
      })) fired++;
      group.length = 0; // consumed
    }
    for (const { it, c } of Object.values(byKind).flat()) {
      const isDelist = !!c.delist;
      // Remember scheduled delistings so a later suspension on the same asset can
      // recognise the suspension-then-delisting sequence that traps holders.
      if (c.type === 'DELIST_SCHEDULED') {
        const a = assetOf(it.title);
        if (a) { const s = getState(); (s.pendingDelists ??= {})[a] = { at: Date.now(), venue: exch, dateText: c.dateText }; save(); }
      }
      if (await dispatch({
        source: 'CEX', type: c.type === 'LISTING' ? 'ANNOUNCE' : c.type,
        venue: exch, delist: isDelist,
        severity: c.sev, key: `${exch}:${it.id}`, cooldownMin: 24 * 60,
        title: `${exch.toUpperCase()}: ${it.title.slice(0, 110)}`,
        lines: [
          c.type === 'SUSPENSION'
            ? `${c.which.charAt(0).toUpperCase() + c.which.slice(1)} halted`
              + (c.routine ? ` · scheduled with a stated resumption, but reported because: ${c.interest.join('; ')}`
                           : ' · ⚠️ OPEN-ENDED: no resumption stated — suspensions often precede delistings, chain halts or incidents')
            : c.type === 'DELIST_SCHEDULED' ? `Scheduled delisting · effective ${c.dateText} — dated forward event; reminders at T-7d and T-1d`
            : c.type === 'UNLOCK' ? 'Token unlock notice — added supply hits the market'
            : c.type === 'TGE' ? 'Token generation / launchpool event — early volatility both ways'
            : c.type === 'PERP' ? 'Perp/futures listing — leverage and a short side open up, so expect wider swings'
            : isDelist ? '⚠️ Delisting notice — these usually dump hard and fast'
            : 'Listing announced — published BEFORE trading opens, so this is your lead time',
          'Fact only — no directional call.',
        ],
        url: it.url,
      })) fired++;
    }
  }
  const noiseStr = Object.entries(noiseDropped).map(([k, v]) => `${v} ${k}`).join(', ');
  console.log(`[announce] ${total} announcements scanned${fired ? ` · ${fired} alerts` : ''}${noiseStr ? ` · dropped ${noiseStr}` : ''}${routineSuppressed ? ` · ${routineSuppressed} routine suspensions -> review log` : ''}`);
}
