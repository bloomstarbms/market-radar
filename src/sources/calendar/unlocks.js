// TOKEN UNLOCK REMINDERS — 7 days and 3 days ahead.
// Unlock APIs are all paywalled now (DefiLlama, CryptoRank Pro $4,750/yr,
// Tokenomist), so this reads a local schedule file harvested from the free
// public calendar at cryptorank.io/token-unlock.
// Most vesting contracts release on a fixed day each month, so entries use
// `monthlyDay` (recurring) — the file stays valid without constant refreshing.
// One-off entries can use `date: "YYYY-MM-DD"`.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from '../../config.js';
import { dispatch } from '../../core/dispatcher.js';
import { loadWatchState, activeDemotions, observedAround, retrospectiveLine, loadRecheckState, effectiveSourced } from './cadence-watch.js';
import { sourceIsStale, SOURCE_STALE_DAYS, pressureStage, falsifierLine, MIN_FALSIFIER_MARGIN, sourceFreshness, SOURCE_STALE_DAYS as STALE_D, UNVERIFIABLE_MECHANISMS } from '../../core/unlock-promote.js';

const FILE = join(ROOT, 'unlocks.json');
// STAGE TIERING (coverage-session Part 3): at 25+ tracked tokens, un-tiered monthly
// unlocks emit up to 3 messages/day on top of everything else. Tier BEFORE bulk
// promotion. Negative lead = days AFTER the event (T+3 post-check). LOGGED rows are
// tracked, heartbeat-visible, never pushed. Stage assignments are PROVISIONAL until
// ADV matures (~Sep 7) — the row's note says so.
// T-7 IS THE MINIMUM every pushing row gets (operator ask: a week's notice). It was
// dropped when the tiers were first cut and restored on 2026-09-05; fixture asserts
// every non-LOGGED stage contains it. Sourced rows are STANDARD regardless of
// pressure — T-14 and T+3 assume observation a sourced row cannot make.
export const STAGES = { FULL: [14, 7, 3, 0, -3], STANDARD: [7, 3, 0], LOGGED: [] };
export const leadsFor = (row) => STAGES[row?.stage ?? 'STANDARD'] ?? STAGES.STANDARD;
const CHECK_EVERY = 6 * 3600e3;    // re-evaluate every 6h
let lastPoll = 0;
let cache = null, cacheTs = 0;

function loadSchedule() {
  if (cache && Date.now() - cacheTs < 3600e3) return cache;
  if (!existsSync(FILE)) return null;
  try { cache = JSON.parse(readFileSync(FILE, 'utf8')); cacheTs = Date.now(); return cache; }
  catch (e) { console.error('[unlocks] bad unlocks.json:', e.message); return null; }
}

// Most recent PAST occurrence — negative leads (T+3) look backward, and the
// forward-only helper would otherwise make post-event stages structurally dead code.
export function lastMonthlyDate(day, from = new Date()) {
  const today = new Date(from).setUTCHours(0, 0, 0, 0);
  for (let i = 0; i >= -2; i--) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(day, lastDay)));
    if (target.getTime() <= today) return target;
  }
  return null;
}

// Next occurrence of a monthly cliff (handles short months: day 31 -> last day)
function nextMonthlyDate(day, from = new Date()) {
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(day, lastDay)));
    if (target.getTime() >= from.setUTCHours(0, 0, 0, 0)) return target;
  }
  return null;
}

