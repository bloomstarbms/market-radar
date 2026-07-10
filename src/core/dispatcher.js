// Single alert dispatcher. Every source (DEX, CEX, CHAIN) sends alerts through here.
// alert = { source, type, severity:'LOW'|'MEDIUM'|'HIGH', key, title, lines:[], url }
import { config } from '../config.js';
import { broadcast } from './telegram.js';
import { onCooldown, markAlerted } from './store.js';

const SEV = { LOW: '🟡', MEDIUM: '🟠', HIGH: '🔴' };
const TAG = {
  'DEX:REVIVAL': '🟢 DEX REVIVAL',
  'CEX:PUMP': '🚀 CEX PUMP',
  'CEX:DUMP': '📉 CEX SELL-OFF',
  'CEX:VOLUME': '👀 UNUSUAL VOLUME',
  'CHAIN:WHALE': '🐋 WHALE MOVE',
};

export function formatAlert(a) {
  const tag = TAG[`${a.source}:${a.type}`] || `${a.source} ${a.type}`;
  const head = `${SEV[a.severity]} <b>[${tag}]</b> ${a.title}`;
  const body = a.lines.map((l) => `• ${l}`).join('\n');
  const link = a.url ? `\n<a href="${a.url}">chart</a>` : '';
  return `${head}\n${body}${link}`;
}

export async function dispatch(alert) {
  const key = `${alert.source}:${alert.type}:${alert.key}`;
  if (onCooldown(key, config.cooldownMin)) return false;
  const text = formatAlert(alert);
  console.log(`\n[ALERT] ${text.replace(/<[^>]+>/g, '')}\n`);
  if (config.telegramToken) await broadcast(text);
  markAlerted(key);
  return true;
}
