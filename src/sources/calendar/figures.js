// MACRO FIGURES (v0.36.0) — the outcome beside the reaction.
//
// Every figure is READ from its publisher and PARSED. A figure that is published but does
// not parse says exactly that, with the link; a figure that is not out says it is not out.
// Nothing here estimates, interpolates or fills a gap: "never guess".
//
//   Federal Reserve rate decision   federalreserve.gov press feed -> the statement page (keyless)
//   CPI · Non-Farm Payrolls · PPI   api.bls.gov v2 timeseries (keyless, 25 queries a day)
//   PCE                             apps.bea.gov API with BEA_API_KEY (free registration);
//                                   without a key it is not fetched, and the heartbeat says why
//
// CORRECTION (2026-10-29): the 2026-10-04 notes recorded that FOMC "has no keyless source".
// It has one: the Fed's monetary press feed lists "Federal Reserve issues FOMC statement" at
// 14:00 ET and the statement page carries the decision sentence, the vote count and each
// dissent's stated preference. Both answered from the VPS on IPv4 and IPv6 (2026-10-29).
import { config } from '../../config.js';

export const FED_FEED = 'https://www.federalreserve.gov/feeds/press_monetary.xml';
export const BLS_API = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
export const BEA_API = 'https://apps.bea.gov/api/data/';
export const BLS_DAILY_QUERIES = 25; // keyless v2 limit
export const BLS_SERIES = {
  NFP: ['CES0000000001', 'LNS14000000'], // total nonfarm (level, thousands) · unemployment rate
  CPI: ['CUSR0000SA0', 'CUUR0000SA0'],   // all items: seasonally adjusted (month) · not adjusted (year)
  PPI: ['WPSFD4', 'WPUFD4'],             // final demand: seasonally adjusted (month) · not adjusted (year)
};
const UA = 'Mozilla/5.0 (X11; Linux x86_64) market-radar (+https://github.com/bloomstarbms/market-radar)';
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