// CLAIM COVERAGE — every claim in a message needs a falsifier that covers it, or an
// explicit note that it does not. DATE, AMOUNT, CADENCE and SCOPE are four separate
// claims and a falsifier usually covers one. EIGEN's gap (message claimed the family
// figure, spec watched one wallet) was found by accident because both numbers
// happened to sit in one report; this makes the mapping explicit for every row so the
// next mismatch is visible rather than lucky.
//
// Derived from row SHAPE, never stored — a stored coverage field would drift from the
// spec it describes, which is the same class of defect one level up.
// lead < 0 (T+3) is RETROSPECTIVE: it can report what actually happened, including
// irregular emitters excluded from the forward falsifier. Predict the floor, report
// the total — same row, different claim per stage, both true.
// Falsifier strength clause, same words for every row: a window this wide passes by
// chance X% of the time; the record is Y%. Underived is said, not skipped.
function strengthClause(t) {
  const f = t?.falsifier;
  if (!f) return ' Falsifier strength: UNDERIVED.';
  if (f.verdict === 'NONE') return ' Falsifier strength: none (dead-man switch tests freshness, not the claim).';
  const series = f.replayHits != null ? `${f.replayHits}/${f.replayN}${f.replayHits === f.replayN ? ' consecutive' : ''}` : 'n/a';
  const comp = f.compound != null ? ` (that series by chance alone: p≈${f.compound.toExponential(1)})` : '';
  return ` Falsifier strength: each ${f.windowDays}-day window passes by chance ${Math.round(f.chanceRate * 100)}% of the time; record ${series}${comp}.`;
}
// CAN THIS ROW ACTUALLY FIRE? (v0.31.1) A sourced row can be perfectly configured
// and still never alert — if its snapshot held only PAST events, if it went stale,
// if the source retracted it, or if the pressure rule silenced it. The coverage line
// counts it as coverage either way, which is the silent-lapse shape: healthy-looking
// and doing nothing. Measured once on 2026-09-07 (29/29 had a future event, both
// before and after the refresh — the suspicion was not confirmed), and made
// PERMANENT here so the next time it is not true, the heartbeat says so.
//
// "firing in 7d" means a push is actually SCHEDULED: some (event, lead) pair lands
// inside the next seven days, using the row's EFFECTIVE stage (pressure rule
// applied), not its stored one.
export function sourcedFiring(now = Date.now(), tokens = null) {
  if (!tokens) { try { tokens = JSON.parse(readFileSync(join(ROOT, 'unlocks.json'), 'utf8')).tokens; } catch { tokens = []; } }
  const rc = loadRecheckState();
  const sourced = (tokens || []).filter((t) => !t.retired && t.provenance === 'sourced').map((t) => effectiveSourced(t, rc));
  const withFuture = sourced.filter((t) => (t.sourceEvents || []).some((e) => e.t * 1000 > now));
  const firing = [], mute = [];
  for (const t of sourced) {
    const blocked = t.sourceDemoted ? 'retracted' : sourceIsStale(t, now) ? 'stale'
      : !leadsFor({ stage: pressureStage(t) }).length ? 'silent-by-stage'
      : !(t.sourceEvents || []).some((e) => e.t * 1000 > now) ? 'no future event' : null;
    if (blocked) { mute.push(`${t.sym}:${blocked}`); continue; }
    const leads = leadsFor({ stage: pressureStage(t) });
    const soon = (t.sourceEvents || []).some((e) => leads.some((l) => {
      const fireAt = e.t * 1000 - l * 86400e3;
      return fireAt >= now - 86400e3 && fireAt <= now + 7 * 86400e3;
    }));
    if (soon) firing.push(t.sym);
  }
  // Rows silenced ON PURPOSE (stage/pressure/mechanism) are not a fault; rows mute
  // because their events ran out or their source went stale are. Split, so the alarm
  // only fires on the second kind.
  const faultMute = mute.filter((m) => /stale|no future event|retracted/.test(m));
  // Freshness ladder, reported on the WORST row (they refresh together, but a partial
  // refresh must surface as the oldest row, not the newest).
  const worst = sourced.map((t) => sourceFreshness(t, now)).sort((a, b) => (b.ageDays ?? 1e9) - (a.ageDays ?? 1e9))[0]
    ?? { level: 'FRESH', ageDays: 0, daysLeft: STALE_D };
  const fresh = { ...worst,
    line: worst.level === 'FRESH' ? `index age ${worst.ageDays}d`
      : worst.level === 'STALE' ? `🚨 index ${worst.ageDays}d old — sourced rows are SILENT; browser-pane refresh required (see NEXT-SESSION.md)`
      : worst.level === 'UNPARSEABLE' ? '🚨 a sourced row has an unparseable sourceFetchedAt'
      : `${worst.level === 'URGENT' ? '🚨' : '⚠️'} index ${worst.ageDays}d old · ${worst.daysLeft}d until every sourced row goes silent — browser-pane refresh required (see NEXT-SESSION.md)` };
  return { sourced: sourced.length, withFuture: withFuture.length, firing7d: firing.length, firing,
    mute, faultMute,
    freshness: fresh,
    line: `Sourced firing: ${sourced.length} rows · ${withFuture.length} with a future event · ${firing.length} firing in 7d`
      + (firing.length ? ` (${firing.join(', ')})` : '')
      + (faultMute.length ? ` · 🚨 ${faultMute.length} MUTE: ${faultMute.join(', ')}` : '')
      + ` · ${mute.length - faultMute.length} silent by design · ${fresh.line}` };
}

