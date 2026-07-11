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

export async function broadcast(text) {
  const subs = getState().subscribers;
  if (!subs.length) console.log('[telegram] no subscribers yet — send /start to the bot');
  await Promise.allSettled(subs.map((id) => sendTo(id, text)));
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
