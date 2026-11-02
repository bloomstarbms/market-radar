// Zero-dependency Telegram bot: long-polling for commands, broadcast for alerts.
import { config } from '../config.js';
import { addSubscriber, removeSubscriber, getState, save } from './store.js';
import { statsSummary } from './outcomes.js';

const API = () => `https://api.telegram.org/bot${config.telegramToken}`;
let offset = 0;
let running = false;

// A STRAY '<' IS AN UNDELIVERABLE MESSAGE. Messages are sent as HTML, so Telegram reads
// every '<' as a tag; a '<' that is not one of ours — "<14d", "n<25", a symbol with an
// angle bracket — makes the whole send fail with "can't parse entities", and a
// heartbeat that fails is retried every poll, failing every poll. On 2026-10-01 the
// "Sourced firing" line gained such a '<' when the unlock index's coverage horizon
// dropped under 14 days, and the heartbeat was undeliverable for ten hours (574
// retries) while saying, correctly, that the index needed a refresh. The escape lives
// HERE, at the one place every message leaves, so no renderer has to remember it.
// Only our own tags survive: <b> <i> <a href=…> <code> <pre> <u> <s> and their closers.
const OWN_TAG = /^<\/?(b|strong|i|em|u|s|code|pre|a(?:\s+href="[^"]*")?)>/;
export function safeHtml(text) {
  const s = String(text ?? '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '<') { const m = s.slice(i).match(OWN_TAG); if (m) { out += m[0]; i += m[0].length - 1; continue; } out += '&lt;'; continue; }
    out += ch;
  }
  return out;
}

// THE PATH THAT REPORTS A FAILURE MUST BE SIMPLER THAN THE PATH THAT FAILED. The
// escape above closes one character; it does not close the shape — the heartbeat is
// the instrument for detecting silence and it went silent for ten hours because of
// a '<', and nothing could say so because the reporter was the thing failing. After
// FALLBACK_AFTER consecutive total broadcast failures, the DM gets one bare line:
// plain text, NO parse_mode, nothing dynamic beyond a count, a time and the first 80
// characters of Telegram's own error. It cannot fail on formatting because it has
// none. Repeats at most hourly while the streak continues; the streak resets on the
// first successful broadcast. Same class as the preflight notify.
export const FALLBACK_AFTER = 3, FALLBACK_EVERY_MS = 3600e3;
let failStreak = 0, failSince = 0, lastFallbackAt = 0, lastSendError = '';
export function fallbackDecision(streak, lastAt, now = Date.now()) { return streak >= FALLBACK_AFTER && now - lastAt >= FALLBACK_EVERY_MS; }
export function fallbackText(n, sinceTs, err) { return `[radar] ${n} sends failed since ${new Date(sinceTs).toISOString().slice(0, 16)}Z, last error: ${String(err || 'unknown').replace(/\s+/g, ' ').slice(0, 80)}`; }
export function deliveryStreak() { return { failStreak, failSince, lastFallbackAt, lastSendError }; }
export function resetDeliveryStreak() { failStreak = 0; failSince = 0; lastFallbackAt = 0; lastSendError = ''; }
const NO_PREVIEW = Object.freeze({ is_disabled: true }); // no preview card on any message (account links, charts, explorers)
async function sendPlain(chatId, text) { return tg('sendMessage', { chat_id: chatId, text, link_preview_options: NO_PREVIEW }); } // no parse_mode: nothing to parse

async function tg(method, payload) {
  if (typeof payload?.text === 'string' && payload.parse_mode === 'HTML') payload = { ...payload, text: safeHtml(payload.text) };
  const res = await fetch(`${API()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) { lastSendError = String(json.description || `HTTP ${res.status}`); console.error(`[telegram] ${method} failed:`, json.description); }
  return json;
}

// A MESSAGE THAT DOES NOT FIT (2026-11-02). Telegram refused the heartbeat "message is too long" on every
// poll from 29 Oct 19:34 UTC for two days: the same text, resent each minute, refused each minute, and
// the only sign was a generic fallback line. Three rules, here at the one place every message leaves:
//   1. Length is Telegram's count: UTF-16 code units of the text AFTER HTML parsing (a tag counts 0,
//      an entity 1, an emoji 2). A message over SPLIT_AT goes as parts, split between top-level lines
//      only (never inside a tag), each labelled (k/n); a single line too long for a part is shortened.
//   2. A text refused as too long is never sent again: the part is re-split smaller at once, and the
//      split point drops (persisted, state.tgSplitAt) so every later message starts below it.
//   3. A message TYPE (its [TAG]) that reaches no recipient for an hour DMs one plain line naming the
//      type and the error, once, until it is delivered again (state.undeliverable).
export const TG_LIMIT = 4096;
export const SPLIT_AT = 4000;   // near the limit: room for the (k/n) label
const MIN_SPLIT = 1000;
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const TAG_RX = /<(\/?)(b|strong|i|em|u|s|code|pre|a)(?:\s[^>]*)?>/;
export function tgLength(text) {
  return safeHtml(text).replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m)).length;
}
// Lines at tag depth 0: the only places a message may be cut.
function topLevelLines(s) {
  const out = []; let depth = 0, start = 0;
  const rx = new RegExp(TAG_RX.source + '|\\n', 'g');
  for (const m of s.matchAll(rx)) {
    if (m[0] === '\n') { if (depth === 0) { out.push(s.slice(start, m.index)); start = m.index + 1; } continue; }
    depth = Math.max(0, depth + (m[1] ? -1 : 1));
  }
  out.push(s.slice(start));
  return out;
}
// Shorten one line to max visible units, tags kept whole and closed, ending in "…".
export function clipLine(line, max) {
  if (tgLength(line) <= max) return line;
  let out = '', n = 0; const open = [];
  const rx = new RegExp(TAG_RX.source + '|&(?:#x[0-9a-f]+|#\\d+|[a-z]+);|[\\s\\S]', 'giu');
  for (const m of line.matchAll(rx)) {
    const t = m[0];
    if (m[2]) { if (m[1]) open.pop(); else open.push(m[2].toLowerCase()); out += t; continue; }
    const w = t[0] === '&' && t.length > 1 ? 1 : t.length;
    if (n + w > max - 1) break;
    out += t; n += w;
  }
  return out + '…' + open.reverse().map((x) => `</${x}>`).join('');
}
const splitAt = () => { const v = Number(getState().tgSplitAt); return Number.isFinite(v) && v > 0 ? Math.max(MIN_SPLIT, Math.min(SPLIT_AT, v)) : SPLIT_AT; };
export function splitMessage(text, limit = splitAt()) {
  const s = safeHtml(text);
  if (tgLength(s) <= limit) return [s];
  const lines = topLevelLines(s);
  const tag = (lines[0].match(/^<b>\[[^\]]*\]<\/b>/) || ['<b>[…]</b>'])[0];
  const room = limit - 12; // the " (k/n)" label
  const parts = []; let cur = [];
  for (let l of lines) {
    l = clipLine(l, room - tgLength(tag) - 1);
    if (cur.length && tgLength([...cur, l].join('\n')) > room) { parts.push(cur); cur = [tag]; }
    cur.push(l);
  }
  parts.push(cur);
  return parts.map(([h, ...rest], i) => [`${h} (${i + 1}/${parts.length})`, ...rest].join('\n'));
}
const TOO_LONG = /message is too long/i;
async function sendPart(chatId, text, depth) {
  const json = await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: NO_PREVIEW });
  if (json?.ok || !TOO_LONG.test(json?.description || '') || depth >= 3) return { json, parts: json?.ok ? 1 : 0, failed: json?.ok ? null : json };
  // Refused although our count put it under the split point: the count is wrong for this text. Lower the
  // split point for every later message, and send THIS text as smaller parts, never as it was.
  const measured = tgLength(text), lower = Math.max(MIN_SPLIT, Math.floor(measured * 0.75));
  const st = getState();
  if (!(Number(st.tgSplitAt) <= lower)) { st.tgSplitAt = lower; save(); }
  console.error(`[telegram][OPERATOR] refused as too long at ${measured} by our count of Telegram's; re-sent in smaller parts, split point now ${lower}`);
  const smaller = splitMessage(text, lower);
  if (smaller.length === 1 && smaller[0] === safeHtml(text)) return { json, parts: 0, failed: json }; // nothing smaller to send: never resend it as it was
  let first = null, parts = 0, failed = null;
  for (const p of smaller) {
    const r = await sendPart(chatId, p, depth + 1);
    parts += r.parts; if (r.json?.ok) first ??= r.json; if (r.failed) failed = r.failed;
  }
  return { json: first ?? failed ?? json, parts, failed };
}
// Telegram's answer for the first part delivered (or the failure), ok false if any part failed, and
// `parts` = how many parts were delivered.
export async function sendTo(chatId, text) {
  let first = null, failed = null, parts = 0;
  for (const p of splitMessage(text)) {
    const r = await sendPart(chatId, p, 0);
    parts += r.parts; if (r.json?.ok) first ??= r.json; if (r.failed) failed = r.failed;
  }
  if (parts > 1) console.log(`[telegram] sent in ${parts} parts (${kindOf(text)}, ${tgLength(text)} characters by Telegram's count)`);
  return { ...(first ?? failed ?? {}), ok: !failed && !!first, parts, ...(failed ? { description: failed.description } : {}) };
}
export const kindOf = (text) => (String(text).match(/^<b>\[([^\]]+)\]<\/b>/)?.[1] ?? 'untagged message').trim();
export const UNDELIVERABLE_AFTER_MS = 3600e3;
// Pure over `map` (state.undeliverable): one delivery outcome for a message type. Returns the alert to
// send, if any: 'down' once when the type has reached no one for an hour, 'recovered' when it lands again.
export function noteDelivery(map, kind, delivered, now, error) {
  const e = map[kind];
  if (delivered) { if (!e) return null; delete map[kind]; return e.alertedAt ? { alert: 'recovered', kind, since: e.since } : { changed: true }; }
  if (!e) { map[kind] = { since: now, lastError: error || 'unknown', alertedAt: null }; return { changed: true }; }
  if (error) e.lastError = error;
  if (!e.alertedAt && now - e.since >= UNDELIVERABLE_AFTER_MS) { e.alertedAt = now; return { alert: 'down', kind, since: e.since, error: e.lastError }; }
  return null;
}
const dur = (ms) => { const m = Math.round(ms / 60e3); return m < 120 ? `${m} min` : `${(m / 60).toFixed(1)}h`; };
export const undeliverableText = (v, now) => (v.alert === 'down'
  ? `[radar] ${v.kind} messages undeliverable for ${dur(now - v.since)} (since ${new Date(v.since).toISOString().slice(0, 16)}Z): ${String(v.error).replace(/\s+/g, ' ').slice(0, 100)}`
  : `[radar] ${v.kind} messages delivered again after ${dur(now - v.since)}`);

// Returns [{chatId, messageId}] so a follow-up can EDIT this message rather than
// posting a second one (spec §5.3: one live alert per symbol per direction).
export async function broadcast(text, { toChannel = true, operatorText } = {}) {
  // Recipients: DM subscribers plus the public channel (@radaralert22) when configured.
  // The channel is the public product; SYS noise (heartbeats) stays DM-only via
  // toChannel:false so subscribers only ever see signals.
  // AUDIENCE SPLIT (message diet): the DM is the operator surface (telemetry already
  // lives there, v0.31.0). When an operatorText is supplied, DMs get it and the
  // channel gets the public text; otherwise both get the same text.
  const subs = getState().subscribers;
  const targets = [...subs];
  if (toChannel && config.telegramChannel) targets.push(config.telegramChannel);
  if (!targets.length) console.log('[telegram] no recipients — send /start or set TELEGRAM_CHANNEL');
  const textFor = (id) => (id === config.telegramChannel ? text : (operatorText ?? text));
  const results = await Promise.allSettled(targets.map((id) => sendTo(id, textFor(id))));
  const ids = [];
  results.forEach((r, i) => {
    const mid = r.status === 'fulfilled' ? r.value?.result?.message_id : null;
    if (mid) ids.push({ chatId: targets[i], messageId: mid, parts: r.value?.parts ?? 1 });
    if (mid && targets[i] === config.telegramChannel) notePublicPush();
    else if (r.status === 'fulfilled' && targets[i] === config.telegramChannel)
      console.error('[telegram][OPERATOR] channel post failed — is the bot still admin of ' + config.telegramChannel + '?');
  });
  // Aug 12 2026 CPI: the T+5m/T+30m alerts fired while the network was down. The
  // rejected sends landed in allSettled and were never looked at — the alerts were
  // marked delivered and lost. A total delivery failure must be LOUD, and callers
  // must be able to see it (empty ids with recipients configured = failed).
  if (targets.length && !ids.length) {
    console.error(`[telegram][OPERATOR] broadcast: 0/${targets.length} sends succeeded — delivery FAILED (network or Telegram down)`);
    failStreak++; failSince ||= Date.now();
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected) lastSendError = String(rejected.reason?.message || rejected.reason || 'request rejected');
    if (fallbackDecision(failStreak, lastFallbackAt)) {
      lastFallbackAt = Date.now();
      const plain = fallbackText(failStreak, failSince, lastSendError);
      const sent = await Promise.allSettled([...subs].map((id) => sendPlain(id, plain)));
      console.error(`[telegram][OPERATOR] plaintext fallback ${sent.some((r) => r.status === 'fulfilled' && r.value?.ok) ? 'DELIVERED' : 'also failed'} to the DM: "${plain}"`);
    }
  } else if (ids.length && failStreak) {
    console.log(`[telegram] delivery recovered after ${failStreak} failed broadcast(s)`);
    failStreak = 0; failSince = 0;
  }
  // Per message TYPE: reached no one for an hour -> one plain DM line, once, until it lands again.
  if (targets.length) {
    const st = getState(), now = Date.now();
    const err = results.map((r) => (r.status === 'rejected' ? String(r.reason?.message || r.reason) : r.value?.ok === false ? r.value?.description : null)).find(Boolean);
    const v = noteDelivery((st.undeliverable ??= {}), kindOf(text), ids.length > 0, now, err);
    if (v) save();
    if (v?.alert) {
      const line = undeliverableText(v, now);
      console.error(`[telegram][OPERATOR] ${line}`);
      await Promise.allSettled([...subs].map((id) => sendPlain(id, line)));
    }
  }
  return ids;
}