// CLAIM COVERAGE returns PARTS (message diet): `public` is the minimum a reader needs
// to weigh the claim; `operator` is the mechanism behind it. `line` is the join of
// both, unchanged in substance, so nothing that used to read the sentence loses it.
// Derived from row shape, never stored — a rendering cannot alter what a row claims.
const sourceLabel = (src) => (src === 'defillama' ? 'DefiLlama' : src);
const cov = (o) => ({ ...o, line: [...o.public, ...o.operator].join(' ') });
export function claimCoverage(t, lead = 3) {
  if (t?.provenance === 'sourced' && UNVERIFIABLE_MECHANISMS.includes(t.mechanism)) return cov({
    date: 'no-discrete-event', amount: 'sourced', scope: 'mechanism',
    public: [t.mechanism === 'continuous-claim'
      ? `No discrete event: the vesting contract pays a continuous stream that beneficiaries claim at will; ${t.source}'s date discretises it.`
      : `Index contradicted by chain: ${t.source}'s dates do not match where the contract's claims occur.`],
    operator: [`Tracked, never announced. Basis: ${t.mechanismBasis}`],
  });
  if (t?.provenance === 'sourced') return cov({
    date: 'sourced', amount: 'sourced', scope: 'source',
    public: [`Date and amount are ${sourceLabel(t.source)}'s published figures — not independently verified (pending a route).`],
    operator: [`Falsifier: the source itself, re-read weekly; silent after ${SOURCE_STALE_DAYS} days unrefreshed.`],
  });
  // (2026-09-15) no claimCoverage branch for enforcement:'contract' — the label is
  // claimable by nobody (see CONTRACT_ENFORCEMENT_RETRACTED); a row cannot reach here with it.
  if (lead < 0 && (t?.cadence || t?.alsoObserve)) return cov({
    date: 'observed', amount: 'observed-actual', scope: 'retrospective',
    public: ['Retrospective: the figures below are on-chain observations of what moved, not a forward estimate.'],
    operator: [],
  });
  const fam = Array.isArray(t?.cadence?.wallets) ? t.cadence.wallets.length : 0;
  if (fam) return cov({
    date: 'observed', amount: 'observed', scope: 'family',
    public: [`Date and amount both observed on-chain — ${fam} custody wallets, over ${t.cadence.monthsObserved} months.`],
    operator: [`Each wallet required to emit and the family total to land within ±${Math.round((t.cadence.tolerance ?? 0.25) * 100)}%. Auto-demotes if the pattern breaks.${strengthClause(t)}`],
  });
  if (t?.cadence) return cov({
    date: 'observed', amount: 'observed-partial', scope: 'tranche',
    public: [`Date and amount observed on-chain for ONE custody wallet (${t.cadence.monthsObserved} months). Other holders may emit on the same date and are NOT covered by this figure — treat it as a floor, not a total.`],
    operator: [`Auto-demotes if that wallet's pattern breaks.${strengthClause(t)}`],
  });
  if (t?.reviewBy) return cov({
    date: 'announced', amount: 'unchecked', scope: 'announcement',
    public: ['Date is project-announced. The AMOUNT is announcement-stated — nothing observes it on-chain.'],
    operator: [`Re-attested by ${t.reviewBy} (the row demotes itself if that passes).${strengthClause(t)}`],
  });
  return cov({ date: 'unknown', amount: 'unchecked', scope: 'unknown', public: ['Coverage unstated — this row should not be alerting.'], operator: [] });
}

