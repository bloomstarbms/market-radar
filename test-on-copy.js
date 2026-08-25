// Structural test/production separation. The v0.17.3 incident: a smoke test wrote
// data/outcomes.json while the live bot saved — torn file, crash loop. The guard
// made that loud; THIS stops it existing. Any test needing outcomes data imports
// withDataCopy and gets a throwaway copy under data/tmp-test/. Writing to real
// data/ paths from a test is a review-rejectable offence.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
export function withDataCopy(file = 'data/outcomes.json') {
  mkdirSync('data/tmp-test', { recursive: true });
  const copy = 'data/tmp-test/' + file.split('/').pop();
  if (existsSync(file)) copyFileSync(file, copy);
  return copy;
}
