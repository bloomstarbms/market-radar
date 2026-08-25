// Single alert dispatcher. Every source sends alerts through here.
// alert = { source, type, severity, key, title, lines:[], url, cooldownMin?, track? }
//
// As of v0.11.0 every candidate passes the budget/state layer (core/budget.js) before
// it can reach Telegram. Severity emoji are gone: they encoded the magnitude that was
// already printed on the next line, and red was shared by "unlock in 3 days" and "new
// pair, no data". Tier (A/B/C) carries expected value instead, per spec §5.2.
import { config } from '../config.js';
import { broadcast, editBroadcast, hasRecipients } from './telegram.js';
import { markAlerted, onCooldown, getState, save } from './store.js';

// AUDIT FINDING (third instance of the early-return class): the v0.11 rewrite dropped
// the onCooldown READ — markAlerted kept writing state nobody consumed. Result: every
// suppressed path re-recorded its candidate on every poll cycle. Measured live before
// the fix: 1,385 outcome rows in 24h, 673 of them the same rug-blocked REVIVAL tokens.
// recordSuppressed dedupes suppressed recordings per key per window; dispatch()
// reinstates the cooldown read for pushes, honouring each detector's cooldownMin.
function recordSuppressed(alert, reason, score) {
  if (!alert.track) return;
  const k = `sup:${alert.source}:${alert.type}:${alert.track.symbol ?? alert.key ?? ''}:${reason}`;
  if (onCooldown(k, alert.cooldownMin ?? config.cooldownMin)) return; // already recorded this window
  markAlerted(k);
  recordAlert({ ...alert, suppressed: reason, score, mult: multOf(alert) });
}
import { recordAlert } from './outcomes.js';
import { admit, openThread, escalateThread, getThread, budgetStatus, multipliers } from './budget.js';

// Multipliers recompute hourly, so the SAME candidate scores differently hour to
// hour (observed spread on one day: 35/48/58 for FUNDING-MEDIUM). That is the closed
// loop working — but it makes push decisions unreconstructable unless the multiplier
// that applied AT DECISION TIME rides on the row. The FLOORED re-derivation controls
// for this; "why did this push and that identical one didn't" gets an answer.
const multOf = (a) => Number((multipliers()[a.type] ?? 1).toFixed(3));
import { allowPriceDetector } from './taxonomy.js';
import { checkExecutable } from './executability.js';
import { universeVerdict, recordVerdict } from './universe.js';

const TAG = {
  'DEX:REVIVAL': '🟢 DEX REVIVAL',
  'DEX:RUG': '🚨 LIQUIDITY PULL',
  'CEX:PUMP': '🚀 CEX PUMP',
  'CEX:DUMP': '📉 CEX SELL-OFF',
  'CEX:VOLUME': '👀 UNUSUAL VOLUME',
  'CEX:LISTING': '🆕 NEW LISTING',
  'CEX:ANNOUNCE': '📢 EXCHANGE ANNOUNCEMENT',
  'CEX:PERP': '⚔️ PERP LISTING',
  'CEX:UPBIT': '🇰🇷 UPBIT LISTING',
  'CEX:FUNDING': '⚡ FUNDING EXTREME',
  'CHAIN:WHALE': '🐋 WHALE MOVE',
  'CAL:CPI': '📅 CPI',
  'CAL:MACRO': '📅 MACRO',
  'CAL:TGE': '🚀 TOKEN GENERATION (TGE)',
  'CAL:EVENT': '🗓️ PROJECT MILESTONE',
  'CAL:UNLOCK': '🔓 TOKEN UNLOCK',
  'CEX:SUSPENSION': '⏸ DEPOSITS/WITHDRAWALS SUSPENDED',
  'CEX:DELIST_SCHEDULED': '🛑 DELISTING SCHEDULED',
  'SIG:CONFLUENCE': '🎯 CONFLUENCE',
  'SIG:MULTIEX': '🔀 MULTI-EXCHANGE MOVE',
  'CEX:CASCADE': '💥 LIQUIDATION CASCADE',
  'SYS:HEARTBEAT': '💓 HEARTBEAT',
  'SYS:DIGEST': '📋 DAILY DIGEST',
};

