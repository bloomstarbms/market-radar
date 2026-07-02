// Single alert dispatcher. Every source (DEX, CEX) sends alerts through here.
// alert = { source:'DEX'|'CEX', type, severity:'LOW'|'MEDIUM'|'HIGH', title, lines:[], url }
import { config } from '../config.js';
import { broadcast } from './telegram.js';
import { onCooldown, markAlerted } from './store.js';

const SEV = { LOW: '🟡', MEDIUM: '🟠', HIGH: '🔴' };
const TAG = { DEX: '🟢 DEX REVIVAL', CEX: '🟠 CEX PUMP' };

export function formatAlert(a) {
  const head = `${SEV[a.severity]} <b>[${TAG[a.source]}]</b> ${a.title}`;
  const body = a.lines.map((l) => `• ${l}`).join('\n');
  const link = a.url ? `\n<a href="${a.url}">chart</a>` : '';
  return `${head}\n${body}${link}`;
}

export async function dispatch(alert) {
  const key = `${alert.source}:${alert.key}`;
  if (onCooldown(key, config.cooldownMin)) return false;
  const text = formatAlert(alert);
  console.log(`\n[ALERT] ${text.replace(/<[^>]+>/g, '')}\n`);
  if (config.telegramToken) await broadcast(text);
  markAlerted(key);
  return true;
}
