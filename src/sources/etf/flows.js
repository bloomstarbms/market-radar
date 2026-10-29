// US SPOT ETF NET FLOWS (v0.37.0) — one daily FACT for the previous US trading day.
//
// Source: SoSoValue's official API (key SOSOVALUE_KEY; 100,000 requests a month, 20 a minute).
//   GET /etfs?symbol=BTC|ETH|SOL&country_code=US        the funds (32 on 2026-10-29: 12 BTC, 11 ETH, 9 SOL; read daily, never assumed)
//   GET /etfs/{ticker}/history?start_date&end_date      each fund's daily net inflow in USD
// A day's row exists while the session runs with net_inflow NULL; it settles T+1 (2026-10-28
// had fully settled by 09:52 UTC the next morning). NULL is "not yet reported", never zero; a
// real zero is 0. Per-fund figures add up to SoSoValue's own total (BTC 28 Oct: IBIT
// 136,009,040 + BITB 1,321,258.95 = 137,330,298.95, the summary's total_net_inflow).
//
// The message: one per US trading day, for that day, sent once every fund has reported or at
// the morning deadline with "Not yet reported: N funds"; later reports EDIT it (never a second
// message) until the next session's close. No session (weekend, NYSE holiday) -> no message.
// History only goes back a month: days the bot missed while down are recorded as missing on
// the heartbeat and never filled in as zero; nothing is sent late for them.
import { config } from '../../config.js';
import { dispatch, formatAlert } from '../../core/dispatcher.js';
import { getThread } from '../../core/budget.js';
import { editBroadcast } from '../../core/telegram.js';
import { getState, save } from '../../core/store.js';
import { proseProblems } from '../../core/prose-lint.js';
import { etToUtc } from '../calendar/macro.js';

export const API = 'https://openapi.sosovalue.com/openapi/v1';
export const ASSETS = ['BTC', 'ETH', 'SOL'];
export const CALL_SPACING_MS = 3200;          // documented 20 requests/minute; no rate-limit headers are returned
export const POLL_EVERY_MS = 30 * 60e3;       // within the day's window
export const WINDOW_OPENS_ET = '17:00';       // day D, an hour after the 16:00 ET close
export const SEND_BY_ET = '08:00';            // day D+1: send by then with what has reported
export const RECHECK_UNTIL_ET = '16:00';      // day D+1: edits stop at the next close
export const HISTORY_WINDOW_DAYS = 30;        // the API's history range: "the most recent 1 month"
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoDate, n) => iso(new Date(Date.parse(isoDate + 'T12:00:00Z') + n * 86400e3));

// ---------------------------------------------------------------- the NYSE calendar, pure
function easter(y) { // Anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(Date.UTC(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1));
}
const nth = (y, month, dow, n) => { const d = new Date(Date.UTC(y, month, 1)); while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1); d.setUTCDate(d.getUTCDate() + 7 * (n - 1)); return d; };
const last = (y, month, dow) => { const d = new Date(Date.UTC(y, month + 1, 0)); while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() - 1); return d; };
const observed = (d, { satToFri = true } = {}) => { const w = d.getUTCDay(); if (w === 6) return satToFri ? new Date(d.getTime() - 86400e3) : null; if (w === 0) return new Date(d.getTime() + 86400e3); return d; };
export function nyseHolidays(y) {
  const out = [
    observed(new Date(Date.UTC(y, 0, 1)), { satToFri: false }), // New Year's: a Saturday 1 Jan is not observed on 31 Dec
    nth(y, 0, 1, 3), nth(y, 1, 1, 3),                             // Martin Luther King Jr., Washington's Birthday
    new Date(easter(y).getTime() - 2 * 86400e3),                  // Good Friday
    last(y, 4, 1),                                                // Memorial Day
    ...(y >= 2022 ? [observed(new Date(Date.UTC(y, 5, 19)))] : []), // Juneteenth
    observed(new Date(Date.UTC(y, 6, 4))), nth(y, 8, 1, 1),       // Independence Day, Labor Day
    nth(y, 10, 4, 4), observed(new Date(Date.UTC(y, 11, 25))),    // Thanksgiving, Christmas
  ].filter(Boolean).map(iso);
  return new Set(out);
}
export function isTradingDay(isoDate) {
  const d = new Date(isoDate + 'T12:00:00Z'), w = d.getUTCDay();
  return w !== 0 && w !== 6 && !nyseHolidays(d.getUTCFullYear()).has(isoDate);
}
export const prevTradingDay = (isoDate) => { let d = addDays(isoDate, -1); while (!isTradingDay(d)) d = addDays(d, -1); return d; };
// Pure: the trading day whose window is open at `now`, or null. Window: D 17:00 ET to D+1 16:00 ET.
export function activeDay(now) {
  for (let back = 0; back <= 4; back++) {
    const D = addDays(iso(new Date(now)), -back);
    if (!isTradingDay(D)) continue;
    const opens = etToUtc(D, WINDOW_OPENS_ET), closes = etToUtc(addDays(D, 1), RECHECK_UNTIL_ET);
    if (now >= opens && now < closes) return { D, opens, sendBy: etToUtc(addDays(D, 1), SEND_BY_ET), closes };
  }
  return null;
}