// ---------------------------------------------------------------- listing carve-out
// "Gate the trade, not the catalyst" is correct for venues where a listing repricees
// the asset globally — and wrong for venues that list constantly (62 of 69 historical
// pushes were LISTING, three MEXC micro-caps pushed inside one minute on 12 Aug).
// Venue-scoped, not global: TIER 1 pushes immediately; everything else DEFERS —
// digest at detection, re-evaluated at T+30m, PROMOTED to a push only if the pair
// shows evidence of tradeability. The catalyst is never lost; the interruption is earned.
// AUDIT-TRIGGER (trigger 3, REMAINING-WORK-NOTES.md): LISTING_TIER1 and
// LISTING_FLOOR_USD are the qualifying conditions for the catalyst bypasses. Editing
// either — adding a venue, moving the floor — changes which catalysts bypass the
// budget. Re-run the bypass audit when you touch them.
const LISTING_TIER1 = new Set(['upbit', 'bithumb', 'coinbase', 'binance']);
export const LISTING_FLOOR_USD = Number(process.env.LISTING_FLOOR_USD || 25000);
const LISTING_DEFER_MS = Number(process.env.LISTING_DEFER_MIN || 30) * 60e3;
export function listingRoute(exchange) {
  // Unknown venues defer too: an unrecognised exchange has not earned the bypass.
  return LISTING_TIER1.has(String(exchange || '').toLowerCase()) ? 'push' : 'defer';
}

// Venue tiering covers the WHOLE catalyst door, not just spot listings — there is no
// principled reason a Bybit perp listing gets unconditional RISK bypass while a Bybit
// spot listing defers (14 Aug: six equity perps pushed through the PERP door minutes
// after Fix 4 closed the LISTING one).
//
// DELISTS were exempted because "the risk runs toward HOLDERS" (same logic as
// RUG/DEPEG) — a good reason whose qualifying condition ("you hold it") CANNOT
// CURRENTLY BE TESTED: position awareness is cross-cutting B, unbuilt. An untestable
// qualifying condition makes it an unconditional bypass wearing a justification, and
// MEXC/Gate run batch delist sweeps of 10-20 tokens. Interim proxy until B exists:
// an asset that can't clear the $25k executable gate is almost certainly not held, so
// a tier-2 delist pushes ONLY on a symbol the universe has VERIFIED tradeable.
// Tier-1 delists still push unconditionally — a Binance/Upbit delist repriced the
// asset whether or not anyone here holds it.
// KNOWN LIMITATION: a held token that was never swept reads UNKNOWN and routes to
// digest. Replace this proxy with a real position check when B lands.
const CATALYST_TYPES = new Set(['LISTING', 'PERP', 'ANNOUNCE']);
const TITLE_SYMS = (title) => [...new Set(
  [...String(title || '').toUpperCase().matchAll(/\b([A-Z0-9]{2,15})(?:\/|-)?USDT\b/g)].map((m) => m[1] + 'USDT'),
)];
export function catalystRoute(alert) {
  if (!CATALYST_TYPES.has(alert.type) || alert.deferredEval) return 'push';
  const venue = alert.track?.exchange ?? alert.venue;
  if (listingRoute(venue) === 'push') return 'push'; // tier-1: unconditional, incl. delists
  if (alert.delist) {
    const syms = alert.track?.symbol ? [alert.track.symbol] : TITLE_SYMS(alert.title);
    return syms.some((s) => universeVerdict(venue, s) === 'PASS') ? 'push' : 'defer';
  }
  return 'defer';
}

// Re-evaluate deferred listings whose T+30m has arrived. Promotion goes back through
// dispatch (deferredEval skips re-deferral); admit sees LISTING = RISK bypass.
// Conviction on the promoted push is EARNED, not decorative: scoreBonus derives from
// measured executable depth vs the floor (the per-venue constants stay only on the
// tier-1 immediate path, where no book exists yet by definition).
// T+30m liquidity RE-CHECK. Survives the deferral deletion because 30 minutes is a
// real evaluation window — a book minutes old tells you nothing. But it no longer
// GATES the push: the listing already went out at detection, and this EDITS that
// message with the matured depth. Immediacy and evaluation both, instead of trading
// one for the other.
export async function checkPendingListings() {
  const st = getState();
  const pend = st.pendingListings || {};
  let changed = false;
  for (const [pk, p] of Object.entries(pend)) {
    if (Date.now() < p.checkAt) continue;
    delete pend[pk]; changed = true;
    const gate = await checkExecutable(p.exchange, p.symbol).catch(() => null);
    const mins = Math.round((Date.now() - p.ts) / 60e3);
    const th = st.threads?.[`${p.symbol.replace(/USDT$/, '')}:UP`];
    const line = gate ? gateLine(gate) : 'Executable: still unverified at T+30m (depth unavailable)';
    if (gate) recordVerdict(p.exchange, p.symbol, gate);
    console.log(`  [listing] ${pk} T+${mins}m re-check: ${gate?.status ?? 'unavailable'} — ${line}`);
    if (config.telegramToken && th?.messageIds?.length && th.lastText) {
      const updated = `${th.lastText}\n• <i>T+${mins}m depth check: ${line.replace(/^Executable: /, '')}</i>`;
      const res = await editBroadcast(th.messageIds, updated);
      if (res.ok) { th.lastText = updated; changed = true; }
      else if (!res.networkDown) console.log('  [listing] original message too old to annotate — depth logged only');
    }
  }
  if (changed) save();
}

