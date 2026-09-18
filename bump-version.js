// VERSION BUMP THAT ASKS EACH PREMISE WHAT IT CLAIMS. The 2026-09-13 blanket sed
// reached a parked patch and a brief that each made a different claim about the same
// version, and the collision was fixed by hand. A version string in a PREMISE is a
// claim: "Written against: v0.31.7" on a brief means the brief was reasoned against
// that tree and should NOT move; on README.md it means "this describes the live
// tree" and SHOULD. The doc says which by carrying `Tracks: live` in its PREMISE.
//
//   node bump-version.js 0.32.4        set the version; move only PREMISEs that track live
//   node bump-version.js --dry 0.32.4  report what would move, change nothing
//
// Only the FIRST PREMISE block of a file is considered (docs/briefs/README.md quotes
// other files' premises in its body). src/config.js and package.json must agree
// before and after; a bump to the current version aborts.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'data']);
export function walkDocs(dir, out = []) {
  for (const f of readdirSync(dir)) {
    if (SKIP.has(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walkDocs(p, out);
    else if (f.endsWith('.md')) out.push(p);
  }
  return out;
}
// Pure: given a file's text and the new version, return { text, action, from }.
export function bumpPremise(text, version) {
  const m = text.match(/<!--\s*PREMISE([\s\S]*?)-->/);
  if (!m) return { text, action: 'no-premise', from: null };
  const block = m[1];
  const wa = block.match(/Written against:\s*([^\n]*)/);
  const from = wa ? wa[1].trim() : null;
  if (!/^\s*Tracks:\s*live\s*$/m.test(block)) return { text, action: 'historical-claim', from };
  if (!wa) return { text, action: 'tracks-live-but-no-written-against', from };
  const newBlock = block.replace(/Written against:\s*[^\n]*/, `Written against: v${version}`);
  return { text: text.replace(m[0], `<!-- PREMISE${newBlock}-->`), action: from === `v${version}` ? 'already-current' : 'moved', from };
}
export function readVersions(root = '.') {
  const cfg = readFileSync(join(root, 'src/config.js'), 'utf8').match(/export const VERSION = '([^']+)';/);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return { config: cfg?.[1] ?? null, pkg: pkg.version ?? null };
}
export function bumpTree(root, version, { dry = false } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`bump: '${version}' is not a semver triple`);
  const v = readVersions(root);
  if (v.config !== v.pkg) throw new Error(`bump: src/config.js (${v.config}) and package.json (${v.pkg}) disagree — fix before bumping`);
  if (v.config === version) throw new Error(`bump: already at ${version}`);
  const report = { from: v.config, to: version, moved: [], left: [], noPremise: [] };
  if (!dry) {
    const cfgPath = join(root, 'src/config.js'), cfg = readFileSync(cfgPath, 'utf8');
    const cfgNew = cfg.replace(`export const VERSION = '${v.config}';`, `export const VERSION = '${version}';`);
    if (cfgNew === cfg) throw new Error('bump: config.js VERSION line not matched exactly once');
    writeFileSync(cfgPath, cfgNew);
    const pkgPath = join(root, 'package.json'), pkg = readFileSync(pkgPath, 'utf8');
    const pkgNew = pkg.replace(new RegExp(`"version":\\s*"${v.config.replace(/\./g, '\\.')}"`), `"version": "${version}"`);
    if (pkgNew === pkg) throw new Error('bump: package.json version not matched');
    writeFileSync(pkgPath, pkgNew);
  }
  for (const f of walkDocs(root)) {
    const text = readFileSync(f, 'utf8');
    const r = bumpPremise(text, version);
    const rel = f.slice(root.length).replace(/^[\\/]/, '');
    if (r.action === 'moved') { report.moved.push(`${rel} (${r.from} → v${version})`); if (!dry) writeFileSync(f, r.text); }
    else if (r.action === 'no-premise') report.noPremise.push(rel);
    else report.left.push(`${rel} [${r.action}: ${r.from ?? '—'}]`);
  }
  return report;
}

if (process.argv[1] && basename(process.argv[1]) === 'bump-version.js') {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const version = args.find((a) => !a.startsWith('--'));
  if (!version) { console.error('usage: node bump-version.js [--dry] X.Y.Z'); process.exit(1); }
  try {
    const r = bumpTree(process.cwd(), version, { dry });
    console.log(`${dry ? '[dry] ' : ''}${r.from} → ${r.to}`);
    console.log(`moved (Tracks: live): ${r.moved.length}`); r.moved.forEach((m) => console.log('  ' + m));
    console.log(`left as written (historical claims): ${r.left.length}`); r.left.forEach((m) => console.log('  ' + m));
    if (r.noPremise.length) console.log(`no PREMISE: ${r.noPremise.join(', ')}`);
  } catch (e) { console.error(`bump: ${e.message}`); process.exit(1); }
}
