// Collector liveness registry. A dead collector inside a live process is the failure
// mode funnel counts can't show: the process polls, the funnel fills from other
// sources, and one feed has silently been stale for a day. Every collector calls
// notePulse(name) after a SUCCESSFUL poll; the heartbeat prints the age of each.
// In-memory by design — ages reset at boot, and "since boot" is the honest answer
// right after a restart anyway.
const last = new Map();

export function notePulse(name, ts = Date.now()) { last.set(name, ts); } // ts injectable for staleness fixtures

export function pulseAges() {
  const now = Date.now();
  return [...last.entries()]
    .map(([name, ts]) => ({ name, ageSec: Math.round((now - ts) / 1000) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function formatPulse() {
  const ages = pulseAges();
  if (!ages.length) return 'no collector has succeeded yet this boot';
  const fmt = (s) => (s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
  return ages.map((a) => `${a.name} ${fmt(a.ageSec)}`).join(' · ');
}
