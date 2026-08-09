// Single alert dispatcher. Every source sends alerts through here.
// alert = { source, type, severity, key, title, lines:[], url, cooldownMin?, track? }
//
// As of v0.11.0 every candidate passes the budget/state layer (core/budget.js) before
// it can reach Telegram. Severity emoji are gone: they encoded the magnitude that was
// already printed on the next line, and red was shared by "unlock in 3 days" and "new
// pair, no data". Tier (A/B/C) carries expected value instead, per spec §5.2.
import { config } from '../config.js';
import { broadcast, editBroadcast } from './telegram.js';
import { markAlerted, onCooldown } from './store.js';

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
  recordAlert({ ...alert, suppressed: reason, score });
}
import { recordAlert } from './outcomes.js';
import { admit, openThread, escalateThread, getThread, budgetStatus } from './budget.js';
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
  'SIG:CONFLUENCE': '🎯 CONFLUENCE',
  'SIG:MULTIEX': '🔀 MULTI-EXCHANGE MOVE',
  'CEX:CASCADE': '💥 LIQUIDATION CASCADE',
  'SYS:HEARTBEAT': '💓 STATUS',
};

// Data age is disclosed on every alert. Under REST polling a "5m move" can be up to a
// poll interval stale; the original system hid that. A stale alert that says so is
// trustworthy — one that pretends to be live is not (spec §6, acceptance test 10).
function ageLine(alert) {
  const ms = alert.snapshotTs ? Date.now() - alert.snapshotTs : null;
  const age = ms === null ? `≤${config.pollIntervalSec}s (REST poll)` : `${(ms / 1000).toFixed(0)}s`;
  return `<i>data age ${age}</i>`;
}

export function formatAlert(a, meta = {}) {
  const tag = TAG[`${a.source}:${a.type}`] || `${a.source} ${a.type}`;
  const tier = meta.tier && a.source !== 'SYS' ? `${meta.tier}-TIER · ` : '';
  const head = `<b>[${tag}]</b> ${a.title}`;
  const sub = a.source === 'SYS' ? '' : `\n<i>${tier}conviction ${Math.round(meta.score ?? 0)}</i>`;
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

export async function dispatch(alert) {
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
      if (config.telegramToken && th?.messageIds?.length) {
        const ok = await editBroadcast(th.messageIds, text);
        // If the message is too old to edit, let it go rather than posting a duplicate.
        if (!ok) console.log('  [update] edit failed (message too old) — not reposting');
      }
      markAlerted(key);
      if (alert.track) recordAlert(alert);
      return true;
    }
  }

  // 2. EXECUTABILITY — costs a call, so it runs LAST, only on candidates that already
  // cleared scoring, budget and dedup. Handful of requests a day instead of ~118k.
  if (GATED_TYPES.has(alert.type) && alert.track?.exchange && alert.track?.symbol) {
    const gate = await checkExecutable(alert.track.exchange, alert.track.symbol);
    recordVerdict(alert.track.exchange, alert.track.symbol, gate);
    alert.gate = { status: gate.status, executableUsd: gate.executableUsd, spreadBps: gate.spreadBps };
    if (!gate.pass) {
      recordSuppressed(alert, `gate:${gate.status}`, verdict.score);
      console.log(`  [gate] ${alert.track.symbol} ${gate.status}: ${gate.reasons.join(', ')}`);
      return false;
    }
    alert.lines = [...alert.lines,
      `Executable $${Math.round(gate.executableUsd / 1000)}k at 50bps both sides · spread ${gate.spreadBps}bps`];
  }

  const text = formatAlert(alert, verdict);
  const b = budgetStatus();
  console.log(`\n[ALERT ${verdict.tier}${verdict.bypass ? '/bypass' : ''} ${Math.round(verdict.score)}] ${text.replace(/<[^>]+>/g, '')}\n  [budget] ${b.used}/${b.limit} used today\n`);
  let ids = [];
  if (config.telegramToken) ids = await broadcast(text);
  openThread(alert, verdict.score, ids);
  markAlerted(key);
  if (alert.track) recordAlert(alert);
  return true;
}