// PUBLIC PUSH LEDGER (v0.31.0). Telemetry now lives in the operator DM, so the
// reading rule "silence + healthy funnel = correctly quiet" applies to a channel the
// operator no longer watches for silence. The DM heartbeat carries "public pushes
// 24h: N" from this ledger — channel deliveries only, pruned to 24h, persisted.
export function notePublicPush(now = Date.now()) {
  const st = getState();
  st.publicPushes = (st.publicPushes || []).filter((t) => now - t < 86400e3);
  st.publicPushes.push(now);
}
export function publicPushes24h(now = Date.now(), st = getState()) {
  return (st.publicPushes || []).filter((t) => now - t < 86400e3).length;
}

// True when a send has someone to reach — distinguishes "delivery failed" (retry)
// from "nobody subscribed yet" (not a failure, don't retry-loop).
export function hasRecipients(toChannel = true) {
  return getState().subscribers.length > 0 || (toChannel && !!config.telegramChannel);
}

// Returns { ok, networkDown }. Fourth instance of the uninspected-allSettled class:
// a rejected edit (network down) used to be indistinguishable from Telegram refusing
// the edit (message too old), so the dispatcher logged the wrong diagnosis.
export async function editBroadcast(messageIds, text) {
  if (!messageIds?.length) return { ok: false, networkDown: false };
  // An edit cannot be split. Over the split point it is not attempted: the caller re-sends, and the
  // re-send goes in parts (a text Telegram would refuse is never sent).
  if (tgLength(text) > splitAt()) { console.log(`[telegram] edit not attempted: ${tgLength(text)} characters by Telegram's count; the caller re-sends it in parts`); return { ok: false, networkDown: false, tooLong: true }; }
  const res = await Promise.allSettled(messageIds.map(({ chatId, messageId }) =>
    tg('editMessageText', {
      chat_id: chatId, message_id: messageId, text,
      parse_mode: 'HTML', link_preview_options: NO_PREVIEW,
    })));
  const ok = res.some((r) => r.status === 'fulfilled' && r.value?.ok);
  const networkDown = !ok && res.every((r) => r.status === 'rejected');
  if (networkDown)
    console.error(`[telegram][OPERATOR] edit: all ${res.length} sends rejected — network down, update NOT delivered`);
  return { ok, networkDown };
}