// ---------------------------------------------------------------- Federal Reserve, pure
const decode = (s) => String(s).replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—').replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&#39;|&rsquo;|&#8217;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
export function statementText(html) {
  return decode(String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
}
// The Fed writes rates as "3-3/4", "4", "1/4" or "3.75". Anything else is not a number here.
export function fedNumber(s) {
  const m = String(s).trim().match(/^(\d+)(?:-(\d+)\/(\d+))?$|^(\d+)\/(\d+)$|^(\d+\.\d+)$/);
  if (!m) return null;
  if (m[1] !== undefined) return Number(m[1]) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
  if (m[4] !== undefined) return Number(m[4]) / Number(m[5]);
  return Number(m[6]);
}
const NUM = String.raw`\d+-\d+\/\d+|\d+\/\d+|\d+\.\d+|\d+`;
// Pure: { decision: {action, lo, hi} | null, vote: {for, against} | null, dissents: [{n, action, by}] | null, problems: [] }
export function parseFomcStatement(html) {
  const t = statementText(html);
  const out = { decision: null, vote: null, dissents: null, problems: [] };
  const d = t.match(new RegExp(String.raw`decided to (maintain|raise|lower) the target range for the federal funds rate (?:at|to) (${NUM}) to (${NUM}) percent`));
  if (d) {
    const lo = fedNumber(d[2]), hi = fedNumber(d[3]);
    if (lo !== null && hi !== null && lo < hi) out.decision = { action: d[1], lo, hi };
    else out.problems.push('target range did not read as two numbers');
  } else out.problems.push('decision sentence not found');
  const v = t.match(/by a (\d{1,2})\s*[–-]\s*(\d{1,2}) vote/);
  if (v) out.vote = { for: Number(v[1]), against: Number(v[2]) };
  else out.problems.push('vote count not found');
  // "Voting against the monetary policy action were Lisa D. Cook and Beth M. Hammack, who preferred to
  // raise the target range for the federal funds rate by 1/4 percentage point at this meeting."
  // One "who preferred" clause covers every name before it; clauses for different preferences are
  // separated by ";". The names are counted and the count must equal the vote's minority.
  const i = t.search(/Voting against (?:the|this) (?:monetary policy )?action (?:were|was) /);
  if (i >= 0) {
    let seg = t.slice(i).replace(/^Voting against (?:the|this) (?:monetary policy )?action (?:were|was) /, '');
    const end = seg.search(/\s(?:For media inquiries|Implementation Note|Last Update)/);
    if (end > 0) seg = seg.slice(0, end);
    const groups = [];
    for (const clause of seg.split(/;\s*(?:and\s+)?/)) {
      const c = clause.trim().replace(/\.$/, '');
      if (!c) continue;
      const p = c.match(new RegExp(String.raw`^(.*?),?\s+who preferred to (raise|lower|maintain) the target range for the federal funds rate(?: by (${NUM}) percentage points?)?`));
      const names = (p ? p[1] : c).split(/,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
      groups.push({ n: names.length, action: p ? p[2] : null, by: p && p[3] ? fedNumber(p[3]) : null });
    }
    out.dissents = groups;
    const total = groups.reduce((s, g) => s + g.n, 0);
    if (out.vote && total !== out.vote.against) out.problems.push(`dissent names (${total}) do not match the vote (${out.vote.against} against)`);
  } else if (out.vote && out.vote.against > 0) out.problems.push('vote has dissents but no "Voting against" sentence');
  else out.dissents = [];
  return out;
}
const pts = (x) => x.toFixed(2);
function dissentText(g) {
  const who = `${WORDS[g.n] ?? g.n} dissent${g.n === 1 ? '' : 's'}`;
  if (g.action === 'raise') return `${who} preferred a ${g.by !== null ? `${pts(g.by)} point ` : ''}hike`;
  if (g.action === 'lower') return `${who} preferred a ${g.by !== null ? `${pts(g.by)} point ` : ''}cut`;
  if (g.action === 'maintain') return `${who} preferred no change`;
  return `${who} stated no preference`;
}
// Pure: the decision as message parts, or null when the decision sentence did not parse.
export function fomcSummary(p) {
  if (!p?.decision) return null;
  const range = `${pts(p.decision.lo)}–${pts(p.decision.hi)}%`;
  const headline = p.decision.action === 'maintain' ? `held at ${range}` : p.decision.action === 'raise' ? `raised to ${range}` : `lowered to ${range}`;
  const parts = [];
  if (!p.vote) parts.push('vote not parsed');
  else {
    parts.push(`vote ${p.vote.for}–${p.vote.against}`);
    if (p.vote.against > 0) {
      if (p.dissents && !p.problems.some((x) => /dissent/.test(x))) parts.push(...p.dissents.map(dissentText));
      else parts.push('dissents not parsed');
    }
  }
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  return { headline, detail: cap(parts.join(' · ')), line: `${cap(headline)} · ${parts.join(' · ')}` };
}
// Pure: the "Federal Reserve issues FOMC statement" item published on dateIso (ET), or null.
export function findFomcStatement(xml, dateIso) {
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const g = (tag) => decode(((m[1].match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?\\s*([\\s\\S]*?)\\s*(?:\\]\\]>)?\\s*</${tag}>`)) || [])[1] ?? '').trim());
    if (g('title') !== 'Federal Reserve issues FOMC statement') continue;
    const pub = Date.parse(g('pubDate'));
    if (!Number.isFinite(pub)) continue;
    const et = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(pub));
    const link = g('link');
    if (et === dateIso && /^https:\/\/www\.federalreserve\.gov\/[\w/.-]+\.htm$/.test(link)) return { link, pub };
  }
  return null;
}

// ---------------------------------------------------------------- BLS and BEA, pure
const prevMonth = (y, m) => (m === 1 ? [y - 1, 12] : [y, m - 1]);
// The month a release reports: the calendar's `ref` ("2026-09") when entered, else the month before the release.
export function refMonth(ev) {
  if (/^\d{4}-\d{2}$/.test(String(ev.ref ?? ''))) return ev.ref.split('-').map(Number);
  const [y, m] = ev.date.split('-').map(Number);
  return prevMonth(y, m);
}
const point = (series, y, m) => {
  const d = series?.data?.find((x) => x.year === String(y) && x.period === `M${String(m).padStart(2, '0')}`);
  const v = d ? Number(d.value) : NaN;
  return Number.isFinite(v) ? v : null;
};
// BLS computes percent changes from the published (3-decimal) index levels, rounded to one decimal.
const pctChange = (a, b) => (a !== null && b !== null && b !== 0 ? Math.round(((a / b) - 1) * 1000) / 10 : null);
const signed = (x, unit = '%') => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(1)}${unit}`;
export function blsFigure(kind, json, ev) {
  if (json?.status !== 'REQUEST_SUCCEEDED') return { status: 'error', why: `BLS answered ${json?.status ?? 'nothing'} ${(json?.message ?? []).join(' ').slice(0, 80)}`.trim() };
  const S = Object.fromEntries((json.Results?.series ?? []).map((s) => [s.seriesID, s]));
  const [y, m] = refMonth(ev), [py, pm] = prevMonth(y, m), mon = MONS[m - 1];
  if (kind === 'NFP') {
    const cur = point(S.CES0000000001, y, m), prev = point(S.CES0000000001, py, pm);
    if (cur === null || prev === null) return { status: 'pending', why: `${mon} payrolls not in BLS series CES0000000001 yet` };
    const ch = Math.round(cur - prev); // the series is a LEVEL in thousands; the headline is the CHANGE
    const ur = point(S.LNS14000000, y, m), urp = point(S.LNS14000000, py, pm);
    return { status: 'ok', source: 'bls.gov', headline: `${ch >= 0 ? '+' : '-'}${Math.abs(ch)}k jobs in ${mon} (first estimate)`,
      detail: ur !== null ? `Unemployment ${ur.toFixed(1)}%${urp !== null ? ` (prior ${urp.toFixed(1)}%)` : ''}` : 'Unemployment rate not in the BLS series yet' };
  }
  const [saId, nsaId] = BLS_SERIES[kind] ?? [];
  if (!saId) return { status: 'error', why: `no BLS series for ${kind}` };
  const mom = pctChange(point(S[saId], y, m), point(S[saId], py, pm));
  if (mom === null) return { status: 'pending', why: `${mon} not in BLS series ${saId} yet` };
  const yoy = pctChange(point(S[nsaId], y, m), point(S[nsaId], y - 1, m));
  const what = kind === 'PPI' ? 'final demand ' : '';
  return { status: 'ok', source: 'bls.gov',
    headline: `${what}${signed(mom)} in ${mon}${yoy !== null ? `, ${yoy.toFixed(1)}% over the year` : ''}`,
    detail: `Monthly change seasonally adjusted${yoy !== null ? ' · yearly change not seasonally adjusted' : ' · yearly change not in the series yet'}` };
}
// BEA NIPA table T20807: percent change from the preceding month in PCE prices, by line.
// Built against BEA's documented response shape (BEAAPI.Results.Data rows with LineDescription,
// TimePeriod "2026M09", DataValue); not yet exercised live, because no key exists yet.
export function beaPceFigure(json, ev) {
  const err = json?.BEAAPI?.Error ?? json?.BEAAPI?.Results?.Error;
  if (err) return { status: 'error', why: `BEA: ${String(err.APIErrorDescription ?? JSON.stringify(err)).slice(0, 80)}` };
  const rows = json?.BEAAPI?.Results?.Data;
  if (!Array.isArray(rows)) return { status: 'error', why: 'BEA answered without Data rows' };
  const [y, m] = refMonth(ev), tp = `${y}M${String(m).padStart(2, '0')}`, mon = MONS[m - 1];
  const pick = (rx) => rows.find((r) => r.TimePeriod === tp && rx.test(String(r.LineDescription ?? '').trim()));
  const val = (r) => { const n = Number(String(r?.DataValue ?? '').replace(/,/g, '')); return Number.isFinite(n) && String(r?.DataValue ?? '').trim() !== '' ? n : null; };
  const head = val(pick(/^Personal consumption expenditures(?: \(PCE\))?$/)), core = val(pick(/^PCE excluding food and energy$/));
  if (head === null) return { status: 'pending', why: `${mon} not in BEA table T20807 yet` };
  return { status: 'ok', source: 'bea.gov', headline: `prices ${signed(head)} in ${mon}`,
    detail: core !== null ? `Excluding food and energy ${signed(core)}` : 'Excluding food and energy: not in the table yet' };
}

// ---------------------------------------------------------------- fetches (edges injectable)
async function getText(fetchImpl, url) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
// deps: { fetchImpl, key (BEA), budget: { take() -> bool } for BLS }
export async function figureFor(ev, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    if (ev.kind === 'FOMC') {
      const item = findFomcStatement(await getText(fetchImpl, FED_FEED), ev.date);
      if (!item) return { status: 'pending', why: `no "Federal Reserve issues FOMC statement" item for ${ev.date} in the Fed feed yet` };
      const parsed = parseFomcStatement(await getText(fetchImpl, item.link));
      const s = fomcSummary(parsed);
      if (!s) return { status: 'unparsed', source: 'federalreserve.gov', link: item.link, why: parsed.problems.join('; ') };
      return { status: 'ok', source: 'federalreserve.gov', link: item.link, headline: s.headline, detail: s.detail, line: s.line, problems: parsed.problems };
    }
    if (BLS_SERIES[ev.kind]) {
      if (deps.budget && !deps.budget.take()) return { status: 'error', why: `BLS keyless budget (${BLS_DAILY_QUERIES} queries a day) used up` };
      const [y] = refMonth(ev);
      const r = await fetchImpl(BLS_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ seriesid: BLS_SERIES[ev.kind], startyear: String(y - 1), endyear: String(y) }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return blsFigure(ev.kind, await r.json(), ev);
    }
    if (ev.kind === 'PCE') {
      const key = deps.key ?? config.beaKey;
      if (!key) return { status: 'unavailable', why: 'no BEA_API_KEY in .env (free registration at apps.bea.gov/API/signup)' };
      const [y] = refMonth(ev);
      const r = await fetchImpl(`${BEA_API}?UserID=${encodeURIComponent(key)}&method=GetData&DataSetName=NIPA&TableName=T20807&Frequency=M&Year=${y}&ResultFormat=JSON`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); // the URL carries the key: it is never logged
      return beaPceFigure(await r.json(), ev);
    }
    return { status: 'unavailable', why: `no figure source for ${ev.kind}` };
  } catch (e) {
    return { status: 'error', why: `fetch failed: ${String(e.message).slice(0, 60)}` };
  }
}
// The heartbeat's line: which figures are fetched, from where, and why one is not.
export function macroFigureCoverage(cfg = config) {
  return { line: `Macro figures: CPI · NFP · PPI from api.bls.gov (keyless, ${BLS_DAILY_QUERIES}/day) · Fed decision from federalreserve.gov · PCE ${cfg.beaKey ? 'from apps.bea.gov' : '⚠️ not fetched: no BEA_API_KEY in .env (free key at apps.bea.gov/API/signup)'}` };
}
