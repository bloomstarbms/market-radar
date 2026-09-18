// ONE LAG-DISCLOSURE RULE, several call sites. macro.js's T+5m/T+30m follow-ups
// disclose when delivery ran late; the alert footer discloses when the data behind a
// message is older than a reader would assume. Same threshold, same ⏱ marker, same
// shape: silent when there is nothing to disclose, explicit when there is. Two
// parallel rules would drift apart — the message diet found the footer restating
// "≤60s" on every message and macro doing the right thing three files away.
// Thresholds are declared per call site — macro's follow-ups are due at a mark and
// disclose past 5 minutes; an alert's data is assumed live and discloses past 120s —
// but the rule (silent under, ⏱ over, minutes stated) is this one function.
export const LAG_DISCLOSE_MIN = 5;          // macro follow-ups: minutes past the T+5m/T+30m mark
export const DATA_AGE_DISCLOSE_SEC = 120;   // alert footer: seconds a reader still calls "now"
export function lagDisclosure(lagMs, what, thresholdMs = LAG_DISCLOSE_MIN * 60e3) {
  if (!(lagMs > thresholdMs)) return null;
  return `⏱ ${what(Math.max(1, Math.round(lagMs / 60e3)))}`;
}