async function handleUpdate(u) {
  const msg = u.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
  if (cmd === '/start') {
    const added = addSubscriber(chatId);
    await sendTo(chatId, added
      ? '✅ Subscribed to <b>Market Radar</b> alerts.\nSources: 🟢 revival · 🚀 pump · 📉 dump · 👀 volume · 🆕 listings · ⚡ funding · 🐋 whales · 🚨 rugs\n/stop unsubscribe · /status info · /stats signal scoreboard'
      : 'Already subscribed. /status for info.');
  } else if (cmd === '/stop') {
    removeSubscriber(chatId);
    await sendTo(chatId, '🛑 Unsubscribed.');
  } else if (cmd === '/stats') {
    await sendTo(chatId, statsSummary());
  } else if (cmd === '/status') {
    const s = getState();
    await sendTo(chatId, `📡 Market Radar\nSubscribers: ${s.subscribers.length}\nTokens tracked: ${Object.keys(s.baselines).length}\nPoll interval: ${config.pollIntervalSec}s`);
  }
}

export function startBot() {
  if (!config.telegramToken) { console.log('[telegram] no token — console-only mode'); return; }
  running = true;
  (async function loop() {
    while (running) {
      try {
        const res = await fetch(`${API()}/getUpdates?timeout=30&offset=${offset}`);
        const json = await res.json();
        if (json.ok) for (const u of json.result) { offset = u.update_id + 1; await handleUpdate(u); }
      } catch (e) {
        console.error('[telegram] poll error:', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  console.log('[telegram] bot polling started');
}
export function stopBot() { running = false; }