// COVERAGE LINE — what the module knows and, crucially, what it CANNOT know. The
// bulk scan (29 Aug) established that unlock coverage is an Ethereum/EVM feature:
// 55 of 156 scanned symbols vest on their own chains, invisible from here. Absence
// of an unlock row must never read as "this token has no unlocks".
export function unlockCoverage(tokens = null) {
  if (!tokens) { const s = loadSchedule(); tokens = s?.tokens ?? []; }
  const verified = tokens.filter((t) => !t.retired && t.events?.length);
  const rc = loadRecheckState();
  const sourced = tokens.filter((t) => !t.retired && t.provenance === 'sourced').map((t) => effectiveSourced(t, rc));
  const stale = sourced.filter((t) => !t.sourceDemoted && sourceIsStale(t));
  const sourceDemoted = sourced.filter((t) => t.sourceDemoted).length;
  const stages = {};
  for (const t of [...verified, ...sourced]) stages[t.stage ?? 'STANDARD'] = (stages[t.stage ?? 'STANDARD'] || 0) + 1;
  const c = {
    tracked: tokens.length,
    verified: verified.length,
    sourced: sourced.length,
    staleSourced: stale.length,
    belowFloor: sourced.filter((t) => t.stage !== 'LOGGED' && pressureStage(t) === 'LOGGED').length,
    sourcedPending: sourced.filter((t) => !UNVERIFIABLE_MECHANISMS.includes(t.mechanism)).length,
    agreement: (() => { const sec = loadSecondIndex(); const c = { 'both-agree': 0, 'both-differ': 0, 'single-source': 0, 'not-checked': 0 };
      for (const t of sourced) c[sourceAgreement(t, sec).state]++; return c; })(),
    sourcedUnverifiable: sourced.filter((t) => UNVERIFIABLE_MECHANISMS.includes(t.mechanism)).length,
    continuousClaim: sourced.filter((t) => t.mechanism === 'continuous-claim').length,
    indexContradicted: sourced.filter((t) => t.mechanism === 'index-contradicted').length,
    underived: verified.filter((t) => (t.cadence || t.enforcement === 'contract' || t.reviewBy) && !t.falsifier).length,
    strength: verified.filter((t) => t.cadence || t.enforcement === 'contract' || t.reviewBy).map(falsifierLine).join(' · '),
    // The admission bar rides the heartbeat with the LOWEST live margin beside it —
    // a row drifting toward the bar is seen, not remembered. Arithmetic over rows.
    marginBar: MIN_FALSIFIER_MARGIN,
    lowestMargin: verified.filter((t) => Number.isFinite(t.falsifier?.margin)).map((t) => ({ sym: t.sym, margin: t.falsifier.margin })).sort((a, b) => a.margin - b.margin)[0] ?? null,
    estimated: tokens.filter((t) => !t.retired && !t.events?.length && t.provenance !== 'sourced').length,
    retired: tokens.filter((t) => t.retired).length,
    cadence: verified.filter((t) => t.cadence).length,
    contractCliff: verified.filter((t) => t.enforcement === 'contract').length,
    reviewBy: verified.filter((t) => t.reviewBy && !t.cadence).length,
    stages,
  };
  c.sourceDemoted = sourceDemoted;
  c.line = `Unlock coverage: ${c.tracked} tracked · ${c.verified} verified (${c.cadence} cadence-watched · ${c.contractCliff} contract-cliff · ${c.reviewBy} review-dated) · falsifier chance→replay: ${c.strength}${c.underived ? ` (${c.underived} UNDERIVED)` : ''} · margin bar ${c.marginBar}${c.lowestMargin ? ` (lowest ${c.lowestMargin.sym} ${c.lowestMargin.margin})` : ' (no margins live)'} · ${c.sourced} sourced (${c.sourcedPending} pending verification · ${c.sourcedUnverifiable} unverifiable by mechanism: ${c.continuousClaim} continuous-claim, ${c.indexContradicted} index-contradicted)${c.staleSourced ? ` (${c.staleSourced} STALE, silent)` : ''}${c.belowFloor ? ` (${c.belowFloor} below pressure floor, silent)` : ''} · 2nd source: ${c.agreement['both-agree']} agree · ${c.agreement['both-differ']} DISAGREE · ${c.agreement['single-source']} single-source${c.agreement['not-checked'] ? ` · ${c.agreement['not-checked']} unchecked` : ''}${sourceDemoted ? ` (${sourceDemoted} retracted by source)` : ''} · ${c.estimated} estimated (silent) · ${c.retired} retired · stages ${Object.entries(stages).map(([k, v]) => k + ':' + v).join(' ')} · verified reads are Ethereum/EVM only — sourced rows cite a named calendar and are not independently checked`;
  return c;
}

// SOURCED MESSAGE — visibly weaker than verified, by design. Different header icon
// (📅 vs 🔓) so the tier reads at a glance in a chat list; the source is NAMED in
// the title line; the amount is the SOURCE'S figure and says so; and the message
// states how long ago the source was last confirmed. Same prose discipline as every
// fact: no direction, no imperative, no frequency claim without n.
const EXPLORER = { ethereum: 'https://etherscan.io/token/', base: 'https://basescan.org/token/', bsc: 'https://bscscan.com/token/', arbitrum: 'https://arbiscan.io/token/', optimism: 'https://optimistic.etherscan.io/token/' };
// CROSS-SOURCE AGREEMENT (Route: two indexes, v0.31.2). This is still
// INDEX-NOT-EVIDENCE. Two aggregators concurring is not chain evidence and MUST NOT
// promote anything — it changes the MESSAGE, never the provenance tier. What it buys
// is the one thing a single source cannot give: visible DISAGREEMENT, which flags a
// date not to rely on.
//
// Derived at RUNTIME rather than stamped on the row. The brief said "add to the
// row", and the intent (every sourced row carries a state, visible in its message)
// is met — but the value is a function of TWO index files that refresh
// independently, so a stored copy would be stale the moment either moved, and
// unlocks.json would gain a second writer. Overlay, like effectiveSourced.
//
// COMPARISON IS ON DATES ONLY. CryptoRank states amounts as a percentage of
// CIRCULATING supply, DefiLlama as tokens against maxSupply; reconciling them would
// invent precision neither source gives.
export const AGREEMENT_STATES = ['both-agree', 'both-differ', 'single-source', 'not-checked'];
export const AGREE_TOLERANCE_DAYS = 1; // declared, not derived: calendars differ by a day on timezone alone