// Data age is disclosed on every alert. Under REST polling a "5m move" can be up to a
// poll interval stale; the original system hid that. A stale alert that says so is
// trustworthy — one that pretends to be live is not (spec §6, acceptance test 10).
function ageLine(alert) {
  const ms = alert.snapshotTs ? Date.now() - alert.snapshotTs : null;
  const age = ms === null ? `≤${config.pollIntervalSec}s (REST poll)` : `${(ms / 1000).toFixed(0)}s`;
  return `<i>data age ${age}</i>`;
}

// Depth stated in the reader's terms, not as a pass/fail verdict.
export function gateLine(gate) {
  if (!gate || gate.executableUsd == null) return 'Executable: unverified (depth unavailable)';
  const usd = gate.executableUsd;
  const amt = usd >= 1000 ? `$${Math.round(usd / 1000)}k` : `~$${Math.round(usd)}`;
  const verdict = gate.pass ? 'tradeable' : 'not sizeable at your range';
  return `Executable: ${amt} at 50bps both sides · spread ${gate.spreadBps}bps — ${verdict}`;
}

export function formatAlert(a, meta = {}) {
  const tag = TAG[`${a.source}:${a.type}`] || `${a.source} ${a.type}`;
  const tier = meta.tier && a.source !== 'SYS' ? `${meta.tier}-TIER · ` : '';
  const head = `<b>[${tag}]</b> ${a.title}`;
  // FACTS carry NO tier and NO conviction. Conviction is a property of a prediction;
  // a listing does not have one, and printing 78 on it asserted something we never
  // meant. The subtitle instead states what kind of message this is.
  const sub = a.source === 'SYS' ? ''
    : meta.kind === 'FACT' ? '\n<i>fact · no directional call</i>'
    : `\n<i>${tier}conviction ${Math.round(meta.score ?? 0)}</i>`;
  const body = a.lines.map((l) => `• ${l}`).join('\n');
  const upd = meta.updates ? `\n<i>updated ${meta.updates}x — same setup, not a new event</i>` : '';
  const link = a.url ? `\n<a href="${a.url}">chart</a>` : '';
  return `${head}${sub}\n${body}${upd}${link}\n${ageLine(a)}`;
}

const GATED_TYPES = new Set(['PUMP', 'DUMP', 'VOLUME', 'FUNDING', 'MULTIEX', 'CASCADE']);

// Rug blocks are recorded from index.js (the screen runs there); same dedupe window.
export function recordSuppressedRug(alert, status) {
  recordSuppressed(alert, `rug:${status}`, 0);
}

