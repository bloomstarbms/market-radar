// Simple JSON persistence: subscribers, per-token baselines, alert cooldowns.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const FILE = join(config.dataDir, 'state.json');
let state = { subscribers: [], baselines: {}, lastAlert: {} };

export function load() {
  mkdirSync(config.dataDir, { recursive: true });
  if (existsSync(FILE)) state = { ...state, ...JSON.parse(readFileSync(FILE, 'utf8')) };
  return state;
}
export function save() { writeFileSync(FILE, JSON.stringify(state, null, 2)); }
export function getState() { return state; }

export function addSubscriber(chatId) {
  if (!state.subscribers.includes(chatId)) { state.subscribers.push(chatId); save(); return true; }
  return false;
}
export function removeSubscriber(chatId) {
  const i = state.subscribers.indexOf(chatId);
  if (i >= 0) { state.subscribers.splice(i, 1); save(); return true; }
  return false;
}
export function onCooldown(key, minutes) {
  const last = state.lastAlert[key] || 0;
  return Date.now() - last < minutes * 60_000;
}
export function markAlerted(key) { state.lastAlert[key] = Date.now(); save(); }
