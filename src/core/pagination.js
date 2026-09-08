// PAGINATION GUARD — one implementation of "have we paged far enough?", plus a boot
// assertion that every paginated reader uses it.
//
// WHY A SHARED GUARD. A cursor-paginated fetch that stops mid-day holds a PARTIAL
// sum for its OLDEST day. That is correct, and harmless ONLY while the boundary day
// stays strictly outside the window a caller scores. Probed 2026-09-07: 3 pages of
// the EIGEN wallet gave 150 transfers and 8 pages gave 400, differing on exactly the
// boundary day. Fixture 54 shows the consequence — the same day, half-counted, flips
// a cadence CONFIRM into a DEMOTE. So the comparison must be STRICT (`<`, never
// `<=`), and it must be strict in every reader, not in three of the four that
// happened to be listed when someone last looked.
//
// The first version of that fixture ENUMERATED the readers, which is the
// hardcoded-list shape this project has auto-discovered its way out of three times
// (doc premises, prose lint, classifier wiring). A fourth reader — discover-vesting
// — already existed and was not in the list. Hence: discovery by marker, guard by
// import, coverage asserted at boot.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from '../config.js';

// The marker of "this file walks a cursor-paginated feed". Blockscout's v2 API is
// the only such feed in the project; if another shape arrives, add its marker here
// and every existing reader keeps working.
export const PAGINATION_MARKERS = ['next_page_params'];
const GUARD_CALL = 'spanCovered(';
// The exemption NAMES ITS OWN FILE: `// PAGINATION-EXEMPT(discover-vesting.js): why`.
// A bare `PAGINATION-EXEMPT:` comment is portable, and a new reader started by
// copying an exempt one would inherit an exemption whose reason does not apply —
// silently, since the boot line would still say "1 declared exempt". Binding the tag
// to a filename makes the copy fail closed: the copied comment names the wrong file,
// the new reader counts as unguarded, and boot refuses.
const EXEMPT_RX = /PAGINATION-EXEMPT\(([^)]+)\):\s*(.+)/;
const SKIP = /(^|\/)(node_modules|data|fixtures|docs)(\/|$)|test-delivery\.js$|probe-pagination\.js$|property-test\.js$|regression-fixtures\.js$|replay-|acceptance-|src\/core\/pagination\.js$/;

// THE guard. `oldest` is the oldest day the fetch has reached, `target` the oldest
// day the caller will score. Strict: reaching the target day is NOT covering it,
// because the fetch may have stopped inside it.
export function spanCovered(oldest, target) {
  return !!oldest && !!target && oldest < target;
}

// `base` is the root the relative paths (and therefore the SKIP rules) are measured
// against. It was the module-level ROOT in the first version, so a scan of any other
// directory silently found nothing — and the self-test that was supposed to prove
// this check can go red went green for the wrong reason.
function walk(dir, base, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const rel = relative(base, p).replace(/\\/g, '/');
    if (SKIP.test(rel)) continue;
    if (statSync(p).isDirectory()) walk(p, base, out);
    else if (e.endsWith('.js')) out.push(rel);
  }
  return out;
}

// AUTO-DISCOVERY, not a list. Returns every file that walks a paginated feed, with
// whether it is guarded or explicitly exempt.
export function paginatedReaders(root = ROOT) {
  const found = [];
  for (const rel of walk(root, root)) {
    let src = '';
    try { src = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    if (!PAGINATION_MARKERS.some((m) => src.includes(m))) continue;
    const m = src.match(EXEMPT_RX);
    const base = rel.split('/').pop();
    const claimsFile = m ? m[1].trim() : null;
    const exempt = m && claimsFile === base ? (m[2].trim() || 'unstated') : null;
    found.push({ file: rel, guarded: src.includes(GUARD_CALL), exempt,
      ...(m && claimsFile !== base ? { staleExemption: claimsFile } : {}) });
  }
  return found;
}

// Boot assertion. A new paginated reader either calls the guard or declares, in the
// file, why the boundary day cannot reach a scored window. Silence is refused.
export function checkPaginationGuards(root = ROOT) {
  const readers = paginatedReaders(root);
  const problems = [];
  if (!readers.length) problems.push('no paginated readers discovered — the marker moved and this check is now vacuous');
  for (const r of readers) {
    if (r.guarded || r.exempt) continue;
    problems.push(r.staleExemption
      ? `${r.file} carries an exemption written for ${r.staleExemption} — a copied comment, not a decision about this file; it must call spanCovered() or state its own reason`
      : `${r.file} walks a paginated feed but neither calls spanCovered() nor declares "// PAGINATION-EXEMPT(${r.file.split('/').pop()}): <why>" — its truncation boundary could land inside a scored window`);
  }
  return { ok: problems.length === 0, problems, readers };
}
