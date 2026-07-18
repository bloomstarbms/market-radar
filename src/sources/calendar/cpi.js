// US CPI release alerts: T-24h reminder, T-1h warning, and the actual number
// minutes after release (BLS public API, no key needed).
// Schedule source: bls.gov/schedule/news_release/cpi.htm — refresh yearly.
import { dispatch } from '../../core/dispatcher.js';

// Release moments in UTC (8:30 AM ET; EDT until Nov, then EST). refMonth = data month.
const SCHEDULE = [
  { utc: '2026-08-12T12:30:00Z', refMonth: 'July',      period: 'M07', year: '2026' },
  { utc: '2026-09-11T12:30:00Z', refMonth: 'August',    period: 'M08', year: '2026' },
  { utc: '2026-10-14T12:30:00Z', refMonth: 'September', period: 'M09', year: '2026' },
  { utc: '2026-11-10T13:30:00Z', refMonth: 'October',   period: 'M10', year: '2026' },
  { utc: '2026-12-10T13:30:00Z', refMonth: 'November',  period: 'M11', year: '2026' },
];

let lastFetchAttempt = 0;

export async function pollCpi() {
  const now = Date.now();
  for (const rel of SCHEDULE) {
    const t = Date.parse(rel.utc);
    const dateKey = rel.utc.slice(0, 10);

    // T-24h reminder
    if (now >= t - 24 * 3600e3 && now < t - 20 * 3600e3) {
      await dispatch({
        source: 'CAL', type: 'CPI', severity: 'MEDIUM', key: `${dateKey}:24h`, cooldownMin: 2880,
        title: `US CPI (${rel.refMonth}) releases tomorrow`,
        lines: [`Release: ${rel.utc.replace('T', ' ').replace(':00Z', ' UTC')} (8:30 AM ET)`,
          `Expect volatility around the print — crypto often moves with the surprise, not the number`],
      });
    }
    // T-1h warning
    if (now >= t - 3600e3 && now < t) {
      await dispatch({
        source: 'CAL', type: 'CPI', severity: 'HIGH', key: `${dateKey}:1h`, cooldownMin: 2880,
        title: `US CPI (${rel.refMonth}) in under 1 hour`,
        lines: [`High-volatility window opening. Leverage is how accounts die on CPI days.`],
      });
    }
    // Post-release: fetch the actual number (retry every 5 min, up to 12h)
    if (now >= t && now < t + 12 * 3600e3 && now - lastFetchAttempt > 5 * 60e3) {
      lastFetchAttempt = now;
      const nums = await fetchCpiNumbers(rel).catch(() => null);
      if (nums) {
        await dispatch({
          source: 'CAL', type: 'CPI', severity: 'HIGH', key: `${dateKey}:result`, cooldownMin: 2880,
          title: `US CPI ${rel.refMonth}: ${nums.yoy}% YoY · ${nums.mom}% MoM`,
          lines: [
            `Headline CPI YoY: ${nums.yoy}% · MoM (seasonally adj): ${nums.mom}%`,
            `Watch BTC/majors for the reaction over the next hours`,
          ],
        });
      }
    }
  }
}

async function fetchCpiNumbers(rel) {
  const res = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seriesid: ['CUSR0000SA0', 'CUUR0000SA0'], startyear: String(Number(rel.year) - 1), endyear: rel.year }),
  });
  const j = await res.json();
  if (j.status !== 'REQUEST_SUCCEEDED') return null;
  const sa = j.Results.series.find((s) => s.seriesID === 'CUSR0000SA0')?.data || [];
  const nsa = j.Results.series.find((s) => s.seriesID === 'CUUR0000SA0')?.data || [];
  const cur = sa.find((d) => d.year === rel.year && d.period === rel.period);
  if (!cur) return null; // not published yet
  const prevM = rel.period === 'M01' ? 'M12' : 'M' + String(Number(rel.period.slice(1)) - 1).padStart(2, '0');
  const prevY = rel.period === 'M01' ? String(Number(rel.year) - 1) : rel.year;
  const prev = sa.find((d) => d.year === prevY && d.period === prevM);
  const curN = nsa.find((d) => d.year === rel.year && d.period === rel.period);
  const yearAgo = nsa.find((d) => d.year === String(Number(rel.year) - 1) && d.period === rel.period);
  if (!prev || !curN || !yearAgo) return null;
  return {
    mom: (100 * (cur.value - prev.value) / prev.value).toFixed(2),
    yoy: (100 * (curN.value - yearAgo.value) / yearAgo.value).toFixed(1),
  };
}
export { SCHEDULE };