export function loadSecondIndex() {
  try { return JSON.parse(readFileSync(join(ROOT, 'data', 'unlock-index-cryptorank.json'), 'utf8')); }
  catch { return null; }
}

// PURE. Compares the row's NEXT future event against the second index's next date
// for that symbol. Anything else would be a false comparison: the second source
// publishes ONE next unlock per symbol, so matching it against a later event of ours
// would manufacture a disagreement that neither source claims.
export function sourceAgreement(t, second, now = Date.now()) {
  const ours = (t?.sourceEvents || []).filter((e) => e.t * 1000 > now).sort((a, b) => a.t - b.t)[0];
  const ourDate = ours ? new Date(ours.t * 1000).toISOString().slice(0, 10) : null;
  if (!second) return { state: 'not-checked', ourDate, otherDate: null, deltaDays: null,
    line: 'Second source not checked — no CryptoRank index on disk.' };
  const p = (second.protocols || []).find((x) => x.symbol === t?.sym);
  const sourceName = t?.source === 'defillama' ? 'DefiLlama' : (t?.source ?? 'the source');
  if (!p?.nextDate || !ourDate) {
    const why = p ? 'lists it without a next-unlock date' : 'does not list it';
    return { state: 'single-source', ourDate, otherDate: null, deltaDays: null,
      line: `Listed by ${sourceName} only — CryptoRank ${why}${second.withheld ? ` (that source withholds ${second.withheld} entries' identity behind its paid tier)` : ''}.` };
  }
  const deltaDays = Math.round((Date.parse(p.nextDate + 'T00:00:00Z') - Date.parse(ourDate + 'T00:00:00Z')) / 86400e3);
  if (Math.abs(deltaDays) <= AGREE_TOLERANCE_DAYS) {
    return { state: 'both-agree', ourDate, otherDate: p.nextDate, deltaDays,
      line: `${sourceName} and CryptoRank agree on this date${deltaDays ? ` (${Math.abs(deltaDays)} day apart)` : ''} — still two calendars, not a chain read.` };
  }
  return { state: 'both-differ', ourDate, otherDate: p.nextDate, deltaDays,
    line: `Sources disagree: ${sourceName} ${ourDate}, CryptoRank ${p.nextDate} — ${Math.abs(deltaDays)} days apart. Neither is verified; treat this date as the weaker of the two claims.` };
}

// `second` is INJECTABLE so fixtures are hermetic: a message test that reads the
// live index tests today's data, not the code.
//
// MESSAGE DIET (2026-09-18): `lines` is the PUBLIC rendering — the fact, the numbers,
// the minimum provenance to weigh it, six lines at most. `operatorLines` carries the
// rest of what the system knows (the pre-diet sentences, unchanged in substance) and
// renders only in the operator DM. Field-by-field destinations are in
// docs/briefs/MESSAGE-FIELD-INVENTORY.md and pinned by fixture 64.
const fmtDate = (key) => { const d = new Date(key + 'T00:00:00Z'); return `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}`; };
const fmtN = (n) => Math.round(n).toLocaleString();
// Second-source state collapses to ONE public form; the paid-tier explanation and the
// "two calendars, not a chain read" caveat go to the operator rendering.
function agreementPublic(ag, t) {
  const me = sourceLabel(t.source);
  if (ag.state === 'both-agree') return `${me} + CryptoRank agree`;
  if (ag.state === 'both-differ') return `sources disagree: ${me} ${fmtDate(ag.ourDate)}, CryptoRank ${fmtDate(ag.otherDate)}`;
  return `${me} only`;
}
export function sourcedMessage(t, ev, lead, now = new Date(), second) {
  const dateKey = new Date(ev.t * 1000).toISOString().slice(0, 10);
  const ageD = Math.max(0, Math.round((now - new Date(t.sourceFetchedAt)) / 86400e3));
  const pctUnlocked = t.maxSupply && t.circSupply != null ? Math.round(100 * t.circSupply / t.maxSupply) : null;
  const pctOfMax = t.maxSupply && ev.n ? (100 * ev.n / t.maxSupply) : null;
  const future = (t.sourceEvents || []).filter((e) => e.t * 1000 > now.getTime());
  const cats = [...new Set(future.flatMap((e) => String(e.cats || '').split('+')))].filter(Boolean);
  const kind = ev.type === 'linear' ? `linear tranche (${Math.round(ev.rd || 0)}d)` : 'cliff';
  const [chain, addr] = String(t.token || '').split(':');
  const explorer = EXPLORER[chain] && addr ? `${EXPLORER[chain]}${addr}` : null;
  const sourceName = sourceLabel(t.source);
  const isNext = future.length && future.slice().sort((a, b) => a.t - b.t)[0].t === ev.t;
  const ag = isNext ? sourceAgreement(t, second === undefined ? loadSecondIndex() : second, now.getTime()) : null;
  const cc = claimCoverage(t, lead);
  const ageTxt = ageD === 0 ? 'today' : `${ageD}d old`;
  return {
    title: `📅 UNLOCK · ${t.sym} — ${fmtDate(dateKey)} (${lead === 0 ? 'today' : `${lead}d`})`,
    lines: [
      `${fmtN(ev.n)} ${t.sym} (source figure${pctOfMax != null ? `, ${pctOfMax.toFixed(2)}% of max supply` : ''}) · ${kind}${pctUnlocked != null ? ` · ${pctUnlocked}% already unlocked` : ''}`,
      ...(cats.length ? [cats.join(' / ')] : []),
      `${t.chain === 'unconfirmed' ? 'chain unconfirmed — no on-chain read attempted' : t.chain} · ${sourceName}, unverified (${ageTxt})`,
      ...(ag ? [agreementPublic(ag, t)] : []),
      ...(t.sourceRevision ? [`Schedule ${t.sourceRevision.note} (recheck ${t.sourceRevision.at})`] : []),
      ...(t.note ? [t.note] : []),
    ],
    operatorLines: [
      `per ${sourceName}'s schedule — NOT independently verified · ${cc.line}`,
      `Source lists ${future.length} upcoming batch event${future.length === 1 ? '' : 's'}${cats.length ? ` (${cats.join(' / ')})` : ''}`,
      `Source last confirmed ${ageD === 0 ? 'today' : `${ageD} day${ageD === 1 ? '' : 's'} ago`} · goes silent if not re-confirmed within ${SOURCE_STALE_DAYS} days`,
      ...(ag ? [ag.line] : []),
      ...(t.mechanism && t.mechanism !== 'pending' ? [`Mechanism: ${t.mechanism}`] : []),
      ...(t.operatorNote ? [`Operator note: ${t.operatorNote}`] : []),
    ],
    url: explorer ?? 'https://defillama.com/unlocks',
    dateKey,
  };
}

// VERIFIED unlock message (generic path: cadence rows and reviewBy rows). Public:
// the date, what is known about the amount, and how it was verified — in reader's
// terms. Operator: the source event, the coverage mechanism, the falsifier strength,
// the stage epistemics, and the build log. `retro` is the T+3 observed-total line
// (an observation, so it is public).
function amountPublic(t) {
  const fam = Array.isArray(t?.cadence?.wallets) ? t.cadence.wallets : null;
  if (fam) return `~${fmtN(fam.reduce((s, w) => s + (w.meanAmount || 0), 0))} ${t.sym} monthly · custody distribution, ${fam.length} wallets`;
  if (t?.cadence?.meanAmount) return `~${fmtN(t.cadence.meanAmount)} ${t.sym} monthly · one custody wallet · a floor, not a total`;
  return null;
}
function verifiedPublic(t, lead) {
  const cc = claimCoverage(t, lead);
  if (cc.scope === 'family') return `Verified on-chain · ${t.cadence.monthsObserved} consecutive months · ${t.cadence.wallets.length} wallets`;
  if (cc.scope === 'tranche') return `Verified on-chain · ${t.cadence.monthsObserved} consecutive months · one wallet`;
  if (cc.scope === 'retrospective') return 'Observed on-chain — what moved, not an estimate';
  if (cc.scope === 'announcement') return 'Project-announced · amount not observed on-chain';
  return cc.public.join(' ');
}
export function verifiedMessage(t, lead, dateKey, retro = null) {
  const cc = claimCoverage(t, lead);
  const epistemics = lead >= 7
    ? 'Added supply reaches the market on this date. No directional claim — the drift around unlocks has not been measured on this corpus.'
    : lead < 0
    ? 'Post-event check: emission was scheduled on the stated date. Fact only — no read on what it did.'
    : 'Emission is imminent. Fact only: what happens next is not something this system has earned an opinion about.';
  const amt = amountPublic(t);
  return {
    title: lead < 0 ? `🔓 UNLOCK · ${t.sym} — T+${-lead} (event ${fmtDate(dateKey)})` : `🔓 UNLOCK · ${t.sym} — ${fmtDate(dateKey)} (${lead === 0 ? 'today' : `${lead}d`})`,
    lines: [
      ...(amt && lead >= 0 ? [amt] : []),
      ...(retro ? [retro] : []),
      verifiedPublic(t, lead),
      ...(t.note ? [t.note] : []),
    ],
    operatorLines: [
      `${t.name || t.sym}: scheduled token unlock · Verified — source: ${t.events[0].source}. ${cc.line}`,
      `Stage T${lead >= 0 ? '-' : '+'}${Math.abs(lead)}: ${epistemics}`,
      ...(t.operatorNote ? [`Operator note: ${t.operatorNote}`] : []),
    ],
    url: `https://cryptorank.io/price/${(t.name || t.sym).toLowerCase().replace(/\s+/g, '-')}/vesting`,
    dateKey,
  };
}

// renderFact(row, audience, ctx): the one entry point the render-lint runs over.
// Picks the builder by row shape and returns the lines that audience would see —
// public = `lines`; operator = `lines` + `operatorLines` (a superset, by construction).
export function renderFact(t, audience, ctx = {}) {
  const msg = t?.provenance === 'sourced'
    ? sourcedMessage(t, ctx.ev ?? (t.sourceEvents || [])[0], ctx.lead ?? 7, ctx.now ?? new Date(), ctx.second ?? null)
    : verifiedMessage(t, ctx.lead ?? 7, ctx.dateKey ?? '2026-01-01', ctx.retro ?? null);
  const lines = audience === 'operator' ? [...msg.lines, ...msg.operatorLines] : msg.lines;
  return { title: msg.title, lines, url: msg.url, text: [msg.title, ...lines].join('\n') };
}
// PUBLIC BUDGET (Part 2): a seventh line means something is prose. Declared here,
// asserted by fixture on every template with representative rows.
export const PUBLIC_MAX_LINES = 6;
export const PUBLIC_MAX_CHARS = 420;

async function pushSourced(t, now) {
  let fired = 0;
  // Pressure floor applied at RUNTIME as an overlay (the row file keeps its single
  // writer): a sourced row whose tranches are below the derived floor, or are
  // farming/staking-only, is tracked but silent — LOGGED has no leads.
  const leads = leadsFor({ stage: pressureStage(t) });
  for (const ev of t.sourceEvents || []) {
    const target = new Date(ev.t * 1000);
    const daysOut = Math.round((target - now) / 86400e3);
    for (const lead of leads) {
      if (lead < 0 || daysOut !== lead) continue; // sourced rows never look backward
      const msg = sourcedMessage(t, ev, lead, now);
      if (await dispatch({
        source: 'CAL', type: 'UNLOCK',
        severity: 'MEDIUM',               // one band: a sourced notice carries no severity ladder
        key: `${t.sym}:${msg.dateKey}:${lead}:sourced`, cooldownMin: 2 * 24 * 60,
        title: msg.title, lines: msg.lines, operatorLines: msg.operatorLines, url: msg.url,
      })) fired++;
    }
  }
  return fired;
}

export async function pollUnlocks() {
  if (Date.now() - lastPoll < CHECK_EVERY) return;
  lastPoll = Date.now();
  const sched = loadSchedule();
  if (!sched?.tokens?.length) return;

  const now = new Date();
  // Per-cycle counters. estimatedSkipped lived at module scope and climbed 17 → 51 → 68
  // → 85 across cycles (2026-09-17) — a stored value that never reset, one reader away
  // from being a rate.
  let fired = 0, staleSourced = 0, estimatedSkipped = 0;
  // Cadence overlay: a behavioural row whose watch window passed empty is demoted by
  // OBSERVATION, recorded in bot-owned data/ — unlocks.json keeps its single human
  // writer. A demotion is superseded only by a re-promotion with newer evidence.
  const demoted = activeDemotions(sched.tokens, loadWatchState());
  const recheck = loadRecheckState();
  let cadenceDemoted = 0;
  for (const t of sched.tokens) {
    if (demoted[t.sym]) { cadenceDemoted++; estimatedSkipped++; continue; } // alerts as nothing until re-verified
    // THREE-STATE DISCIPLINE (spec §4.2): only a VERIFIED DATE may alert — a date
    // read from the vesting contract or a project announcement, stored in
    // t.events[]. `monthlyDay` recurrences and pct-only rows are ESTIMATED:
    // logged, ranked for integration priority, never alerted. The module degrades
    // to silence, not to guessing — a 🔴 directive on an admitted guess was the
    // original defect here.
    if (t.retired) continue; // positive state, asserted at boot — never alert
    // SOURCED tier: a named third party's schedule, pushed as a fact ABOUT THE
    // SOURCE, labelled, at STANDARD. Stops when the source has not been re-read in
    // 21 days — a stale source is a memory, not a source.
    if (t.provenance === 'sourced') {
      const eff = effectiveSourced(t, recheck);      // overlay: refreshed/revised/demoted
      if (eff.sourceDemoted) { estimatedSkipped++; continue; } // source retracted — silent
      if (sourceIsStale(eff, now.getTime())) { staleSourced++; continue; }
      fired += await pushSourced(eff, now);
      continue;
    }
    if (!Array.isArray(t.events) || !t.events.length) { estimatedSkipped++; continue; }
    // (2026-09-18) the contract-cliff alert branch that lived here is gone with the
    // tier: enforcement:'contract' is claimable by nobody, so no row reaches it.
    const when = t.date ? new Date(t.date + 'T00:00:00Z') : (t.monthlyDay ? nextMonthlyDate(t.monthlyDay, new Date()) : null);
    const prev = t.date ? new Date(t.date + 'T00:00:00Z') : (t.monthlyDay ? lastMonthlyDate(t.monthlyDay, new Date()) : null);

    for (const lead of leadsFor(t)) {
      const target = lead >= 0 ? when : prev; // negative leads look BACKWARD
      if (!target) continue;
      const daysOut = Math.round((target - now) / 86400e3);
      if (daysOut !== lead) continue;
      const dateKey = target.toISOString().slice(0, 10);
      // Provenance stated precisely: an events[]-backed date says HOW it was verified
      // (contract read / announcement / on-chain backtest), not a generic calendar
      // claim. The first live push carried 'verified against the public unlock
      // calendar' on a date that had actually replayed ten times on-chain — underselling
      // the strongest evidence in the system.
      // Provenance CLASS matters, not just source: a contract read is a commitment
      // (enforced on-chain); a cadence read is a habit (custody can change it at
      // will). Both verify, but they fail differently — the message says which one
      // it is resting on instead of letting "verified" imply the stronger class.
      // T+3 reports observed totals; if the read fails, it says so rather than
      // silently falling back to the forward floor (absence-of-observation rule).
      let retro = null;
      if (lead < 0 && (t.cadence || t.alsoObserve)) {
        const addrs = [...(t.cadence?.wallets?.map((w) => w.addr) ?? (t.cadence?.wallet ? [t.cadence.wallet] : [])), ...(t.alsoObserve ?? [])];
        const obs = addrs.length ? await observedAround(addrs, t.sym, dateKey, t.cadence?.graceDays ?? 3).catch(() => null) : null;
        retro = retrospectiveLine(obs, t.cadence);
      }
      const msg = verifiedMessage(t, lead, dateKey, retro);
      if (await dispatch({
        source: 'CAL', type: 'UNLOCK',
        severity: lead === 3 || lead === 0 ? 'HIGH' : lead < 0 ? 'LOW' : 'MEDIUM',
        key: `${t.sym}:${dateKey}:${lead}`, cooldownMin: 2 * 24 * 60,
        title: msg.title, lines: msg.lines, operatorLines: msg.operatorLines, url: msg.url,
      })) fired++;
    }
  }
  if (config.debug || fired) console.log(`[unlocks] ${sched.tokens.length} tracked${fired ? ` · ${fired} reminders sent · ${estimatedSkipped} estimated-only (silent, pending contract reads)` : ''}${cadenceDemoted ? ` · ${cadenceDemoted} cadence-demoted (silent until re-verified)` : ''}${staleSourced ? ` · ${staleSourced} sourced rows STALE (>${SOURCE_STALE_DAYS}d, silent until refreshed)` : ''}`);
}