// ---------------------------------------------------------------- figures, pure
const rowsOf = (j) => (Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : []);
// One fund on day D: reported (a number, 0 included), pending (row with null, or no row yet while
// the fund has earlier rows), or excluded (no row on or before D: not trading yet that day).
export function fundOnDay(ticker, historyJson, D) {
  const rows = rowsOf(historyJson);
  const row = rows.find((r) => r.date === D);
  if (row && row.net_inflow !== null && row.net_inflow !== undefined && Number.isFinite(Number(row.net_inflow))) return { ticker, status: 'reported', usd: Number(row.net_inflow) };
  if (row) return { ticker, status: 'pending' };
  return rows.some((r) => r.date < D) ? { ticker, status: 'pending' } : { ticker, status: 'excluded' };
}
export function assetDay(asset, funds) {
  const live = funds.filter((f) => f.status !== 'excluded');
  const rep = live.filter((f) => f.status === 'reported');
  const net = rep.reduce((s, f) => s + f.usd, 0);
  const inn = rep.filter((f) => f.usd > 0).sort((a, b) => b.usd - a.usd)[0] ?? null;
  const out = rep.filter((f) => f.usd < 0).sort((a, b) => a.usd - b.usd)[0] ?? null;
  return { asset, funds: live.length, reported: rep.length, pending: live.filter((f) => f.status === 'pending').map((f) => f.ticker), net, inn, out };
}
const MINUS = '−';
export function money(x) {
  const a = Math.abs(x), s = x > 0 ? '+' : x < 0 ? MINUS : '';
  const v = a >= 1e9 ? `$${(a / 1e9).toFixed(2)}B` : a >= 1e7 ? `$${Math.round(a / 1e6)}M` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}K` : `$${Math.round(a)}`;
  return s + v;
}
export function dayLabel(D) { const d = new Date(D + 'T12:00:00Z'); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONS[d.getUTCMonth()]}`; }
// Pure: the message for day D from per-asset tables. An asset with no fund trading that day is
// left out; an asset whose funds trade but none has reported says so.
export function flowsMessage(D, days) {
  const lines = [];
  for (const a of days) {
    if (!a.funds) continue;
    if (!a.reported) { lines.push(`${a.asset}: no fund reported yet`); continue; }
    lines.push([`${a.asset}: ${money(a.net)} net`, ...(a.inn ? [`largest in ${a.inn.ticker} ${money(a.inn.usd)}`] : []), ...(a.out ? [`largest out ${a.out.ticker} ${money(a.out.usd)}`] : [])].join(' · '));
  }
  const pending = days.flatMap((a) => a.pending);
  if (pending.length) lines.push(`Not yet reported: ${pending.length} fund${pending.length === 1 ? '' : 's'}`);
  lines.push('Source: SoSoValue');
  return { title: dayLabel(D), lines, operatorLines: [`${D} · ${days.map((a) => `${a.asset} ${a.reported}/${a.funds} reported`).join(' · ')}${pending.length ? ` · pending ${pending.join(', ')}` : ''}`], pending: pending.length };
}
export const flowsProblems = (m) => [m.title, ...m.lines].flatMap((l) => proseProblems(l));
// Pure: the trading days between the last day handled and D (exclusive), split by whether the API
// still holds them. Neither kind is sent late; both are reported as missing, never as zero.
export function missedDays(lastDay, D, today) {
  if (!lastDay || lastDay >= D) return [];
  const out = [];
  for (let d = addDays(lastDay, 1); d < D; d = addDays(d, 1)) {
    if (!isTradingDay(d)) continue;
    const ageDays = (Date.parse(today + 'T12:00:00Z') - Date.parse(d + 'T12:00:00Z')) / 86400e3;
    out.push({ day: d, why: ageDays > HISTORY_WINDOW_DAYS ? 'beyond the 1-month history: missing' : 'bot was down: not messaged' });
  }
  return out;
}

