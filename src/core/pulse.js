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

// ABSENCE OF OBSERVATION ISN'T OBSERVATION OF ABSENCE — the named class behind the
// cadence-watch windowObserved() gate, generalized. A zero count ("no unclassified
// shapes", "no exclusions", "no unlock outflow") is only evidence when the feed that
// would have produced nonzero was actually looking. Every "nothing happened" signal
// needs an "and we were looking" companion; this is that companion for pulse-tracked
// feeds. Pure when ages are injected.
export function feedWasLooking(nameRx, maxAgeSec = 6 * 3600, ages = pulseAges()) {
  return ages.some((a) => nameRx.test(a.name) && a.ageSec <= maxAgeSec);
}

export function formatPulse() {
  const ages = pulseAges();
  if (!ages.length) return 'no collector has succeeded yet this boot';
  const fmt = (s) => (s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
  return ages.map((a) => `${a.name} ${fmt(a.ageSec)}`).join(' · ');
}
