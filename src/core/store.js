// Simple JSON persistence: subscribers, per-token baselines, alert cooldowns.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const FILE = join(config.dataDir, 'state.json');
let state = { subscribers: [], baselines: {}, lastAlert: {} };

export function load() {
  mkdirSync(config.dataDir, { recursive: true });
  if (existsSync(FILE)) state = { ...state, ...JSON.parse(readFileSync(FILE, 'utf8')) };
  return state;
}
// OneDrive scans the folder and briefly locks state.json, which makes a plain write
// throw EBUSY and abort the whole poll. Write to a temp file, then swap it in; if the
// swap is blocked, retry a few times and give up quietly — state is rewritten constantly.
export function save() {
  // PER-PROCESS temp name. A FIXED `.tmp` meant any second writer — a replay script,
  // a fixture, a second bot instance after a bad restart — shared one scratch file
  // with the running bot: process A writes tmp, process B writes the same tmp and
  // renames it away, and A's rename throws ENOENT with a half-written state on disk.
  // Observed as a suite crash on 17 Aug while the bot was live. Unique names make
  // concurrent writers independent, and rename stays atomic per writer.
  const tmp = `${FILE}.${process.pid}.tmp`;
  const body = JSON.stringify(state, null, 2);
  for (let i = 0; i < 4; i++) {
    try { writeFileSync(tmp, body); renameSync(tmp, FILE); return; }
    catch (e) {
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); // brief sync pause
    }
  }
}
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
// Escalating cooldown: repeat alerts for the same key within 6h double the wait
// each time (30m, 1h, 2h, 4h — capped 8x). First alerts are never delayed.
export function onCooldown(key, minutes) {
  const e = state.lastAlert[key];
  if (!e) return false;
  const ts = typeof e === 'number' ? e : e.ts;
  const n = typeof e === 'number' ? 1 : e.n;
  const mult = Math.min(2 ** (n - 1), 8);
  return Date.now() - ts < minutes * mult * 60_000;
}
export function markAlerted(key) {
  const prev = state.lastAlert[key];
  const prevTs = typeof prev === 'number' ? prev : prev?.ts;
  const prevN = typeof prev === 'number' ? 1 : prev?.n || 0;
  const n = prevTs && Date.now() - prevTs < 6 * 3600e3 ? prevN + 1 : 1;
  state.lastAlert[key] = { ts: Date.now(), n };
  save();
}