let bugCount = 0;
let factCount = 0, callCount = 0;
export function dispatchBugCount() { return bugCount; }
// Heartbeat instrument: facts at zero for 48h is a DETECTOR problem, not a quiet
// market — facts do not depend on expectancy, so they should never all stop.
export function messageCounts() { return { facts: factCount, calls: callCount }; }
export async function dispatch(alert) {
  try {
    return await dispatchInner(alert);
  } catch (e) {
    if (e instanceof ReferenceError || e instanceof TypeError) {
      // Always a BUG, never a market condition. The v0.17.1 broken admit tail threw
      // per-candidate for two days and was swallowed by a message-only catch in the
      // pollers — candidates vanished unpushed AND unrecorded. Loud, counted,
      // surfaced in the heartbeat, and the candidate is still recorded.
      bugCount++;
      console.error('[OPERATOR][BUG] dispatch threw ' + e.constructor.name + ': ' + e.message + '\n' + e.stack);
      recordSuppressed(alert, 'internal-error', 0);
      return false;
    }
    throw e; // operational errors keep their existing handling
  }
}
async function dispatchInner(alert) {
  // 1. TAXONOMY — free, local, runs first. A stablecoin trading flat is not news.
  if (alert.track?.symbol && GATED_TYPES.has(alert.type)) {
    const tax = allowPriceDetector(alert.track.symbol, {
      price: alert.track.price, change24hPct: alert.track.change24hPct,
      quoteVol24h: alert.track.quoteVol24h, name: alert.track.name,
    }, alert.type);
    alert.assetClass = tax.cls;
    if (!tax.allowed) {
      recordSuppressed(alert, tax.reason, 0);
      console.log(`  [taxonomy] ${alert.track.symbol} dropped — ${tax.cls}`);
      return false;
    }
  }

  // 1a. CATALYST DEFERRAL — DELETED in v0.23.0.
  //
  // The rule was "never delay — deliver or suppress, never defer", and the deferral
  // path violated it in the one category where latency IS the value: a MEXC listing
  // detected at 06:40 surfaced at 18:00, eleven hours stale. That is a QUEUE wearing
  // the costume of filtering.
  //
  // Catalysts are FACTS and push at detection. The T+30m liquidity re-check survives
  // — 30 minutes is a real evaluation window, not a queue — but it now EDITS the
  // already-published message (see checkPendingListings) instead of gating it. And
  // the executability gate becomes a CONTENT ANNOTATION for facts rather than a push
  // gate: withholding a thin listing spent the reader's decision for them, and it is
  // their attention to spend.
  if (alert.type === 'LISTING' && !alert.deferredEval && alert.track?.exchange && alert.track?.symbol) {
    const st = getState();
    st.pendingListings ??= {};
    const pk = `${alert.track.exchange}:${alert.track.symbol}`;
    st.pendingListings[pk] ??= {
      ts: Date.now(), checkAt: Date.now() + LISTING_DEFER_MS,
      exchange: alert.track.exchange, symbol: alert.track.symbol,
      price: alert.track.price, title: alert.title, url: alert.url,
    };
    save();
  }

  // 1b. UNIVERSE — known-untradeable symbols drop here, free, before scoring. UNKNOWN
  // falls through: the alert-time gate below decides and its verdict seeds the universe.
  if (GATED_TYPES.has(alert.type) && alert.track?.exchange && alert.track?.symbol) {
    if (universeVerdict(alert.track.exchange, alert.track.symbol) === 'FAIL') {
      recordSuppressed(alert, 'universe', 0);
      return false;
    }
  }

  const key0 = `${alert.source}:${alert.dedupeKey ?? `${alert.type}:${alert.key}`}`;
  if (onCooldown(key0, alert.cooldownMin ?? config.cooldownMin)) return false;

  // CROSS-SOURCE DEDUP (v0.23.0) — the reference channel posted the same MEXC UTILITY
  // listing twice at 11:38 because two pollers saw it. Dedup on the EVENT
  // (venue, asset, event-type) for 6h regardless of which detector fired, since the
  // per-detector key differs while the event is identical.
  const venue = (alert.track?.exchange ?? alert.venue ?? '').toLowerCase();
  const asset = (alert.track?.symbol ?? alert.asset ?? '').toUpperCase().replace(/USDT$/, '');
  if (venue && asset) {
    const eventKey = `evt:${venue}:${asset}:${alert.type}`;
    if (onCooldown(eventKey, 6 * 60)) {
      console.log(`  [dedup] ${venue}:${asset} ${alert.type} already reported within 6h (cross-source)`);
      return false;
    }
    markAlerted(eventKey);
  }

  const verdict = admit(alert);
  if (!verdict.allow) {
    // Suppressed does NOT mean unmeasured. Per spec §7.3 muted candidates are labelled
    // negatives that feed threshold tuning — if we stopped scoring them we could never
    // learn that a silenced module had started working. So they still enter the
    // outcomes DB, flagged, and simply never reach Telegram.
    recordSuppressed(alert, verdict.reason, verdict.score);
    return false;
  }

  const key = `${alert.source}:${alert.dedupeKey ?? `${alert.type}:${alert.key}`}`;

  if (verdict.mode === 'escalate') {
    const th = getThread(alert);
    const updated = escalateThread(alert, verdict.score);
    if (updated) {
      const text = formatAlert(alert, { ...verdict, updates: updated.updates });
      console.log(`[UPDATE ${updated.id}] ${alert.type} ${alert.title.slice(0, 60)}`);
      if (config.telegramToken && th) {
        // DIVERGENCE GUARD: escalateThread advances computed state whether or not the
        // edit lands, so a lost edit means the bot believes it has shown something the
        // channel never displayed — and repeated losses drift silently. th.editFailed
        // records "channel is behind"; while set, the next escalation is a full
        // RE-SEND rather than an edit, so the channel converges even if individual
        // edits keep getting lost.
        if (th.editFailed || !th.messageIds?.length) {
          const ids = await broadcast(text);
          if (ids.length) {
            th.messageIds = ids; th.editFailed = false;
            console.log('  [update] re-sent in full — channel re-converged after lost edit(s)');
          } else if (hasRecipients()) {
            console.error('[OPERATOR] re-send failed too — channel still behind computed state, retrying at next escalation');
          }
        } else {
          const res = await editBroadcast(th.messageIds, text);
          if (!res.ok) {
            th.editFailed = true;
            if (!res.networkDown) console.log('  [update] edit refused (message too old) — next escalation re-sends in full');
          }
        }
      }
      markAlerted(key);
      if (alert.track) recordAlert({ ...alert, mult: multOf(alert) });
      return true;
    }
  }

  // 2. EXECUTABILITY — costs a call, so it runs LAST, only on candidates that already
  // cleared dedup (and, for calls, scoring and budget).
  //
  // HARD GATE for CALLS: an untradeable call is worthless, so it is suppressed.
  // ANNOTATION for FACTS: a thin listing is still a fact. Push it and SAY it is thin;
  // the reader decides whether $800 of depth is worth their time. Suppressing it made
  // that decision for them.
  const isFactMsg = verdict.kind === 'FACT';
  if ((GATED_TYPES.has(alert.type) || isFactMsg) && alert.track?.exchange && alert.track?.symbol) {
    const gate = await checkExecutable(alert.track.exchange, alert.track.symbol).catch(() => null);
    if (gate) {
      recordVerdict(alert.track.exchange, alert.track.symbol, gate);
      alert.gate = { status: gate.status, executableUsd: gate.executableUsd, spreadBps: gate.spreadBps };
      if (!gate.pass && !isFactMsg) {
        recordSuppressed(alert, `gate:${gate.status}`, verdict.score);
        console.log(`  [gate] ${alert.track.symbol} ${gate.status}: ${gate.reasons.join(', ')}`);
        return false;
      }
      alert.lines = [...alert.lines, gateLine(gate)];
    } else if (isFactMsg) {
      alert.lines = [...alert.lines, 'Executable: unverified (depth unavailable)'];
    }
  }

  if (verdict.provisional) alert.lines = [...alert.lines,
    '⚠️ PROVISIONAL: single-factor signal on a gate-passing symbol. Pushed to collect gated-population data; no measured edge claim. Auto-expires when gated n>=100 decides.'];
  const text = formatAlert(alert, verdict);
  const b = budgetStatus();
  const label = verdict.kind === 'FACT' ? 'FACT' : `CALL ${verdict.tier}${verdict.bypass ? '/bypass' : ''} ${Math.round(verdict.score ?? 0)}`;
  console.log(`\n[ALERT ${label}] ${text.replace(/<[^>]+>/g, '')}\n  [budget] ${b.used}/${b.limit} used today\n`);
  let ids = [];
  if (config.telegramToken) {
    ids = await broadcast(text);
    if (!ids.length && hasRecipients()) {
      // Delivery is part of "dispatched" (Aug 12 CPI lesson): 0/N sends succeeded, so
      // do NOT mark cooldowns, open threads, charge budget, or record — return false
      // and let the caller/detector retry next cycle while the signal is still fresh.
      // Time-boxed staleness guards upstream (macro's 45-min missed window, detector
      // re-checks) bound how stale a retry can get.
      console.error(`[OPERATOR] delivery failed for [${alert.type}] ${alert.title} — not marked delivered, retrying next cycle while fresh`);
      return false;
    }
  }
  openThread(alert, verdict.score, ids, !!verdict.charge);
  // Keep the published text so a T+30m depth re-check (and cross-venue escalation)
  // can EDIT it rather than posting a second message.
  const th2 = getThread(alert);
  if (th2) { th2.lastText = text; save(); }
  markAlerted(key);
  factCount += verdict.kind === 'FACT' ? 1 : 0;
  callCount += verdict.kind === 'FACT' ? 0 : 1;
  if (alert.track) recordAlert({ ...alert, kind: verdict.kind ?? 'CALL', mult: multOf(alert) });
  return true;
}
