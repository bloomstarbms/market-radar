// TAG VERIFIER — does each vX.Y.Z tag point at a tree that actually says X.Y.Z?
//
//   node verify-tags.js
//
// A tag pointing at the wrong tree is worse than no tag: checking out v0.31.1 hands
// you code that is not v0.31.1, and nothing announces it. That happened on
// 2026-09-07 — a crashed git left .git/index.lock, every commit since 6 Sep failed
// silently, and PUSH-TO-GITHUB.bat still tagged and reported success, so v0.31.1 on
// GitHub pointed at v0.31.0's commit. The push script now asserts its outcome; this
// asserts the tags, which the push script cannot (it only sees the tag it just made).
//
// Exit 1 if any tag disagrees with the src/config.js VERSION in its own tree.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
let bad = 0, checked = 0;
const tags = git('tag', '--sort=v:refname').split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
if (!tags.length) { console.error('[OPERATOR] verify-tags: no version tags found — nothing verified, which is not a pass.'); process.exit(1); }
for (const t of tags) {
  const expect = t.slice(1);
  let inTree = null;
  try { inTree = (git('show', `${t}:src/config.js`).match(/VERSION = '([^']+)'/) || [])[1] ?? null; } catch { /* tree has no config */ }
  checked++;
  if (inTree !== expect) { bad++; console.error(`  MISMATCH ${t} -> ${git('rev-list', '-n1', t).slice(0, 7)} whose src/config.js says ${inTree ?? '(no config.js)'}`); }
}
// THE CURRENT VERSION MUST HAVE A TAG. Since 2026-09-15 PUSH-TO-GITHUB.bat only tags
// when the version CHANGED, so a data-only push leaves HEAD untagged on purpose. The
// failure that guard could introduce is the opposite one: a bump that never gets
// tagged because the skip condition misfired. Checking each EXISTING tag cannot see
// a tag that was never made; this can.
let current = null;
try { current = (readFileSync('src/config.js', 'utf8').match(/VERSION = '([^']+)'/) || [])[1] ?? null; } catch { /* no config */ }
const currentTagged = current ? tags.includes(`v${current}`) : false;
if (current && !currentTagged) { bad++; console.error(`  MISSING  src/config.js says ${current} but there is no v${current} tag — a bump was pushed without being tagged`); }

console.log(bad
  ? `[OPERATOR] verify-tags: ${bad} problem(s) across ${checked} tags — see above`
  : `verify-tags: all ${checked} version tags point at a tree whose config.js matches, and v${current} is tagged.`);
process.exit(bad ? 1 : 0);