// ---------------------------------------------------------------- the cycle, edges injectable
async function defaultFetchJson(path, key) {
  const r = await fetch(API + path, { headers: { 'x-soso-api-key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  let j = null; try { j = await r.json(); } catch { /* the status decides */ }
  return { status: r.status, json: j };
}
const classify = (r) => (r.status === 401 || r.status === 403 ? { ok: false, kind: 'key', msg: `HTTP ${r.status} ${String(r.json?.message ?? '').slice(0, 60)}` }
  : r.status !== 200 ? { ok: false, kind: 'http', msg: `HTTP ${r.status}` }
  : r.json?.code !== 0 && r.json?.code !== undefined ? { ok: false, kind: 'api', msg: `code ${r.json.code} ${String(r.json.message ?? '').slice(0, 60)}` } : { ok: true });
async function defaultEdit(dedupeKey, text) {
  const th = getThread({ dedupeKey, type: 'FLOWS' });
  if (!config.telegramToken || !th?.messageIds?.length) return false;
  const res = await editBroadcast(th.messageIds, text);
  if (res.ok) { th.lastText = text; save(); return true; }
  return false;
}
// deps: { key, now, fetchJson, sleep, dispatch, edit, dm }
export async function flowsCycle(state, deps = {}) {
  const e = (state.etfFlows ??= { days: {}, missed: [] });
  e.days ??= {}; e.missed ??= [];
  const now = deps.now ?? Date.now();
  if (!deps.key) return { status: 'off', why: 'no SOSOVALUE_KEY' };
  const win = activeDay(now);
  if (!win) return { status: 'idle', why: 'no US trading day window open' };
  const { D } = win;
  const rec = (e.days[D] ??= { status: 'open' });
  if (rec.status === 'final') return { status: 'final', D };
  // Days skipped while the bot was down: recorded once, never filled in.
  if (!rec.missedChecked) {
    const m = missedDays(e.lastDay, D, iso(new Date(now)));
    if (m.length) { e.missed = [...e.missed, ...m.map((x) => ({ ...x, at: now }))].slice(-60); console.error(`[OPERATOR][etf-flows] ${m.length} trading day(s) not messaged: ${m.map((x) => `${x.day} (${x.why})`).join(', ')}`); }
    rec.missedChecked = true; e.lastDay = D;
  }
  const fetchJson = deps.fetchJson ?? defaultFetchJson, sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let calls = 0;
  const get = async (path) => { if (calls++) await sleep(CALL_SPACING_MS); try { const r = await fetchJson(path, deps.key); const c = classify(r); return c.ok ? { ok: true, json: r.json } : c; } catch (err) { return { ok: false, kind: 'network', msg: String(err.message).slice(0, 60) }; } };
  const fail = (c) => { e.lastError = { at: now, kind: c.kind, msg: c.msg }; e.failingSince ??= now; return { status: 'failed', D, why: c.msg, calls }; };
  // The fund lists, once per day handled.
  if (!rec.lists) {
    const lists = {};
    for (const a of ASSETS) { const r = await get(`/etfs?symbol=${a}&country_code=US`); if (!r.ok) return fail(r); lists[a] = rowsOf(r.json).map((x) => x.ticker).filter(Boolean); }
    rec.lists = lists;
  }
  // Each fund not yet reported for D (a reported figure is final).
  rec.funds ??= {};
  for (const a of ASSETS) for (const t of rec.lists[a]) {
    if (rec.funds[t]?.status === 'reported' || rec.funds[t]?.status === 'excluded') continue;
    const r = await get(`/etfs/${encodeURIComponent(t)}/history?start_date=${addDays(D, -7)}&end_date=${D}`);
    if (!r.ok) { if (r.kind === 'key') return fail(r); rec.funds[t] = { ticker: t, status: 'pending', why: r.msg }; continue; }
    rec.funds[t] = { ...fundOnDay(t, r.json, D), asset: a };
  }
  e.lastOkAt = now; e.failingSince = null; e.lastError = null;
  const days = ASSETS.map((a) => assetDay(a, rec.lists[a].map((t) => rec.funds[t] ?? { ticker: t, status: 'pending' })));
  // No fund of any asset has a row for D: no session after all (an unscheduled closure).
  if (now >= win.sendBy && days.every((a) => a.funds === 0)) { rec.status = 'final'; rec.why = 'no fund has a row for this day: no session'; return { status: 'no-session', D, calls }; }
  const msg = flowsMessage(D, days);
  const probs = flowsProblems(msg);
  if (probs.length) { console.error(`[OPERATOR][etf-flows] ${D} message refused by the prose lint: ${probs.join('; ')}`); return { status: 'refused', D, calls }; }
  const allIn = msg.pending === 0 && days.some((a) => a.reported);
  const send = deps.dispatch ?? dispatch, edit = deps.edit ?? defaultEdit;
  const dedupeKey = `ETFFLOWS:${D}`;
  const out = { status: 'waiting', D, calls, pending: msg.pending, sent: false, edited: false };
  if (!rec.sentAt) {
    if (allIn || (now >= win.sendBy && days.some((a) => a.reported))) {
      if (await send({ source: 'ETF', type: 'FLOWS', severity: 'MEDIUM', kind: 'FACT', key: `flows:${D}`, dedupeKey, cooldownMin: 20 * 60, ...msg })) {
        rec.sentAt = now; rec.lines = msg.lines; out.sent = true; out.status = 'sent';
      }
    }
  } else if (JSON.stringify(msg.lines) !== JSON.stringify(rec.lines)) {
    // A fund that posts late REPLACES its line in the original message: an edit, never a second message.
    if (await edit(dedupeKey, formatAlert({ source: 'ETF', type: 'FLOWS', ...msg }, { kind: 'FACT' }, 'public'))) { rec.lines = msg.lines; rec.editedAt = now; out.edited = true; out.status = 'edited'; }
  } else out.status = 'unchanged';
  if (rec.sentAt && msg.pending === 0) { rec.status = 'final'; }
  if (now >= win.closes - POLL_EVERY_MS && rec.sentAt) rec.status = 'final';
  rec.pending = msg.pending;
  return out;
}

// ---------------------------------------------------------------- heartbeat line, pure when deps are injected
export function flowsStatus(state, now = Date.now(), deps = {}) {
  const key = deps.key ?? config.sosovalueKey;
  if (!key) return { line: 'ETF flows: OFF (no SOSOVALUE_KEY in .env)' };
  const e = state.etfFlows ?? {};
  const sent = Object.entries(e.days ?? {}).filter(([, r]) => r.sentAt).sort().at(-1);
  const parts = [`ETF flows (SoSoValue): ${sent ? `last message ${dayLabel(sent[0])}${sent[1].pending ? ` · ${sent[1].pending} fund(s) still not reported` : ' · all funds reported'}` : 'no message yet'}`];
  if (e.failingSince) parts.push(`🚨 source failing since ${new Date(e.failingSince).toISOString().slice(0, 16)}Z (${e.lastError?.kind}: ${e.lastError?.msg}): silent, not "no flows"`);
  const missed = (e.missed ?? []).filter((x) => now - x.at < 7 * 86400e3);
  if (missed.length) parts.push(`⚠️ ${missed.length} trading day(s) not messaged: ${missed.map((x) => `${x.day} (${x.why})`).join(', ')}`);
  return { line: parts.join(' · ') };
}

// ---------------------------------------------------------------- the poller (own timer: ~35 spaced calls must not stall the 60 s loop)
let timer = null, running = false;
export async function pollEtfFlows() {
  const key = config.sosovalueKey;
  if (!key) return;
  const st = getState(); const e = (st.etfFlows ??= { days: {}, missed: [] });
  if (Date.now() - (e.lastAttemptAt ?? 0) < POLL_EVERY_MS) return;
  if (!activeDay(Date.now())) return;
  e.lastAttemptAt = Date.now();
  const r = await flowsCycle(st, { key });
  save();
  if (r.status !== 'idle' && r.status !== 'final') console.log(`[etf-flows] ${r.D}: ${r.status}${r.pending !== undefined ? ` · ${r.pending} pending` : ''}${r.why ? ` · ${r.why}` : ''} · ${r.calls ?? 0} call(s)`);
}
export function startEtfFlows(checkEveryMs = 5 * 60e3) {
  if (timer) return timer;
  const tick = () => { if (running) return; running = true; pollEtfFlows().catch((err) => console.error('[etf-flows] cycle failed:', err.message)).finally(() => { running = false; }); };
  tick();
  timer = setInterval(tick, checkEveryMs); timer.unref?.();
  console.log(`[etf-flows] ${config.sosovalueKey ? `daily, for each US trading day: window ${WINDOW_OPENS_ET} ET to ${RECHECK_UNTIL_ET} ET next day, sent by ${SEND_BY_ET} ET` : 'OFF (no SOSOVALUE_KEY)'}`);
  return timer;
}
