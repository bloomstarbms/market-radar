// Zero-dependency Telegram bot: long-polling for commands, broadcast for alerts.
import { config } from '../config.js';
import { addSubscriber, removeSubscriber, getState } from './store.js';
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
async function sendPlain(chatId, text) { return tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }); } // no parse_mode: nothing to parse

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

export async function sendTo(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

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
    if (mid) ids.push({ chatId: targets[i], messageId: mid });
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
  const res = await Promise.allSettled(messageIds.map(({ chatId, messageId }) =>
    tg('editMessageText', {
      chat_id: chatId, message_id: messageId, text,
      parse_mode: 'HTML', disable_web_page_preview: true,
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
