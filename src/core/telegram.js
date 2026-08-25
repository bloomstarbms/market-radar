// Zero-dependency Telegram bot: long-polling for commands, broadcast for alerts.
import { config } from '../config.js';
import { addSubscriber, removeSubscriber, getState } from './store.js';
import { statsSummary } from './outcomes.js';

const API = () => `https://api.telegram.org/bot${config.telegramToken}`;
let offset = 0;
let running = false;

async function tg(method, payload) {
  const res = await fetch(`${API()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) console.error(`[telegram] ${method} failed:`, json.description);
  return json;
}

export async function sendTo(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

// Returns [{chatId, messageId}] so a follow-up can EDIT this message rather than
// posting a second one (spec §5.3: one live alert per symbol per direction).
export async function broadcast(text, { toChannel = true } = {}) {
  // Recipients: DM subscribers plus the public channel (@radaralert22) when configured.
  // The channel is the public product; SYS noise (heartbeats) stays DM-only via
  // toChannel:false so subscribers only ever see signals.
  const subs = getState().subscribers;
  const targets = [...subs];
  if (toChannel && config.telegramChannel) targets.push(config.telegramChannel);
  if (!targets.length) console.log('[telegram] no recipients — send /start or set TELEGRAM_CHANNEL');
  const results = await Promise.allSettled(targets.map((id) => sendTo(id, text)));
  const ids = [];
  results.forEach((r, i) => {
    const mid = r.status === 'fulfilled' ? r.value?.result?.message_id : null;
    if (mid) ids.push({ chatId: targets[i], messageId: mid });
    else if (r.status === 'fulfilled' && targets[i] === config.telegramChannel)
      console.error('[telegram][OPERATOR] channel post failed — is the bot still admin of ' + config.telegramChannel + '?');
  });
  // Aug 12 2026 CPI: the T+5m/T+30m alerts fired while the network was down. The
  // rejected sends landed in allSettled and were never looked at — the alerts were
  // marked delivered and lost. A total delivery failure must be LOUD, and callers
  // must be able to see it (empty ids with recipients configured = failed).
  if (targets.length && !ids.length)
    console.error(`[telegram][OPERATOR] broadcast: 0/${targets.length} sends succeeded — delivery FAILED (network or Telegram down)`);
  return ids;
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
