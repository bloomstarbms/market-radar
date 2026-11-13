// MACRO FORECASTS — the consensus figure a release is read against (operator decisions,
// 2026-11-11/12).
//
// SOURCE. ForexFactory's weekly calendar file, the one free source that answered from the
// VPS on 2026-11-11 (Trading Economics' guest account is discontinued; Nasdaq timed out;
// FXStreet, TradingView, Investing and MarketWatch refuse a plain request). It is named in
// the message as "forecast: ForexFactory". It carries the CURRENT week only (the
// next-week file is a 404), a forecast and a previous per event, and no actual.
//
// TIMING. The forecast is saved ONCE, in the hour before the release, into state, stamped
// with when it was taken. The message reads only that snapshot. A snapshot taken at or
// after the release time is refused twice over: buildSnapshot will not make one, and
// usableForecast will not read one. Nothing is filled in afterwards. A series that
// normally has a forecast and has none in the snapshot renders "forecast: not available".
//
// MATCHING. Each forecast maps to ONE series the bot reports, by country AND title (the
// same file holds a Swiss "PPI m/m"), and the row must sit at the release time. No row, two
// rows, or a value that is not a plain percentage: that series gets no forecast. The
// previous figure is never taken from here; it comes from BLS, revisions included.
//
// Enabled kinds: CPI and PPI, monthly lines (verified 2026-11-13: the file's "previous"
// for all four rows equals the BLS-derived prior month). Yearly lines carry no forecast.
// NFP, PCE and the Fed are added only after their week's file has been read and reported.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) market-radar (+https://github.com/bloomstarbms/market-radar)';
export const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
export const FORECAST_SOURCE = 'ForexFactory';
export const SNAPSHOT_LEAD_MS = 60 * 60e3;   // the snapshot window opens at T-60m and closes at the release
export const SNAPSHOT_RETRY_MS = 5 * 60e3;   // a failed fetch is retried at most this often inside the window
export const ROW_TIME_SLACK_MS = 10 * 60e3;  // a matching row must sit within this of the release time
// kind -> series key (the keys of figures.js's rows) -> the ONE ForexFactory row it maps to.
export const FORECAST_MAP = {
  CPI: { headline_mm: { country: 'USD', title: 'CPI m/m' }, core_mm: { country: 'USD', title: 'Core CPI m/m' } },
  PPI: { headline_mm: { country: 'USD', title: 'PPI m/m' }, core_mm: { country: 'USD', title: 'Core PPI m/m' } },
};
const PERCENT = /^-?\d+(?:\.\d+)?%$/;

// Pure: the forecasts for one release out of a weekly list. Never guesses: a series with
// no row, more than one row, or an unreadable value is left out and named in `problems`.
export function pickForecasts(kind, events, t0) {
  const items = {}, problems = [];
  for (const [key, want] of Object.entries(FORECAST_MAP[kind] ?? {})) {
    const rows = (Array.isArray(events) ? events : []).filter((e) => e?.country === want.country && e?.title === want.title
      && Math.abs(Date.parse(e.date) - t0) <= ROW_TIME_SLACK_MS);
    if (rows.length === 0) { problems.push(`${key}: no ${want.country} "${want.title}" row at the release time`); continue; }
    if (rows.length > 1) { problems.push(`${key}: ${rows.length} ${want.country} "${want.title}" rows at the release time (ambiguous)`); continue; }
    const raw = String(rows[0].forecast ?? '').trim();
    if (!PERCENT.test(raw)) { problems.push(`${key}: forecast "${raw}" is not a plain percentage`); continue; }
    items[key] = { forecast: Number(raw.slice(0, -1)), raw, title: want.title, country: want.country };
  }
  return { items, problems };
}

// Pure: the record that goes into state. Refuses to exist at or after the release.
export function buildSnapshot(kind, events, t0, takenAt) {
  if (!(takenAt < t0)) return { status: 'refused', why: `taken ${new Date(takenAt).toISOString().slice(0, 16)}Z, at or after the ${new Date(t0).toISOString().slice(0, 16)}Z release`, takenAt: new Date(takenAt).toISOString() };
  const { items, problems } = pickForecasts(kind, events, t0);
  return { status: 'ok', kind, source: FORECAST_SOURCE, takenAt: new Date(takenAt).toISOString(), items, problems };
}

// Pure, and the ONLY reader a message uses: the snapshot's items, or null. A record whose
// stamp is not strictly before the release is not a forecast, whatever its status says.
export function usableForecast(snap, t0) {
  if (snap?.status !== 'ok' || !snap.takenAt) return null;
  const at = Date.parse(snap.takenAt);
  return Number.isFinite(at) && at < t0 ? (snap.items ?? {}) : null;
}

// One fetch of the weekly file. deps: { fetchImpl, now }. Never throws.
export async function takeSnapshot(ev, t0, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now();
  if (!(now < t0)) return buildSnapshot(ev.kind, [], t0, now);
  try {
    const r = await fetchImpl(FF_URL, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const events = await r.json();
    if (!Array.isArray(events)) throw new Error('not a list');
    // Stamped with when the fetch STARTED: the earlier of the two times, so a slow answer
    // that straddles the release is not passed off as taken before it.
    return buildSnapshot(ev.kind, events, t0, now);
  } catch (e) {
    return { status: 'failed', why: `fetch failed: ${String(e.message).slice(0, 60)}`, takenAt: new Date(now).toISOString() };
  }
}

// Pure: is a snapshot attempt due this poll? Inside the window, no good snapshot yet, and
// not tried within SNAPSHOT_RETRY_MS.
export function snapshotDue(ev, rec, t0, now) {
  return !!FORECAST_MAP[ev.kind] && now >= t0 - SNAPSHOT_LEAD_MS && now < t0 && rec.forecast?.status !== 'ok'
    && now - (rec.forecastTriedAt ?? 0) >= SNAPSHOT_RETRY_MS;
}

// The heartbeat's line: which releases get a forecast, from where, and the last snapshot.
export function forecastStatus(st, now = Date.now()) {
  const recs = Object.entries(st?.macro ?? {}).filter(([, r]) => r?.forecast?.takenAt).map(([id, r]) => ({ id, ...r.forecast }))
    .sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt));
  const last = recs[0];
  const kinds = Object.keys(FORECAST_MAP);
  const tail = !last ? 'no snapshot taken yet'
    : last.status === 'ok' ? `last snapshot ${last.id} at ${last.takenAt.slice(0, 16)}Z: ${Object.keys(last.items ?? {}).length} of ${Object.keys(FORECAST_MAP[last.kind] ?? {}).length} series${last.problems?.length ? ` · ⚠️ ${last.problems.join('; ')}` : ''}`
    : `⚠️ last snapshot ${last.id} at ${last.takenAt.slice(0, 16)}Z ${last.status}: ${last.why}`;
  return { line: `Macro forecasts: ${kinds.join(' · ')} monthly lines from ${FORECAST_SOURCE}, saved once at T-60m · ${tail}`, last: last ?? null, now };
}
